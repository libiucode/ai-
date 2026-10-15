param(
  [int]$Seconds = 40,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

# 关键：用 CDP Runtime.evaluate 的 userGesture:true 点按钮，这样 React onClick 会同步执行，
# 而 handler 的 request.userGesture 校验也能过（合成事件不算手势，userGesture 参数算）。
# 之前 win32 物理点击失败是因为页面坐标→屏幕坐标换算错了，这里不再依赖坐标。

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 1. 装探针（转发到原 sendAudioChunk）==="
$null = Invoke-CdpEval $s @'
(() => {
  window.__consoleLog = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) {
    console[k] = function(...a) {
      try { window.__consoleLog.push(k + ": " + a.map(x => { try { return (typeof x === "object") ? JSON.stringify(x) : String(x); } catch(e) { return String(x); } }).join(" ")); } catch(e) {}
      orig[k].apply(console, a);
    };
  }
  return true;
})()
'@ $false 20
$installed = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20
Write-Host "  探针: $installed"

Write-Host "=== 2. userGesture:true 点击「监听系统声音」==="
$clicked = Invoke-CdpEval $s @'
(() => {
  const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.trim() === "监听系统声音");
  if (!b) return { ok: false, why: "button not found" };
  const before = window.__live ? window.__live.chunks.length : 0;
  b.click();
  return { ok: true, text: b.textContent.trim(), disabled: b.disabled, chunksBefore: before };
})()
'@ $true 30
Write-Host "  点击结果: $($clicked | ConvertTo-Json -Compress)"

Write-Host "=== 3. 观察 ==="
$got = 0
for ($i = 1; $i -le 12; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $cl = Invoke-CdpEval $s "(() => { const m=(window.__consoleLog||[]); const tail = m.slice(-2).join(' || '); return tail.length>150 ? tail.slice(0,150) : tail; })()" $false 15
  $callout = Invoke-CdpEval $s "(() => { const c = Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim()); return c.length ? c[0].slice(0,70) : ''; })()" $false 15
  $timer = Invoke-CdpEval $s "(() => (document.body.innerText.match(/监听时长\s*([0-9:]+)/)||[])[1] || '')" $false 15
  Write-Host ("  t={0}s timer={1} chunks={2} rate={3} mean={4} peak={5} err={6} callout={7} log={8}" -f $i, $timer, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak, (@($snap.errors) -join '|'), $callout, $cl)
  if ($snap.chunks -gt 0) { $got = $snap.chunks; break }
  if (@($snap.errors).Count -gt 0) { break }
}

Write-Host "=== 4. 继续采样到 $Seconds 秒 ==="
for ($i = 13; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  if ($i % 5 -eq 0) {
    $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
    $t = Invoke-CdpEval $s "(() => (document.body.innerText.match(/监听时长\s*([0-9:]+)/)||[])[1] || '')" $false 15
    Write-Host ("  t={0}s timer={1} chunks={2} mean={3} peak={4}" -f $i, $t, $snap.chunks, $snap.lastMean, $snap.lastPeak)
  }
}

Write-Host "=== 5. UI 字幕证据 ==="
$ui = Invoke-CdpEval $s @'
(() => {
  const txt = document.body.innerText;
  const segs = Array.from(document.querySelectorAll(".subtitle-row, .transcript-row, li, .seg")).map(e => e.textContent.trim()).filter(t => t && t.length > 4);
  return {
    sessionTimer: (txt.match(/监听时长\s*([0-9:]+)/) || [])[1] || null,
    finalCount: (txt.match(/稳态片段数\s*(\d+)/) || [])[1] || null,
    hasTranscriptArea: /实时字幕/.test(txt),
    textSample: txt.slice(0, 600)
  };
})()
'@ $false 20
$ui | ConvertTo-Json -Depth 5 -Compress

Write-Host "=== 6. 汇总 ==="
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress
$clAll = Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15

# 停会话
$endBtn = Invoke-CdpEval $s @'
(() => {
  const b = Array.from(document.querySelectorAll("button")).find(x => /结束/.test(x.textContent));
  if (!b) return null;
  b.click();
  return { clicked: true };
})()
'@ $true 30
Write-Host "  结束会话: $($endBtn | ConvertTo-Json -Compress)"

$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-final-chunks-$stamp.json"
($chunks | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path $chunkFile -Encoding utf8

@{
  at = (Get-Date -Format o)
  kind = "loopback-via-userGesture-click"
  click = $clicked
  ui = $ui
  final = $final
  console = @($clAll)
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-final-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-final-$stamp.json")"
Close-Cdp $s
