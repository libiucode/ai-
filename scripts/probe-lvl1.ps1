param(
  [int]$Port = 9223,
  [int]$Seconds = 60,
  [string]$OutDir = "D:\ai盯播工具\app\evidence",
  [string]$WavPath = "",
  [switch]$SkipButton
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# 用负责人的实例（PID 43608, CDP 9223）。只 attach，不拉 app。
$libPath = "D:\ai盯播工具\app\scripts\cdp-lib.ps1"
$lib = [System.IO.File]::ReadAllText($libPath, [System.Text.Encoding]::UTF8)
$lib = $lib.Replace('$script:CdpPort = 9222', "`$script:CdpPort = $Port")
. ([scriptblock]::Create($lib))

$s = $null
for ($a = 0; $a -lt 4; $a++) { try { $s = Connect-CdpPage -UrlPart "index.html" -Port $Port; break } catch { Write-Host "  attach 重试 $a"; Start-Sleep -Seconds 3 } }
if ($null -eq $s) { throw "连不上 CDP $Port" }
Write-Host "=== 已 attach: $($s.Page) ==="

Write-Host "=== 0. 探针（旁路统计，不改行为）==="
$null = Invoke-CdpEval $s "(() => { window.__consoleLog = []; const o={log:console.log,warn:console.warn,error:console.error}; for(const k of Object.keys(o)){ console[k]=function(...a){ try{ window.__consoleLog.push(k+': '+a.map(x=>{try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ')); }catch(e){} o[k].apply(console,a); }; } return true; })()" $false 20
$inst = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20
Write-Host "  探针: $inst"

# ---------- 步骤 2：走 app 自己的按钮 ----------
if (-not $SkipButton) {
  Write-Host "=== 1. userGesture:true 点「监听系统声音」（走 app 的 wireStream）==="
  $click = Invoke-CdpEval $s @'
(() => {
  const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.trim() === "监听系统声音");
  if (!b) return { ok: false, why: "button not found" };
  b.click();
  return { ok: true, text: b.textContent.trim() };
})()
'@ $true 30
  Write-Host "  点击: $($click | ConvertTo-Json -Compress)"
  Start-Sleep -Seconds 4
  # 确认 orchestrator status=active
  for ($w = 0; $w -lt 10; $w++) {
    $st = Invoke-CdpEval $s "(() => { const t = document.body.innerText; return { timer: (t.match(/监听时长\s*([0-9:]+)/)||[])[1]||null, source: (t.match(/音源\s*(麦克风|系统声音)/)||[])[1]||null, session: (t.match(/会话\s*([0-9a-zA-Z]+)/)||[])[1]||null, chip: (()=>{ const c=Array.from(document.querySelectorAll('.chip')).find(x=>/采集/.test(x.textContent)); return c?c.textContent.trim():null; })() }; })()" $false 20
    Write-Host "  [$w] timer=$($st.timer) source=$($st.source) session=$($st.session) chip=$($st.chip)"
    if ($st.timer -and $st.timer -ne "00:00") { break }
    Start-Sleep -Seconds 2
  }
  if (-not $st.timer -or $st.timer -eq "00:00") {
    Write-Host "!!! 会话未建立（timer 仍 00:00），不能起播放源——白跑。请检查按钮/权限。"
    $dbg = @{ at = (Get-Date -Format o); stage = "session-not-started"; click = $click; state = $st; console = @(Invoke-CdpEval $s "(()=>(window.__consoleLog||[]).slice())" $false 15) } | ConvertTo-Json -Depth 6
    $dbg | Set-Content -Path (Join-Path $OutDir "lvl1-failed-$stamp.json") -Encoding utf8
    Close-Cdp $s
    exit 3
  }
  Write-Host "  → 会话已建立，status=active 确认"
} else {
  Write-Host "=== 1. 跳过按钮（-SkipButton）==="
}

# ---------- 步骤 3：播放源 ----------
$srcLabel = ""
if ($WavPath -ne "" -and (Test-Path $WavPath)) {
  $srcLabel = $WavPath
  Write-Host "=== 2. 播放指定 WAV: $WavPath ==="
  $length = (Get-Item $WavPath).Length
  Write-Host "  大小 $length bytes"
  $player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$WavPath`"" -PassThru -WindowStyle Hidden
} else {
  $srcLabel = "ffmpeg 440+1000Hz @0.35"
  $wav = "$env:TEMP\lvl1-$stamp.wav"
  $a = "sine=frequency=440:duration=$Seconds" + ":sample_rate=48000"
  $b2 = "sine=frequency=1000:duration=$Seconds" + ":sample_rate=48000"
  $fc = "[0:a][1:a]amix=inputs=2:duration=first,volume=0.35"
  $null = & ffmpeg -hide_banner -loglevel error -f lavfi -i $a -f lavfi -i $b2 -filter_complex $fc -ac 2 -ar 48000 $wav
  Write-Host "=== 2. 播放源生成: $wav ==="
  $srcLabel = $wav
  $player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$wav`"" -PassThru -WindowStyle Hidden
}
Write-Host "  ffplay PID=$($player.Id)"

# ---------- 步骤 4：观察 ----------
Write-Host "=== 3. 观察 $Seconds 秒 ==="
$rows = @()
$firstFinalAt = $null
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $ui = Invoke-CdpEval $s $JS_UI_SUBTITLES $false 15
  $rows += [pscustomobject]@{ t = $i; chunks = $snap.chunks; mean = $snap.lastMean; finals = $ui.finalCount; timer = $ui.timer }
  if ($i -le 8 -or $i % 5 -eq 0) {
    Write-Host ("  t={0}s timer={1} chunks={2} mean={3:N4} peak={4:N4} final={5} asrChip={6} segChip={7}" -f $i, $ui.timer, $snap.chunks, $snap.lastMean, $snap.lastPeak, $ui.finalCount, $ui.asrChip, $ui.lastFinalChip)
  }
  if ($ui.finalCount -gt 0 -and $null -eq $firstFinalAt) { $firstFinalAt = $i }
  if ($player.HasExited -and $i -gt 5) { }
}

Write-Host "=== 4. 收尾 ==="
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
Start-Sleep -Seconds 2
$level = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$uiFinal = Invoke-CdpEval $s $JS_UI_SUBTITLES $false 20
$clAll = Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15

# 结束会话（走 app 按钮，保证 flushAudio + ASR stop 正常）
$endBtn = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/结束/.test(x.textContent)); if(!b) return null; b.click(); return {clicked:true}; })()" $true 30
Write-Host "  结束会话: $($endBtn | ConvertTo-Json -Compress)"
Start-Sleep -Seconds 2

@{
  at = (Get-Date -Format o)
  kind = "level1-known-signal"
  port = $Port
  playback = @{ source = $srcLabel; seconds = $Seconds; isLiveStream = $false }
  level = $level
  ui = $uiFinal
  firstFinalAtSecond = $firstFinalAt
  samples = $rows
  console = @($clAll)
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "lvl1-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "lvl1-$stamp.json")"
Close-Cdp $s
