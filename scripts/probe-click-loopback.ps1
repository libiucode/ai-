param(
  [int]$Seconds = 30,
  [string]$OutDir = "D:\ai盯播工具\app\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

function Send-CdpRaw {
  param($Session, [string]$Method, $Params)
  $Session.Id++
  $id = $Session.Id
  $req = @{ id = $id; method = $Method; params = $Params }
  $payload = $req | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $bytes, 0, $bytes.Length
  $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(20000)
  $buf = New-Object byte[] 4194304
  $deadline = (Get-Date).AddSeconds(30)
  $sb = New-Object System.Text.StringBuilder
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    try { if (-not $task.Wait(3000)) { continue } } catch { Start-Sleep -Milliseconds 800; continue }
    if ($task.IsFaulted -or $task.IsCanceled) { Start-Sleep -Milliseconds 800; continue }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "CDP closed" }
    $null = $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    if (-not $res.EndOfMessage) { continue }
    $text = $sb.ToString(); $sb.Clear() | Out-Null
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($null -eq $obj.id -or $obj.id -ne $id) { continue }
    if ($obj.error) { throw "CDP error: $($obj.error | ConvertTo-Json -Compress)" }
    return $obj
  }
  throw "raw call timeout"
}

# 带容错的 eval：失败时重连一次再试
function Ev {
  param($Session, [string]$Js, [bool]$Await = $false, [int]$To = 20)
  try { return Invoke-CdpEval $Session $Js $Await $To }
  catch {
    Write-Host "  [eval 失败，重连重试] $($_.Exception.Message.Substring(0,[Math]::Min(100,$_.Exception.Message.Length)))"
    Start-Sleep -Seconds 2
    $s2 = Reconnect-Cdp -UrlPart "index.html"
    if ($null -eq $s2) { throw "重连失败" }
    return Invoke-CdpEval $s2 $Js $Await $To
  }
}

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 1. 安装探针 ==="
$installed = Ev $s $JS_INSTALL_PROBE $false 20
Write-Host "  探针安装: $installed"

Write-Host "=== 2. 定位按钮 ==="
$rect = Ev $s $JS_FIND_BUTTON $false 20
$rect | ConvertTo-Json -Compress
if ($null -eq $rect) { throw "找不到「监听系统声音」按钮" }

Write-Host "=== 3. 真实鼠标点击（产生 userGesture）==="
$x = [int]$rect.x; $y = [int]$rect.y
try {
  $null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mouseMoved"; x = $x; y = $y }
  Start-Sleep -Milliseconds 300
  $null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mousePressed"; x = $x; y = $y; button = "left"; clickCount = 1 }
  Start-Sleep -Millisecond 80
  $null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mouseReleased"; x = $x; y = $y; button = "left"; clickCount = 1 }
  Write-Host "  已点击 ($x,$y)"
} catch {
  Write-Host "  点击发送异常（连接可能已变）: $($_.Exception.Message)"
  $s = Reconnect-Cdp -UrlPart "index.html"
}

Write-Host "=== 4. 逐秒观察 ==="
$got = 0
for ($i = 1; $i -le 8; $i++) {
  Start-Sleep -Seconds 1
  try { $snap = Ev $s $JS_PROBE_SNAP $false 15 } catch { Write-Host "  t=${i}s eval 失败"; continue }
  Write-Host ("  t={0}s chunks={1} rate={2} mean={3} peak={4} err={5}" -f $i, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak, (@($snap.errors) -join '|'))
  if ($snap.chunks -gt 0) { $got = $snap.chunks }
}

Write-Host "=== 5. 继续采样到 $Seconds 秒 ==="
for ($i = 9; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  if ($i % 10 -eq 0) {
    try { $snap = Ev $s $JS_PROBE_SNAP $false 15 } catch { continue }
    Write-Host ("  t={0}s chunks={1} mean={2} peak={3}" -f $i, $snap.chunks, $snap.lastMean, $snap.lastPeak)
  }
}

Write-Host "=== 6. 汇总 ==="
$final = Ev $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress

$chunks = Ev $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-click-chunks-$stamp.json"
$chunks | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $chunkFile -Encoding utf8

@{
  at = (Get-Date -Format o)
  kind = "loopback-via-real-click"
  buttonClick = $rect
  final = $final
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-click-$stamp.json") -Encoding utf8
Write-Host "证据写入 $(Join-Path $OutDir "loopback-click-$stamp.json")"
try { Close-Cdp $s } catch { }
