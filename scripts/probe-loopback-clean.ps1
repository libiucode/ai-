param(
  [int]$Seconds = 20,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

function Send-Raw {
  param($Session, [string]$Method, $Params, [int]$To = 15)
  $Session.Id++
  $id = $Session.Id
  $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 12 -Compress
  $b = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $b, 0, $b.Length
  try {
    $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(10000)
  } catch {
    Start-Sleep -Seconds 1
    $re = Connect-CdpPage -UrlPart "index.html"
    $Session.Ws = $re.Ws; $Session.Ct = $re.Ct; $Session.Id = 0
    $Session.Id++
    $id = $Session.Id
    $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 12 -Compress
    $b = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $seg = New-Object System.ArraySegment[byte] -ArgumentList $b, 0, $b.Length
    $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(10000)
  }
  $buf = New-Object byte[] 4194304
  $deadline = (Get-Date).AddSeconds($To)
  $sb = New-Object System.Text.StringBuilder
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    try { if (-not $task.Wait(1500)) { continue } } catch { Start-Sleep -Milliseconds 400; continue }
    if ($task.IsFaulted -or $task.IsCanceled) { Start-Sleep -Milliseconds 400; continue }
    $res = $task.Result
    if ($res.MessageType -eq 'Close') { throw "closed" }
    $null = $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    if (-not $res.EndOfMessage) { continue }
    $text = $sb.ToString(); $sb.Clear() | Out-Null
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($null -ne $obj.id -and $obj.id -eq $id) { return $obj }
  }
  return $null
}

$console = New-Object System.Collections.ArrayList
function Drain-Console {
  param($Session)
  $Session.Id++
  $id = $Session.Id
  $payload = @{ id = $id; method = "Runtime.evaluate"; params = @{ expression = "(() => { const m = (window.__consoleLog || []).slice(); window.__consoleLog = []; return m; })()"; returnByValue = $true; awaitPromise = $false } } | ConvertTo-Json -Depth 6 -Compress
  $b = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList $b, 0, $b.Length
  $null = $Session.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Session.Ct).Wait(10000)
  $buf = New-Object byte[] 4194304
  $deadline = (Get-Date).AddSeconds(8)
  $sb = New-Object System.Text.StringBuilder
  while ((Get-Date) -lt $deadline) {
    $rseg = New-Object System.ArraySegment[byte] -ArgumentList $buf, 0, $buf.Length
    $task = $Session.Ws.ReceiveAsync($rseg, $Session.Ct)
    try { if (-not $task.Wait(1500)) { continue } } catch { break }
    if ($task.IsFaulted -or $task.IsCanceled) { break }
    $res = $task.Result
    $null = $sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    if (-not $res.EndOfMessage) { continue }
    $text = $sb.ToString(); $sb.Clear() | Out-Null
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($null -ne $obj.id -and $obj.id -eq $id) {
      foreach ($m in @($obj.result.result.value)) { $null = $console.Add($m) }
      return
    }
  }
}

$s = $null
for ($a = 0; $a -lt 3; $a++) {
  try { $s = Connect-CdpPage -UrlPart "index.html"; break } catch { Write-Host "  连接重试 $a : $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
}
if ($null -eq $s) { throw "连不上 CDP page" }
Write-Host "=== 1. 装 console 捕获 + 探针 ==="
$null = Invoke-CdpEval $s @'
(() => {
  window.__consoleLog = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) {
    console[k] = function(...a) {
      try { window.__consoleLog.push(k + ": " + a.map(x => { try { return (typeof x === "object") ? JSON.stringify(x) : String(x); } catch(e) { return String(x); } }).join(" ")); } catch(e) {}
      orig[k].apply(console, a);
    };
  }
  return true;
})()
'@ $false 20
$null = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20

Write-Host "=== 2. 点击「监听系统声音」==="
$rect = Invoke-CdpEval $s $JS_FIND_BUTTON $false 20
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Win2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
if (-not ("Win2" -as [type])) { Add-Type -TypeDefinition $sig }
$app = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" | Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" } | Select-Object -First 1
if ($app) {
  $h = (Get-Process -Id $app.ProcessId).MainWindowHandle
  if ($h -ne 0) { $null = [Win2]::ShowWindow($h, 9); $null = [Win2]::SetForegroundWindow($h); Start-Sleep -Milliseconds 600 }
}
$x = [int]$rect.x; $y = [int]$rect.y
$null = Send-Raw $s "Input.dispatchMouseEvent" @{ type = "mouseMoved"; x = $x; y = $y }
Start-Sleep -Milliseconds 200
$null = Send-Raw $s "Input.dispatchMouseEvent" @{ type = "mousePressed"; x = $x; y = $y; button = "left"; clickCount = 1 }
Start-Sleep -Milliseconds 80
$null = Send-Raw $s "Input.dispatchMouseEvent" @{ type = "mouseReleased"; x = $x; y = $y; button = "left"; clickCount = 1 }
Write-Host "  已点击 ($x,$y)"

Write-Host "=== 3. 观察 12 秒 ==="
for ($i = 1; $i -le 12; $i++) {
  Start-Sleep -Seconds 1
  Drain-Console $s | Out-Null
  $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
  $callout = Invoke-CdpEval $s "(() => { const c = Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim()); return c.length ? c[0].slice(0,60) : ''; })()" $false 15
  Write-Host ("  t={0}s chunks={1} rate={2} mean={3} peak={4} err={5} callout={6}" -f $i, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak, (@($snap.errors) -join '|'), $callout)
  if ($snap.chunks -gt 0) { break }
}

Write-Host "=== 4. console 输出 ==="
Drain-Console $s | Out-Null
if ($console.Count -gt 0) { $console | ForEach-Object { Write-Host "  $_" } } else { Write-Host "  (无 console 输出)" }

Write-Host "=== 5. 汇总 ==="
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress

# 停会话
try {
  $endBtn = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/结束/.test(x.textContent)); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()" $false 15
  if ($endBtn) {
    $null = Send-Raw $s "Input.dispatchMouseEvent" @{ type = "mousePressed"; x = [int]$endBtn.x; y = [int]$endBtn.y; button = "left"; clickCount = 1 }
    $null = Send-Raw $s "Input.dispatchMouseEvent" @{ type = "mouseReleased"; x = [int]$endBtn.x; y = [int]$endBtn.y; button = "left"; clickCount = 1 }
    Write-Host "  已点结束"
  }
} catch { Write-Host "  结束会话失败: $($_.Exception.Message)" }

$chunks = Invoke-CdpEval $s $JS_DUMP_CHUNKS_LIVE $false 60
$chunkFile = Join-Path $OutDir "loopback-clean-chunks-$stamp.json"
($chunks | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path $chunkFile -Encoding utf8

@{
  at = (Get-Date -Format o)
  kind = "loopback-clean-with-console"
  buttonClick = $rect
  final = $final
  console = @($console)
  chunkFile = $chunkFile
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-clean-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-clean-$stamp.json")"
Close-Cdp $s
