param(
  [int]$Minutes = 10,
  [string]$DeviceId = "",
  [string]$OutDir = "D:\ai盯播工具\app\evidence",
  [switch]$UseVB
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PSScriptRoot\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))
if ($PSScriptRoot -eq "") { $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }

# 用 VB-CABLE 时，把设备指向 CABLE Output（这样可复现「设备活着但无信号」）
$targetDevice = ""
$deviceNote = "默认麦克风"
if ($UseVB) { $targetDevice = "4db1d7580eb7dbfe"; $deviceNote = "CABLE Output (VB-Audio Virtual Cable)" }
elseif ($DeviceId) { $targetDevice = $DeviceId; $deviceNote = "deviceId=$DeviceId" }

$js = @"
(async () => {
  const out = { device: $($deviceNote | ConvertTo-Json), steps: [] };
  window.__mic = { chunks: [], start: Date.now(), errors: [] };
  let constraints;
  if ("$targetDevice" === "") {
    constraints = { audio: { echoCancellation: false, noiseSuppression: false } };
  } else {
    constraints = { audio: { deviceId: { exact: "$targetDevice" }, echoCancellation: false, noiseSuppression: false } };
  }
  out.constraints = JSON.parse(JSON.stringify(constraints));
  let stream;
  try {
    out.steps.push("getUserMedia");
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    out.steps.push("resolved");
  } catch (e) {
    out.error = { name: e && e.name, message: e && e.message };
    return out;
  }
  out.trackLabel = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : null;
  out.trackSettings = stream.getAudioTracks()[0] ? JSON.parse(JSON.stringify(stream.getAudioTracks()[0].getSettings())) : null;
  const ctx = new AudioContext();
  out.ctxState = ctx.state;
  out.ctxSampleRate = ctx.sampleRate;
  out.ctxBaseLatency = ctx.baseLatency;
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  let n = 0;
  const mic = window.__mic;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let sum = 0, sumSq = 0, peak = 0, zeros = 0, nan = 0, clip = 0, minv = 1, maxv = -1;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (typeof v !== "number" || isNaN(v)) { nan++; continue; }
      const a = Math.abs(v);
      sum += a; sumSq += v * v;
      if (a > peak) peak = a;
      if (v === 0) zeros++;
      if (a >= 0.999) clip++;
      if (v < minv) minv = v;
      if (v > maxv) maxv = v;
    }
    mic.chunks.push({
      idx: n++, n: d.length, sampleRate: ctx.sampleRate, t: Date.now() - mic.start,
      mean: sum / d.length, rms: Math.sqrt(sumSq / d.length), peak: peak,
      min: minv, max: maxv, zeros: zeros, nan: nan, clip: clip
    });
    // 模拟真实数据流：也送进主进程（如果主进程在收）
    if (window.appApi && window.appApi.sendAudioChunk) {
      try { window.appApi.sendAudioChunk(new Float32Array(d), ctx.sampleRate); } catch (err) { mic.errors.push(String(err)); }
    }
  };
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const tr = stream.getAudioTracks()[0];
  if (tr) {
    tr.addEventListener("ended", () => { mic.errors.push("track ended"); });
    tr.addEventListener("mute", () => { mic.errors.push("track muted"); });
  }
  window.__mic.stop = () => {
    try { proc.onaudioprocess = null; proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) {}
    try { ctx.close(); } catch (e) {}
    stream.getTracks().forEach(t => t.stop());
  };
  out.ok = true;
  return out;
})()
"@

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 麦克风长测：$deviceNote，$Minutes 分钟 ==="
$start = Invoke-CdpEval $s $js $true 60
$start | ConvertTo-Json -Depth 6 -Compress
if (-not $start.ok) {
  Write-Host "!!! 麦克风启动失败"
  @{ at = (Get-Date -Format o); device = $deviceNote; start = $start } | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutDir "mic-$stamp.json") -Encoding utf8
  Close-Cdp $s
  exit 3
}

$totalSec = $Minutes * 60
$log = @()
$zeroChunks = 0
$maxPeak = 0
$maxRms = 0
$lastLog = (Get-Date)
for ($i = 1; $i -le $totalSec; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s "(() => { const m = window.__mic; if (!m) return { chunks: 0 }; const c = m.chunks; const last = c.length ? c[c.length-1] : null; return { chunks: c.length, lastMean: last ? last.mean : null, lastRms: last ? last.rms : null, lastPeak: last ? last.peak : null, lastZeros: last ? last.zeros : null, errors: m.errors.slice() }; })()" $false 30
  if ($null -ne $snap.lastPeak) { if ($snap.lastPeak -gt $maxPeak) { $maxPeak = $snap.lastPeak } }
  if ($null -ne $snap.lastRms) { if ($snap.lastRms -gt $maxRms) { $maxRms = $snap.lastRms } }
  $log += [pscustomobject]@{ t = $i; chunks = $snap.chunks; rms = $snap.lastRms; peak = $snap.lastPeak }
  if ($i % 30 -eq 0) {
    $el = ((Get-Date) - $lastLog).TotalSeconds
    $lastLog = Get-Date
    Write-Host ("  t={0}s chunks={1} lastRms={2:N6} maxPeak={3:N6} errCount={4}" -f $i, $snap.chunks, $snap.lastRms, $maxPeak, @($snap.errors).Count)
  }
  if (@($snap.errors).Count -gt 0) { Write-Host "  [errors] $($snap.errors -join ' | ')" }
}

$final = Invoke-CdpEval $s "(() => { const m = window.__mic; const c = m.chunks; if (!c.length) return { chunkCount: 0 }; const nz = c.filter(x => x.mean > 1e-9).length; const intervals = []; for (let i = 1; i < c.length; i++) intervals.push(c[i].t - c[i-1].t); const sorted = intervals.slice().sort((a,b)=>a-b); const fullyZero = c.filter(x => x.zeros === x.n).length; const within1 = c.filter(x => Math.abs(x.mean) < 1e-6 && x.zeros === 0).length; return { chunkCount: c.length, totalSamples: c.reduce((a,x)=>a+x.n,0), wallMs: c[c.length-1].t - c[0].t, nonzeroChunks: nz, allZeroMeanChunks: c.length - nz, fullyZeroChunks: fullyZero, quietButNonzeroChunks: within1, meanOfMeans: c.reduce((a,x)=>a+x.mean,0)/c.length, maxMean: Math.max.apply(null, c.map(x=>x.mean)), maxRms: Math.max.apply(null, c.map(x=>x.rms)), maxPeak: Math.max.apply(null, c.map(x=>x.peak)), minPeak: Math.min.apply(null, c.map(x=>x.peak)), medianIntervalMs: sorted.length ? sorted[Math.floor(sorted.length/2)] : null, chunksPerSec: c.length / ((c[c.length-1].t - c[0].t)/1000), sampleRates: Array.from(new Set(c.map(x=>x.sampleRate))), anyNan: c.some(x=>x.nan>0), anyClipped: c.some(x=>x.clip>0), totalNan: c.reduce((a,x)=>a+x.nan,0), totalClip: c.reduce((a,x)=>a+x.clip,0), errors: m.errors }; })()" $false 60
$final | ConvertTo-Json -Depth 8 -Compress

$null = Invoke-CdpEval $s $JS_STOP $false 15
Close-Cdp $s

$result = @{
  at = (Get-Date -Format o)
  kind = "microphone"
  device = $deviceNote
  minutes = $Minutes
  start = $start
  final = $final
} | ConvertTo-Json -Depth 8
$result | Set-Content -Path (Join-Path $OutDir "mic-$stamp.json") -Encoding utf8
Write-Host "写入 $(Join-Path $OutDir "mic-$stamp.json")"
