param(
  [int]$Seconds = 40,
  [string]$OutDir = "D:\ai盯播工具\app\evidence",
  [string]$Source = "signal",
  [string]$LiveUrl = "https://live.douyin.com/295178185857"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

# 播放源。signal = ffmpeg 生成已知测试音（钉死 ASR 出字，与直播源无关）；
# live   = 浏览器打开抖音直播间（真实直播内容，单独标注）。
$wav = "$env:TEMP\probe-src-$stamp.wav"
$a = "sine=frequency=440:duration=$Seconds" + ":sample_rate=48000"
$b2 = "sine=frequency=880:duration=$Seconds" + ":sample_rate=48000"
$fc = "[0:a][1:a]amix=inputs=2:duration=first,volume=0.6"
$null = & ffmpeg -hide_banner -loglevel error -f lavfi -i $a -f lavfi -i $b2 -filter_complex $fc -ac 2 -ar 48000 $wav
Write-Host "=== 播放源: $wav ($((Get-Item $wav).Length) bytes, $Seconds s, 440+880Hz @0.6) ==="

# 先确认 app 读到了 ASR 凭证（readStored status 会说 env configured）
$s = Connect-CdpPage -UrlPart "index.html"
$null = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20

$asrCfg = $null
try {
  $asrCfg = Invoke-CdpEval $s "(() => { const t = document.body.innerText; return { hasAsrStatus: /ASR/.test(t), blob: t.slice(0, 100) }; })()" $false 15
} catch { }
Write-Host "=== app UI 状态: $($asrCfg | ConvertTo-Json -Compress) ==="

# 检查设置页 ASR 状态：走到「分析设置」页读 ASR 连接状态
Write-Host "=== 探测 ASR 凭证状态（跳到分析设置页）==="
$null = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='分析设置'); if(b) b.click(); return true; })()" $true 30
Start-Sleep -Seconds 2
$asrText = Invoke-CdpEval $s "(() => { const t = document.body.innerText; const m = t.match(/ASR[\s\S]{0,200}/); return m ? m[0].slice(0,200) : '(未找到 ASR 区块)'; })()" $false 15
Write-Host "  ASR 区块: $asrText"
$null = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='实时监控'); if(b) b.click(); return true; })()" $true 30
Start-Sleep -Seconds 1

Write-Host "=== 1. loopback 采集（单表达式，userGesture:true）==="
$start = Invoke-CdpEval $s $JS_START_LOOPBACK_LIVE $true 60
Write-Host "  $($start | ConvertTo-Json -Compress)"
if (-not $start.ok) { Write-Host "!!! loopback 启动失败"; Close-Cdp $s; exit 3 }

Start-Sleep -Seconds 2
Write-Host "=== 2. 起播放 ==="
$player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$wav`"" -PassThru -WindowStyle Hidden
Write-Host "  ffplay PID=$($player.Id)"

Write-Host "=== 3. 观察 $Seconds 秒（重点抓字幕与稳态片段）==="
$rows = @()
$firstFinalAt = $null
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $ui = Invoke-CdpEval $s $JS_UI_SUBTITLES $false 15
  $rows += [pscustomobject]@{ t = $i; chunks = $snap.chunks; mean = $snap.lastMean; finals = $ui.finalCount; partials = $ui.partialCount }
  if ($i -le 10 -or $i % 5 -eq 0) {
    Write-Host ("  t={0}s chunks={1} mean={2:N4} peak={3:N4} final={4} partial={5} lastFinal={6}" -f $i, $snap.chunks, $snap.lastMean, $snap.lastPeak, $ui.finalCount, $ui.partialCount, $ui.lastFinalText)
  }
  if ($ui.finalCount -gt 0 -and $null -eq $firstFinalAt) { $firstFinalAt = $i }
}

Write-Host "=== 4. 停播放 + 收尾 ==="
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
Start-Sleep -Seconds 3
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$uiFinal = Invoke-CdpEval $s $JS_UI_SUBTITLES $false 20
$clAll = Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15

try { $null = Invoke-CdpEval $s "(() => { try { window.__live.stop && window.__live.stop(); } catch(e){} return true; })()" $false 15 } catch { }

$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "final-chunks-$stamp.json"
($chunks | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path $chunkFile -Encoding utf8

@{
  at = (Get-Date -Format o)
  kind = "loopback-with-asr"
  playback = @{ file = $wav; seconds = $Seconds; rate = 48000; mix = "440+880Hz volume0.6"; isLiveStream = $false }
  start = $start
  level = $final
  ui = $uiFinal
  firstFinalAtSecond = $firstFinalAt
  samples = $rows
  console = @($clAll)
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "final-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "final-$stamp.json")"
Close-Cdp $s
