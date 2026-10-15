param(
  [int]$Seconds = 25,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

function Send-CdpRaw {
  param($Session, [string]$Method, $Params, [int]$To = 20)
  $Session.Id++
  $id = $Session.Id
  $req = @{ id = $id; method = $Method; params = $Params }
  $payload = $req | ConvertTo-Json -Depth 12 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $bytes, 0, $bytes.Length
  $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(20000)
  $buf = New-Object byte[] 4194304
  $deadline = (Get-Date).AddSeconds($To)
  $sb = New-Object System.Text.StringBuilder
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    try { if (-not $task.Wait(2000)) { continue } } catch { Start-Sleep -Milliseconds 500; continue }
    if ($task.IsFaulted -or $task.IsCanceled) { Start-Sleep -Milliseconds 500; continue }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "CDP closed" }
    $null = $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    if (-not $res.EndOfMessage) { continue }
    $text = $sb.ToString(); $sb.Clear() | Out-Null
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    # 匹配 id 或接受无 id 的事件通知后继续等
    if ($null -ne $obj.id -and $obj.id -eq $id) {
      if ($obj.error) { throw "CDP error: $($obj.error | ConvertTo-Json -Compress)" }
      return $obj
    }
  }
  return $null
}

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 1. bringToFront + 安装探针 ==="
$null = Send-CdpRaw $s "Page.bringToFront" @{} 10
$installed = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20
Write-Host "  探针: $installed"
$rect = Invoke-CdpEval $s $JS_FIND_BUTTON $false 20
Write-Host "  按钮: $($rect | ConvertTo-Json -Compress)"

Write-Host "=== 2. 点击前先聚焦窗口 ==="
# 用 PowerShell 把 Electron 窗口拉到前台（真实激活，才能产生 userGesture）
$app = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" | Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" } | Select-Object -First 1
if ($app) {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
}
'@
  if (-not ("Win" -as [type])) { Add-Type -TypeDefinition $sig -ReferencedAssemblies "System.Runtime.InteropServices" }
  $proc = Get-Process -Id $app.ProcessId
  $h = $proc.MainWindowHandle
  Write-Host "  app PID=$($app.ProcessId) hwnd=$h"
  if ($h -ne 0) {
    $null = [Win]::ShowWindow($h, 9)  # SW_RESTORE
    $null = [Win]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 800
  }
}

Write-Host "=== 3. CDP 真实鼠标点击 ==="
$x = [int]$rect.x; $y = [int]$rect.y
$null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mouseMoved"; x = $x; y = $y }
Start-Sleep -Millisecond 200
$null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mousePressed"; x = $x; y = $y; button = "left"; clickCount = 1; buttons = 1 }
Start-Sleep -Millisecond 60
$null = Send-CdpRaw $s "Input.dispatchMouseEvent" @{ type = "mouseReleased"; x = $x; y = $y; button = "left"; clickCount = 1; buttons = 0 }
Write-Host "  已点击 ($x,$y)"

Write-Host "=== 4. 观察 ==="
$got = 0
for ($i = 1; $i -le 8; $i++) {
  Start-Sleep -Seconds 1
  try { $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15 } catch { Write-Host "  t=${i}s eval fail"; continue }
  Write-Host ("  t={0}s chunks={1} rate={2} mean={3} peak={4} err={5}" -f $i, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak, (@($snap.errors) -join '|'))
  if ($snap.chunks -gt 0) { $got = $snap.chunks; break }
}

if ($got -eq 0) {
  Write-Host "=== 4b. 检查调用栈是否抛错（captureError 状态）==="
  $st = Invoke-CdpEval $s "(() => { const callouts = Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim()); const p = window.__live; return { callouts, chunks: p?p.chunks.length:0, errors: p?p.errors:[], bodyHead: document.body.innerText.slice(220, 420) }; })()" $false 20
  $st | ConvertTo-Json -Depth 5 -Compress
}

for ($i = 9; $i -le $Seconds; $i++) {
  Start-Sleep -Seconds 1
  if ($i % 10 -eq 0) {
    try { $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15 } catch { continue }
    Write-Host ("  t={0}s chunks={1} mean={2} peak={3}" -f $i, $snap.chunks, $snap.lastMean, $snap.lastPeak)
  }
}

Write-Host "=== 5. 汇总 ==="
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress
$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-click-chunks-$stamp.json"
$chunks | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $chunkFile -Encoding utf8
@{
  at = (Get-Date -Format o)
  kind = "loopback-via-real-click"
  buttonClick = $rect
  final = $final
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-click-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-click-$stamp.json")"
Close-Cdp $s
