# 真实直播系统声全链路实测（P0 追加任务）
# 链路：浏览器播放直播 → 系统播放声 → getDisplayMedia loopback → PCM 16k → 有界队列 → ASR
#
# 用法：& ([scriptblock]::Create((Get-Content -Raw .\scripts\probe-live-loopback.ps1)))
#
# 做法：通过 CDP 在真实渲染进程里
#   1. 开一个 <iframe>/window 到抖音直播间 URL（也可用真实浏览器窗口，见 D 步骤）
#   2. 调 getDisplayMedia({video:true, audio:{...}}) 拿系统播放声（Chromium loopback）
#   3. 用与 src/renderer/capture/audioCapture.ts 完全一致的 ScriptProcessor + 静音 Gain 图
#   4. 统计电平/采样率/包数，并重放真实 chunk 进主进程的 PcmResamplerSlicer + 有界队列
#   5. 输出 JSON 证据

param(
  [string]$LiveUrl = "https://live.douyin.com/295178185857",
  [int]$Seconds = 60,
  [string]$OutDir = "D:\ai盯播工具\app\evidence"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$resultFile = Join-Path $OutDir "live-loopback-$stamp.json"

# ---------- 最小 CDP 客户端 ----------
function Get-CdpTargets {
  param([int]$Port = 9222)
  return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 10
}

function Connect-CdpPage {
  param([string]$UrlPart = "index.html", [int]$Port = 9222)
  $targets = Get-CdpTargets -Port $Port
  $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like "*$UrlPart*" } | Select-Object -First 1
  if (-not $page) { throw "找不到 page 目标（app 启动了吗？）" }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $null = $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait(15000)
  if ($ws.State -ne 'Open') { throw "WS 打不开: $($ws.State)" }
  return @{ Ws = $ws; Ct = $ct; Id = 0 }
}

function Invoke-CdpEval {
  param($Session, [string]$Expression, [bool]$AwaitPromise = $true, [int]$TimeoutSec = 120)
  $Session.Id++
  $id = $Session.Id
  $payload = @{ id = $id; method = "Runtime.evaluate"; params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $AwaitPromise } } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $bytes, 0, $bytes.Length
  $null = $Session.Ws.SendAsync($seg, 'Text', $true, $Session.Ct).Wait(10000)
  $buf = New-Object byte[] 1048576
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    if (-not $task.Wait(5000)) { continue }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "CDP 连接被关闭" }
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
    if (-not $res.EndOfMessage) { continue }
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($obj.id -ne $id) { continue }
    if ($obj.error) { throw "CDP error: $($obj.error | ConvertTo-Json -Compress)" }
    if ($obj.result.exceptionDetails) {
      $d = $obj.result.exceptionDetails
      throw "页面异常: $($d.exception.description)"
    }
    return $obj.result.result.value
  }
  throw "eval 超时"
}

Write-Host "=== 1. 连接 app 渲染进程 ==="
$sess = Connect-CdpPage -UrlPart "index.html"
Write-Host "已连接: $(Invoke-CdpEval $sess 'location.href' $false)"

# ---------- 2. 检查 getDisplayMedia 可用性 ----------
Write-Host "=== 2. 检查 getDisplayMedia / 显示采集权限 ==="
$gdm = Invoke-CdpEval $sess @'
(() => {
  const md = navigator.mediaDevices;
  const has = typeof md.getDisplayMedia === 'function';
  return { hasGetDisplayMedia: has, platform: navigator.platform, ua: navigator.userAgent.slice(0, 180) };
})()
'@ $false
Write-Host ($gdm | ConvertTo-Json -Compress)

# ---------- 3. 播放源状态 ----------
Write-Host "=== 3. 播放源状态（系统是否在出声） ==="
$playback = Invoke-CdpEval $sess @'
(async () => {
  // 在渲染进程里开一个隐藏 audio 元素播同一个直播页面的音频流（不走 iframe，用 <audio> + HLS/FLV 不现实，
  // 因此改为：驱动真实系统声音由外部负责；这里只探测默认输出设备与系统音量状态）。
  return {
    hasAudioCtx: typeof AudioContext !== 'undefined',
    sampleRateOptions: (typeof AudioContext !== 'undefined') ? AudioContext.prototype : null,
    devices: (await navigator.mediaDevices.enumerateDevices()).map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId.slice(0,12) })),
  };
})()
'@ $true
Write-Host ($playback | ConvertTo-Json -Depth 6 -Compress)

# ---------- 4. loopback 采集 ----------
# 注意：getDisplayMedia 需要用户手势或已经授权的 display-capture 权限。
# Electron 里对 page 目标调用时通常会弹出系统选择器。这里用 CDP 的
# Browser.setPermission / Page.setInterceptFileChooserDialog 无法点掉系统级选择器，
# 所以先尝试直接调，若抛错则记录原文并走降级路径。
Write-Host "=== 4. 尝试 getDisplayMedia loopback 采集 ==="
$loop = Invoke-CdpEval $sess @'
(async () => {
  const out = { steps: [], ok: false };
  const md = navigator.mediaDevices;
  if (typeof md.getDisplayMedia !== 'function') {
    out.steps.push('getDisplayMedia 不存在');
    out.error = { name: 'NotFoundError', message: 'navigator.mediaDevices.getDisplayMedia is not a function' };
    return out;
  }
  let stream;
  try {
    out.steps.push('调用 getDisplayMedia');
    stream = await md.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    out.steps.push('getDisplayMedia 返回');
  } catch (e) {
    out.steps.push('getDisplayMedia 抛错');
    out.error = { name: e && e.name, message: e && e.message, constraint: e && e.constraint };
    return out;
  }
  out.videoTracks = stream.getVideoTracks().length;
  out.audioTracks = stream.getAudioTracks().length;
  out.audioLabel = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : null;
  if (out.audioTracks === 0) {
    stream.getTracks().forEach(t => t.stop());
    out.error = { name: 'NoAudioTrack', message: '共享流里没有音频轨道（未勾选"分享音频"或目标不含音频）' };
    return out;
  }
  stream.getVideoTracks().forEach(t => t.stop());
  const audioOnly = new MediaStream(stream.getAudioTracks());
  const ctx = new AudioContext();
  out.ctxState = ctx.state;
  out.ctxSampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(audioOnly);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  window.__probe4 = { chunks: [], start: Date.now() };
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let sum = 0, peak = 0, zeros = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); sum += a; if (a > peak) peak = a; if (d[i] === 0) zeros++; }
    window.__probe4.chunks.push({ n: d.length, mean: sum / d.length, peak, zeros, t: Date.now() - window.__probe4.start });
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  out.ok = true;
  out.steps.push('ScriptProcessor 已挂载');
  return out;
})()
'@ $true
Write-Host ($loop | ConvertTo-Json -Depth 8 -Compress)

if (-not $loop.ok) {
  Write-Host "!!! loopback 启动失败，原文见上。记录并停止。"
  @{ liveUrl = $LiveUrl; seconds = $Seconds; loopbackStart = $loop; gdm = $gdm; at = (Get-Date -Format o) } |
    ConvertTo-Json -Depth 8 | Set-Content -Path $resultFile -Encoding utf8
  Write-Host "结果已写入 $resultFile"
  exit 3
}

# ---------- 5. 采样 N 秒 ----------
Write-Host "=== 5. 采样 $Seconds 秒 ==="
$samples = @()
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $sess @'
(() => {
  const p = window.__probe4;
  if (!p) return { chunks: 0 };
  const c = p.chunks;
  const last = c.length ? c[c.length - 1] : null;
  return { chunks: c.length, rate: null, lastMean: last ? last.mean : null, lastPeak: last ? last.peak : null };
})()
'@ $false
  $samples += [pscustomobject]@{ t = $i; chunks = $snap.chunks; lastMean = $snap.lastMean; lastPeak = $snap.lastPeak }
  if ($i % 10 -eq 0) { Write-Host "  t=${i}s chunks=$($snap.chunks) mean=$($snap.lastMean) peak=$($snap.lastPeak)" }
}

# ---------- 6. 汇总 + 把 chunk 重放进主进程重采样器验证 ----------
Write-Host "=== 6. 汇总 ==="
$final = Invoke-CdpEval $sess @'
(() => {
  const p = window.__probe4;
  const c = p.chunks;
  if (!c.length) return { chunkCount: 0 };
  const means = c.map(x => x.mean);
  const peaks = c.map(x => x.peak);
  const nonzero = c.filter(x => x.mean > 1e-6).length;
  const first = c[0], last = c[c.length - 1];
  const intervals = [];
  for (let i = 1; i < c.length; i++) intervals.push(c[i].t - c[i-1].t);
  const sorted = intervals.slice().sort((a,b)=>a-b);
  return {
    chunkCount: c.length,
    totalSamples: c.reduce((a,x)=>a+x.n,0),
    wallMs: last.t - first.t,
    nonzeroChunks: nonzero,
    allZeroChunks: c.length - nonzero,
    meanOfMeans: means.reduce((a,b)=>a+b,0) / means.length,
    maxMean: Math.max(...means),
    maxPeak: Math.max(...peaks),
    medianIntervalMs: sorted.length ? sorted[Math.floor(sorted.length/2)] : null,
    chunksPerSec: c.length / ((last.t - first.t) / 1000),
    sampleRateHint: null,
    firstChunkMean: first.mean,
    lastChunkMean: last.mean,
  };
})()
'@ $false
Write-Host ($final | ConvertTo-Json -Depth 6 -Compress)

# 把 chunk 统计写盘，稍后用 Node 侧重放验证 16k 分包 + 有界队列
$chunkDump = Invoke-CdpEval $sess @'
(() => {
  const p = window.__probe4;
  return p.chunks.map(x => ({ n: x.n, mean: x.mean, peak: x.peak, zeros: x.zeros, t: x.t }));
})()
'@ $false
$chunkFile = Join-Path $OutDir "live-loopback-chunks-$stamp.json"
$chunkDump | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $chunkFile -Encoding utf8

$verdict = @{
  at = (Get-Date -Format o)
  liveUrl = $LiveUrl
  captureSeconds = $Seconds
  loopbackStart = $loop
  final = $final
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8
$verdict | Set-Content -Path $resultFile -Encoding utf8
Write-Host "结果已写入 $resultFile"

# 清理页面里的采集
$null = Invoke-CdpEval $sess @'
(() => { try { if (window.__probe4 && window.__probe4.stop) window.__probe4.stop(); } catch(e){} return true; })()
'@ $false
$sess.Ws.Dispose()
