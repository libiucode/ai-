# 用 PowerShell 做 CDP 客户端：ClientWebSocket 连 ws，发 Runtime.evaluate。
# 用法: .\scripts\cdp.ps1 -Expr "location.href" [-Await] 
param(
  [Parameter(Mandatory=$true)][string]$Expr,
  [switch]$Await,
  [int]$TimeoutSec = 30,
  [int]$Port = 9222
)
$ErrorActionPreference = "Stop"

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 10
$page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
if (-not $page) { throw "没有 page 目标" }
$wsUrl = $page.webSocketDebuggerUrl
Write-Host "目标: $($page.url)"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$wsUrl, $ct).Wait(10000) | Out-Null
if ($ws.State -ne 'Open') { throw "WebSocket 未打开: $($ws.State)" }

$msgId = 0
$pending = @{}

function Send-Cdp([string]$method, $params) {
  $script:msgId++
  $id = $script:msgId
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $bytes, 0, $bytes.Length
  $null = $script:ws.SendAsync($seg, 'Text', $true, $ct).Wait(5000)
  $script:pending[$id] = $null
  return $id
}

function Read-Messages([int]$untilId) {
  $buf = New-Object byte[] 65536
  while ($true) {
    $seg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $script:ws.ReceiveAsync($seg, $ct)
    if (-not $task.Wait(30000)) { throw "接收超时" }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "CDP 关闭连接" }
    $chunk = New-Object byte[] $res.Count
    [Array]::Copy($buf, 0, $chunk, 0, $res.Count)
    # 简化：假设单帧完整 JSON
    $text = [System.Text.Encoding]::UTF8.GetString($chunk)
    if ($res.EndOfMessage) {
      try { $obj = $text | ConvertFrom-Json } catch { continue }
      if ($obj.id) {
        if ($obj.id -eq $untilId) { return $obj }
        $script:pending[$obj.id] = $obj
      }
    }
  }
}

# 启用域
$null = Send-Cdp "Runtime.enable" @{}
$null = Read-Messages -1 -ErrorAction SilentlyContinue
$null = Send-Cdp "Page.enable" @{}
$null = Read-Messages -1 -ErrorAction SilentlyContinue

$id = Send-Cdp "Runtime.evaluate" @{ expression = $Expr; returnByValue = $true; awaitPromise = [bool]$Await }
$resp = Read-Messages $id
if ($resp.error) {
  Write-Host "CDP ERROR: $($resp.error | ConvertTo-Json -Compress)"
  exit 1
}
if ($resp.result.exceptionDetails) {
  Write-Host "PAGE EXCEPTION:"
  Write-Host ($resp.result.exceptionDetails | ConvertTo-Json -Depth 8 -Compress)
  exit 2
}
$resp.result.result | ConvertTo-Json -Depth 10 -Compress
$ws.Dispose()
