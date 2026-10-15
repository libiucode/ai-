param([int]$Port = 9223, [int]$Seconds = 75, [string]$WavPath = "D:\asrbench-audio\merged.wav")
$ErrorActionPreference = "Stop"
$libPath = "$PSScriptRoot\..\scripts\cdp-lib.ps1"
$lib = [System.IO.File]::ReadAllText($libPath, [System.Text.Encoding]::UTF8).Replace('$script:CdpPort = 9222', "`$script:CdpPort = $Port")
. ([scriptblock]::Create($lib))

$s = Connect-CdpPage -UrlPart "index.html" -Port $Port
Write-Host "attach: $($s.Page)"

Write-Host "=== 1. 装字幕抓取（订阅 transcript 事件，不依赖 DOM 渲染）==="
$null = Invoke-CdpEval $s @'
(() => {
  window.__subs = { partial: [], final: [], status: [] };
  if (window.appApi && window.appApi.subscribeEvents) {
    window.appApi.subscribeEvents("transcript.partial", (p) => {
      window.__subs.partial.push({ text: p.text, startMs: p.startMs, endMs: p.endMs, seq: p.sourceSeq, conn: p.connectionId, t: Date.now() });
    });
    window.appApi.subscribeEvents("transcript.final", (p) => {
      window.__subs.final.push({ text: p.text, startMs: p.startMs, endMs: p.endMs, seq: p.sourceSeq, conn: p.connectionId, voiceId: p.voiceId, t: Date.now() });
    });
    window.appApi.subscribeEvents("capture.status", (s) => {
      window.__subs.status.push({ level: s.level, over: s.queueOverflowCount, err: s.lastError ? s.lastError.code : null, t: Date.now() });
    });
    window.appApi.subscribeEvents("asr.status", (a) => {
      window.__subs.status.push({ asr: a.state, conn: a.connectionId, gap: a.gapDetected, t: Date.now() });
    });
  }
  return { hasApi: !!(window.appApi && window.appApi.subscribeEvents) };
})()
'@ $false 20

Write-Host "=== 2. 点「监听系统声音」建会话 ==="
$click = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='监听系统声音'); if(!b) return {ok:false}; b.click(); return {ok:true}; })()" $true 30
Write-Host "  $($click | ConvertTo-Json -Compress)"
Start-Sleep -Seconds 5
$sid = Invoke-CdpEval $s "(() => (document.body.innerText.match(/会话\s*([0-9a-zA-Z]+)/)||[])[1] || null)" $false 20
Write-Host "  sessionId = $sid"

Write-Host "=== 3. 播放 TTS ($Seconds s) ==="
$player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$WavPath`"" -PassThru -WindowStyle Hidden
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  if ($i % 10 -eq 0) {
    $c = Invoke-CdpEval $s "(() => ({ p: window.__subs.partial.length, f: window.__subs.final.length, status: window.__subs.status.length }))()" $false 15
    Write-Host ("  t={0}s partial={1} final={2}" -f $i, $c.p, $c.f)
  }
}
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
Start-Sleep -Seconds 4

Write-Host "=== 4. 抓字幕事件（真实 ASR 帧）==="
$finals = Invoke-CdpEval $s "(() => window.__subs.final.map(x => ({ seq: x.seq, text: x.text, startMs: x.startMs, endMs: x.endMs, conn: x.conn })))()" $false 30
$partials = Invoke-CdpEval $s "(() => window.__subs.partial.slice(-3).map(x => ({ seq: x.seq, text: x.text, startMs: x.startMs, endMs: x.endMs })))()" $false 30
$status = Invoke-CdpEval $s "(() => window.__subs.status.map(x => x))" $false 30

Write-Host "--- 稳态片段 (transcript.final) ---"
$i2 = 0
foreach ($f in $finals) {
  $i2++
  Write-Host ("  [{0}] seq={1} conn={2} [{3}ms -> {4}ms] ({5}ms) text={6}" -f $i2, $f.seq, ($f.conn -replace '^(.{8}).*','$1…'), $f.startMs, $f.endMs, ($f.endMs - $f.startMs), $f.text)
}
Write-Host "--- 最后 3 条中间结果 (transcript.partial) ---"
foreach ($p in $partials) { Write-Host ("  seq={0} [{1}->{2}] {3}" -f $p.seq, $p.startMs, $p.endMs, $p.text) }

Write-Host "=== 5. UI 一致性 ==="
$ui = Invoke-CdpEval $s $JS_UI_SUBTITLES $false 20
Write-Host ("  UI finalCount={0} sessionId={1} timer={2} asrChip={3}" -f $ui.finalCount, $ui.sessionId, $ui.timer, $ui.asrChip)

Write-Host "=== 6. 结束会话并读 DB ==="
$null = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/结束/.test(x.textContent)); if(b) b.click(); return true; })()" $true 30
Start-Sleep -Seconds 3

$dbg = @{
  at = (Get-Date -Format o); kind = "level2-subtitle-evidence"; port = $Port
  sessionId = $sid
  finals = $finals
  partialsTail = $partials
  ui = $ui
  statusEvents = $status
}
$dbg | ConvertTo-Json -Depth 8 | Set-Content -Path "$PSScriptRoot\..\evidence\lvl1-subtitles-$(Get-Date -Format 'yyyyMMdd-HHmmss').json" -Encoding utf8
Write-Host "证据已写 evidence\lvl1-subtitles-*.json"
Close-Cdp $s
