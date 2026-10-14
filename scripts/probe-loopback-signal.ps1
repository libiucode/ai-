param(
  [int]$Seconds = 30,
  [string]$OutDir = "D:\ai盯播工具\app\evidence",
  [string]$Signal = "tone"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

# 播放源：用 ffmpeg 生成一段已知信号，通过系统输出播放，loopback 采回来的电平
# 应在已知范围内。这是「已知信号→采集→非零」的闭环验证。
# 注意：这证明的是 loopback 采集链路本身，不是抖音直播内容。直播内容作为独立项标注。
$wav = "$env:TEMP\probe-signal-$stamp.wav"
if ($Signal -eq "tone") {
  # 440Hz + 1kHz 双音混合，方便判断电平起伏与内容真实性
  $a = "sine=frequency=440:duration=$Seconds" + ":sample_rate=48000"
  $b = "sine=frequency=1000:duration=$Seconds" + ":sample_rate=48000"
  $fc = "[0:a][1:a]amix=inputs=2:duration=first,volume=0.35"
  $null = & ffmpeg -hide_banner -loglevel error -f lavfi -i $a -f lavfi -i $b -filter_complex $fc -ac 2 -ar 48000 $wav
} else {
  $a = "sine=frequency=440:duration=$Seconds" + ":sample_rate=48000"
  $null = & ffmpeg -hide_banner -loglevel error -f lavfi -i $a -ac 2 -ar 48000 $wav
}
$len = (Get-Item $wav).Length
Write-Host "=== 播放源已生成: $wav ($len bytes, $Seconds s @48kHz stereo) ==="

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 1. 装探针 ==="
$null = Invoke-CdpEval $s "(() => { window.__consoleLog = []; const o={log:console.log,warn:console.warn,error:console.error}; for(const k of Object.keys(o)){ console[k]=function(...a){ try{ window.__consoleLog.push(k+': '+a.map(x=>{try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ')); }catch(e){} o[k].apply(console,a); }; } return true; })()" $false 20
$inst = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20
Write-Host "  探针: $inst"

Write-Host "=== 2. userGesture:true 点击「监听系统声音」==="
$click = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='监听系统声音'); if(!b) return {ok:false,why:'button not found'}; b.click(); return {ok:true,text:b.textContent.trim(),disabled:b.disabled}; })()" $true 30
Write-Host "  $($click | ConvertTo-Json -Compress)"

Start-Sleep -Seconds 2
Write-Host "=== 3. 起播放（后台）==="
$player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-autoexit","-loglevel","quiet","`"$wav`"" -PassThru -WindowStyle Hidden
Write-Host "  ffplay PID=$($player.Id)"

Write-Host "=== 4. 逐秒观察 ==="
$rows = @()
for ($i = 1; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $t = Invoke-CdpEval $s "(() => (document.body.innerText.match(/监听时长\s*([0-9:]+)/)||[])[1] || '')" $false 15
  $rows += [pscustomobject]@{ t = $i; timer = $t; chunks = $snap.chunks; mean = $snap.lastMean; peak = $snap.lastPeak }
  if ($i -le 6 -or $i % 5 -eq 0) {
    Write-Host ("  t={0}s timer={1} chunks={2} mean={3} peak={4}" -f $i, $t, $snap.chunks, $snap.lastMean, $snap.lastPeak)
  }
  if ($i -eq $Seconds) { break }
}

Write-Host "=== 5. 停播放 + 汇总 ==="
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress
$clAll = Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15

$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-signal-chunks-$stamp.json"
($chunks | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path $chunkFile -Encoding utf8

$endBtn = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/结束/.test(x.textContent)); if(!b) return null; b.click(); return {clicked:true}; })()" $true 30
Write-Host "  结束: $($endBtn | ConvertTo-Json -Compress)"

@{
  at = (Get-Date -Format o)
  kind = "loopback-known-signal"
  signal = @{ file = $wav; seconds = $Seconds; rate = 48000; type = $Signal }
  click = $click
  final = $final
  console = @($clAll)
  samples = $rows
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-signal-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-signal-$stamp.json")"
Close-Cdp $s
