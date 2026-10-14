# 通用 CDP 驱动模块。JS 代码统一放在本文件末尾的 here-string 里，
# 通过 ScriptBlock 传输。注意：本文件是 UTF-8，调用方必须以 UTF8 读取，
# 否则中文字符串会变 GBK 乱码从而破坏 JS。
# 用法：. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PSScriptRoot\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

$ErrorActionPreference = "Stop"
$script:CdpPort = 9222

function script:Connect-CdpPage {
  param([string]$UrlPart = "index.html", [int]$Port = 9222)
  $script:CdpPort = $Port
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 10
  $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like "*$UrlPart*" } | Select-Object -First 1
  if (-not $page) {
    $known = ($targets | ForEach-Object { "$($_.type):$($_.url)" }) -join "; "
    throw "找不到 page 目标。现有目标: $known"
  }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  $null = $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).Wait(15000)
  if ($ws.State -ne 'Open') { throw "WebSocket 未打开: $($ws.State)" }
  $s = @{ Ws = $ws; Ct = $ct; Id = 0; Page = $page.url }
  $null = Invoke-CdpEval $s "1" $false 5
  return $s
}

function script:Invoke-CdpEval {
  param($Session, [string]$Expression, [bool]$AwaitPromise = $true, [int]$TimeoutSec = 120)
  # 2026-10-14：main 的 setDisplayMediaRequestHandler 会校验 request.userGesture。
  # CDP 的 Runtime.evaluate 有一个 userGesture 参数，显式把「用户手势」授予被求值的
  # 表达式——否则合成调用会被 handler 拒绝（AbortError: Error starting capture）。
  # 必须显式传 true，不能靠页面里 document.querySelector().click() 顶替。
  return Invoke-CdpEvalUg $Session $Expression $AwaitPromise $TimeoutSec $true
}

function script:Invoke-CdpEvalUg {
  param($Session, [string]$Expression, [bool]$AwaitPromise = $true, [int]$TimeoutSec = 120, [bool]$UserGesture = $false)
  $Session.Id++
  $id = $Session.Id
  $req = @{ id = $id; method = "Runtime.evaluate"; params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $AwaitPromise; userGesture = $UserGesture } }
  $payload = $req | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $bytes, 0, $bytes.Length
  $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(20000)
  $buf = New-Object byte[] 4194304
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $sb = New-Object System.Text.StringBuilder
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    try {
      if (-not $task.Wait(4000)) { continue }
    } catch {
      # 渲染进程重建 target 时 ReceiveAsync 可能抛 AggregateException；尽力重连一次
      Start-Sleep -Milliseconds 800
      continue
    }
    if ($task.IsFaulted -or $task.IsCanceled) { Start-Sleep -Millisecond 800; continue }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "CDP 连接被关闭" }
    $null = $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    if (-not $res.EndOfMessage) { continue }
    $text = $sb.ToString()
    $sb.Clear() | Out-Null
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($null -eq $obj.id -or $obj.id -ne $id) { continue }
    if ($obj.error) { throw "CDP error: $($obj.error | ConvertTo-Json -Compress -Depth 5)" }
    if ($obj.result.exceptionDetails) {
      $d = $obj.result.exceptionDetails
      $desc = $d.exception.description
      throw "页面异常: $desc"
    }
    return $obj.result.result.value
  }
  throw "eval 超时 (${TimeoutSec}s): $($Expression.Substring(0, [Math]::Min(80, $Expression.Length)))"
}

function script:Close-Cdp {
  param($Session)
  try { $Session.Ws.Dispose() } catch { }
}

function script:Reconnect-Cdp {
  # 渲染进程可能重建 page target（getDisplayMedia 触发时见过 target id 变化）。
  # 这里不主动断开旧连接，只返回一个指向最新 page 的新 Session。
  param([string]$UrlPart = "index.html", [int]$Port = 9222)
  try { return Connect-CdpPage -UrlPart $UrlPart -Port $Port } catch { return $null }
}

# 页面里预装观测探针：拦截 sendAudioChunk 统计每个 Float32 chunk。
$script:JS_INSTALL_PROBE = @'
(() => {
  window.__live = { chunks: [], errors: [], start: Date.now(), trackEnded: false };
  const orig = window.appApi.sendAudioChunk;
  if (!orig) { window.__live.errors.push("appApi.sendAudioChunk missing"); return false; }
  window.appApi.sendAudioChunk = (f32, rate) => {
    const p = window.__live;
    let sum = 0, peak = 0, zeros = 0, nan = 0, clip = 0;
    for (let i = 0; i < f32.length; i++) {
      const v = f32[i];
      if (typeof v !== "number" || isNaN(v)) { nan++; continue; }
      const a = Math.abs(v);
      sum += a; if (a > peak) peak = a;
      if (v === 0) zeros++;
      if (a >= 0.999) clip++;
    }
    p.chunks.push({ n: f32.length, rate: rate, mean: sum / f32.length, peak: peak, zeros: zeros, nan: nan, clip: clip, t: Date.now() - p.start });
    p.sampleRate = rate;
    return orig(f32, rate);
  };
  return true;
})()
'@

$script:JS_PROBE_SNAP = @'
(() => {
  const p = window.__live;
  if (!p) return { chunks: 0, probeMissing: true };
  const c = p.chunks;
  const last = c.length ? c[c.length - 1] : null;
  return { chunks: c.length, rate: p.sampleRate, lastMean: last ? last.mean : null, lastPeak: last ? last.peak : null, errors: p.errors.slice() };
})()
'@

$script:JS_PROBE_FINAL = @'
(() => {
  const p = window.__live;
  const c = p ? p.chunks : [];
  if (!c.length) return { chunkCount: 0, errors: p ? p.errors : ["probe missing"] };
  const nz = c.filter(x => x.mean > 1e-9).length;
  const intervals = [];
  for (let i = 1; i < c.length; i++) intervals.push(c[i].t - c[i - 1].t);
  const sorted = intervals.slice().sort((a, b) => a - b);
  const callouts = Array.from(document.querySelectorAll(".callout, .callout-danger, .callout-warn")).map(e => e.textContent.trim());
  return {
    chunkCount: c.length,
    totalSamples: c.reduce((a, x) => a + x.n, 0),
    wallMs: c[c.length - 1].t - c[0].t,
    nonzeroChunks: nz,
    allZeroMeanChunks: c.length - nz,
    fullyZeroChunks: c.filter(x => x.zeros === x.n).length,
    meanOfMeans: c.reduce((a, x) => a + x.mean, 0) / c.length,
    maxMean: Math.max.apply(null, c.map(x => x.mean)),
    maxPeak: Math.max.apply(null, c.map(x => x.peak)),
    minPeak: Math.min.apply(null, c.map(x => x.peak)),
    medianIntervalMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    chunksPerSec: c.length / Math.max(0.001, (c[c.length - 1].t - c[0].t) / 1000),
    sampleRates: Array.from(new Set(c.map(x => x.rate))),
    anyNan: c.some(x => x.nan > 0),
    anyClipped: c.some(x => x.clip > 0),
    totalNan: c.reduce((a, x) => a + x.nan, 0),
    totalClip: c.reduce((a, x) => a + x.clip, 0),
    errors: p.errors,
    callouts: callouts,
    pageHead: document.body.innerText.slice(0, 300)
  };
})()
'@

$script:JS_DUMP_CHUNKS_LIVE = @'
(() => {
  const p = window.__live;
  if (!p) return [];
  return p.chunks.map(x => ({ n: x.n, rate: x.rate, mean: x.mean, peak: x.peak, zeros: x.zeros, clip: x.clip, nan: x.nan, t: x.t }));
})()
'@

$script:JS_UI_SUBTITLES = @'
(() => {
  const txt = document.body.innerText;
  // 稳态片段数是 UI 汇总指标；字幕文本在实时字幕区
  const finalMatch = txt.match(/稳态片段数\s*(\d+)/);
  const finalCount = finalMatch ? Number(finalMatch[1]) : 0;
  // 抓所有字幕行：稳态与临时的 class 名未知，用文本特征兜底
  const rows = Array.from(document.querySelectorAll("div,li,p,span"))
    .map(e => e.textContent.trim())
    .filter(t => t && t.length >= 2 && t.length <= 80)
    .filter(t => !/^(实时字幕|暂无字幕|指标|监听时长|稳态片段数|问题数|最近分析|有效讲话|分析倒计时|话术步骤覆盖|开始|结束|暂停|继续|查看|实时监控|话术配置|分析设置|历史与报告|MVP|数据不出本机|记录保存|音频与转写|已完成|会话|开始于|音源|默认麦克风|电平|采集|未启动|未连接|最后稳态|—|未开始)/.test(t));
  const timer = (txt.match(/监听时长\s*([0-9:]+)/) || [])[1] || null;
  const session = (txt.match(/会话\s*([0-9a-zA-Z]+)/) || [])[1] || null;
  const asrChip = (() => {
    const chips = Array.from(document.querySelectorAll(".chip"));
    const c = chips.find(x => /ASR/.test(x.textContent));
    return c ? c.textContent.trim() : null;
  })();
  const segChip = (() => {
    const chips = Array.from(document.querySelectorAll(".chip"));
    const c = chips.find(x => /最后稳态/.test(x.textContent));
    return c ? c.textContent.trim() : null;
  })();
  const callouts = Array.from(document.querySelectorAll(".callout,.callout-danger,.callout-warn")).map(e => e.textContent.trim().slice(0, 100));
  return {
    finalCount: finalCount,
    partialCount: 0,
    timer: timer,
    sessionId: session,
    asrChip: asrChip,
    lastFinalChip: segChip,
    callouts: callouts,
    subtitleCandidates: rows.slice(0, 20),
    lastFinalText: rows.length ? rows[rows.length - 1] : null
  };
})()
'@

# ============ 采集脚本（JS 原样存放，不做 PS 解析） ============

$script:JS_CHECK_GDM = @'
(() => {
  const md = navigator.mediaDevices;
  const has = typeof md.getDisplayMedia === "function";
  return {
    hasGetDisplayMedia: has,
    hasGetUserMedia: typeof md.getUserMedia === "function",
    platform: navigator.platform,
    ua: navigator.userAgent
  };
})()
'@

$script:JS_START_LOOPBACK = @'
(async () => {
  const out = { steps: [] };
  window.__probe = { chunks: [], errors: [], start: Date.now() };
  const md = navigator.mediaDevices;
  if (typeof md.getDisplayMedia !== "function") {
    out.error = { name: "NotFoundError", message: "navigator.mediaDevices.getDisplayMedia is not a function" };
    return out;
  }
  out.steps.push("before getDisplayMedia");
  let stream;
  try {
    stream = await md.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    out.steps.push("getDisplayMedia resolved");
  } catch (e) {
    out.error = { name: e && e.name, message: e && e.message };
    out.steps.push("getDisplayMedia threw: " + (e && e.name));
    return out;
  }
  out.videoTracks = stream.getVideoTracks().length;
  out.audioTracks = stream.getAudioTracks().length;
  out.audioLabel = stream.getAudioTracks().length ? stream.getAudioTracks()[0].label : null;
  if (out.audioTracks === 0) {
    stream.getTracks().forEach(t => t.stop());
    out.error = { name: "NoAudioTrack", message: "shared stream has no audio track" };
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
  let n = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let sum = 0, peak = 0, zeros = 0, clip = 0, nan = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (typeof v !== "number" || isNaN(v)) { nan++; continue; }
      const a = Math.abs(v);
      sum += a;
      if (a > peak) peak = a;
      if (v === 0) zeros++;
      if (a >= 0.999) clip++;
    }
    const p = window.__probe;
    p.chunks.push({ idx: n++, sampleRate: ctx.sampleRate, n: d.length, mean: sum / d.length, peak: peak, zeros: zeros, clip: clip, nan: nan, t: Date.now() - p.start });
    p.sampleRate = ctx.sampleRate;
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  window.__probe.stop = () => {
    try { proc.onaudioprocess = null; proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    audioOnly.getTracks().forEach(t => t.stop());
  };
  out.ok = true;
  return out;
})()
'@

$script:JS_SNAPSHOT = @'
(() => {
  const p = window.__probe;
  if (!p) return { chunks: 0 };
  const c = p.chunks;
  const last = c.length ? c[c.length - 1] : null;
  return {
    chunks: c.length,
    sampleRate: p.sampleRate,
    lastMean: last ? last.mean : null,
    lastPeak: last ? last.peak : null
  };
})()
'@

$script:JS_FINAL = @'
(() => {
  const p = window.__probe;
  const c = p.chunks;
  if (!c.length) return { chunkCount: 0, hasProbe: !!p, errors: p ? p.errors : [] };
  const nonzero = c.filter(x => x.mean > 0.000001).length;
  const first = c[0], last = c[c.length - 1];
  const intervals = [];
  for (let i = 1; i < c.length; i++) intervals.push(c[i].t - c[i - 1].t);
  const sorted = intervals.slice().sort((a, b) => a - b);
  return {
    chunkCount: c.length,
    totalSamples: c.reduce((a, x) => a + x.n, 0),
    wallMs: last.t - first.t,
    nonzeroChunks: nonzero,
    allZeroChunks: c.length - nonzero,
    meanOfMeans: c.reduce((a, x) => a + x.mean, 0) / c.length,
    maxMean: Math.max.apply(null, c.map(x => x.mean)),
    maxPeak: Math.max.apply(null, c.map(x => x.peak)),
    medianIntervalMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    chunksPerSec: c.length / Math.max(0.001, (last.t - first.t) / 1000),
    sampleRate: p.sampleRate,
    anyNan: c.some(x => x.nan > 0),
    anyClipped: c.some(x => x.clip > 0),
    fullyZeroChunks: c.filter(x => x.zeros === x.n).length,
    firstChunkMean: first.mean,
    lastChunkMean: last.mean,
    errors: p.errors
  };
})()
'@

$script:JS_DUMP_CHUNKS = @'
(() => {
  const p = window.__probe;
  return p.chunks.map(x => ({ idx: x.idx, sampleRate: x.sampleRate, n: x.n, mean: x.mean, peak: x.peak, zeros: x.zeros, clip: x.clip, nan: x.nan, t: x.t }));
})()
'@

$script:JS_STOP = @'
(() => { try { window.__probe && window.__probe.stop && window.__probe.stop(); } catch (e) {} return true; })()
'@

# 单次表达式内完成「getDisplayMedia → ScriptProcessor → sendAudioChunk」全链路。
# 必须在同一次 Runtime.evaluate 里做完，因为 userGesture:true 只对当次表达式有效；
# 拆成两步（先 click 再采）会让后续微任务拿不到手势 → AbortError。
# 接线图与 src/renderer/capture/audioCapture.ts 的 wireStream 一致。
$script:JS_START_LOOPBACK_LIVE = @'
(async () => {
  const out = { steps: [] };
  const md = navigator.mediaDevices;
  if (typeof md.getDisplayMedia !== "function") {
    out.error = { name: "NotFoundError", message: "getDisplayMedia is not a function" };
    return out;
  }
  window.__live = { chunks: [], errors: [], start: Date.now(), sampleRate: null };
  const p = window.__live;
  let stream;
  try {
    out.steps.push("getDisplayMedia");
    stream = await md.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    out.steps.push("resolved");
  } catch (e) {
    out.error = { name: e && e.name, message: e && e.message };
    out.steps.push("threw " + (e && e.name));
    return out;
  }
  out.videoTracks = stream.getVideoTracks().length;
  out.audioTracks = stream.getAudioTracks().length;
  out.audioLabel = stream.getAudioTracks().length ? stream.getAudioTracks()[0].label : null;
  if (out.audioTracks === 0) {
    stream.getTracks().forEach(t => t.stop());
    out.error = { name: "NoAudioTrack", message: "no audio track" };
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
  let n = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let sum = 0, peak = 0, zeros = 0, nan = 0, clip = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (typeof v !== "number" || isNaN(v)) { nan++; continue; }
      const a = Math.abs(v);
      sum += a;
      if (a > peak) peak = a;
      if (v === 0) zeros++;
      if (a >= 0.999) clip++;
    }
    p.chunks.push({ idx: n++, n: d.length, rate: ctx.sampleRate, mean: sum / d.length, peak: peak, zeros: zeros, nan: nan, clip: clip, t: Date.now() - p.start });
    p.sampleRate = ctx.sampleRate;
    // 送进 app 的真实管线（main 进程会重采样/切片/入队/送 ASR）
    try {
      window.appApi.sendAudioChunk(new Float32Array(d), ctx.sampleRate);
    } catch (err) { p.errors.push(String(err && err.message)); }
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const tr = stream.getAudioTracks()[0];
  if (tr) tr.addEventListener("ended", () => { p.errors.push("track ended"); });
  p.stop = () => {
    try { proc.onaudioprocess = null; proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    audioOnly.getTracks().forEach(t => t.stop());
  };
  out.ok = true;
  return out;
})()
'@
