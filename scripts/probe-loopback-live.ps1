param(
  [int]$Seconds = 25,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

# 关键经验（2026-10-14 实测）：
# CDP Runtime.evaluate 的 userGesture:true 只对**当次表达式**授予用户手势。
# 若表达式里只做 b.click()，里面触发的 getDisplayMedia 属于后续微任务，手势已失效 → AbortError。
# 所以要在同一次表达式内直接完成 getDisplayMedia + ScriptProcessor + sendAudioChunk 全链路。
# 本脚本用的是与 src/renderer/capture/audioCapture.ts 的 wireStream 完全一致的接线图。

$wav = "$env:TEMP\probe-signal-$stamp.wav"
$a = "sine=frequency=440:duration=$Seconds" + ":sample_rate=48000"
$b2 = "sine=frequency=1000:duration=$Seconds" + ":sample_rate=48000"
$fc = "[0:a][1:a]amix=inputs=2:duration=first,volume=0.35"
$null = & ffmpeg -hide_banner -loglevel error -f lavfi -i $a -f lavfi -i $b2 -filter_complex $fc -ac 2 -ar 48000 $wav
Write-Host "=== 播放源: $wav ($((Get-Item $wav).Length) bytes, $Seconds s) ==="

$s = Connect-CdpPage -UrlPart "index.html"

# 探针：转发到原 sendAudioChunk（不替换 app 行为，只旁路统计）
$null = Invoke-CdpEval $s "(() => { window.__consoleLog = []; return true; })()" $false 20
$inst = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20
Write-Host "=== 探针: $inst ==="

Write-Host "=== 同一次表达式内完成 loopback 全链路 ==="
$start = Invoke-CdpEval $s $JS_START_LOOPBACK_LIVE $true 60
$start | ConvertTo-Json -Depth 6 -Compress
if (-not $start.ok) { Close-Cdp $s; exit 3 }

Start-Sleep -Seconds 2
Write-Host "=== 起播放 ==="
$player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$wav`"" -PassThru -WindowStyle Hidden
Write-Host "  ffplay PID=$($player.Id)"

Write-Host "=== 逐秒观察 ==="
$rows = @()
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $rows += [pscustomobject]@{ t = $i; chunks = $snap.chunks; mean = $snap.lastMean; peak = $snap.lastPeak }
  if ($i -le 6 -or $i % 5 -eq 0) {
    Write-Host ("  t={0}s chunks={1} rate={2} mean={3} peak={4}" -f $i, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak)
  }
}

Write-Host "=== 汇总 ==="
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress

# 停采（关掉我们起的 proc/ctx）
$null = Invoke-CdpEval $s "(() => { try { window.__live.stop && window.__live.stop(); } catch(e) {} return true; })()" $false 15

$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-live-chunks-$stamp.json"
($chunks | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path $chunkFile -Encoding utf8

@{
  at = (Get-Date -Format o)
  kind = "loopback-known-signal-single-expr"
  signal = @{ file = $wav; seconds = $Seconds; rate = 48000; mix = "440Hz+1kHz@0.35" }
  start = $start
  final = $final
  samples = $rows
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-live-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-live-$stamp.json")"
Close-Cdp $s
