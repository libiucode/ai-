param(
  [int]$Seconds = 20,
  [string]$OutDir = "D:\ai盯播工具\app\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

# Win32 硬件级鼠标输入。CDP 的 Input.dispatchMouseEvent 是合成事件，Chromium 不会
# 把它算作 userGesture（Electron handler 的 request.userGesture 因此为 false）。
# SendInput/mouse_event 走的是真实输入队列，才会产生用户激活。
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Hw32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
}
'@
if (-not ("Hw32" -as [type])) { Add-Type -TypeDefinition $sig }

$s = $null
for ($a = 0; $a -lt 3; $a++) { try { $s = Connect-CdpPage -UrlPart "index.html"; break } catch { Start-Sleep -Seconds 3 } }
if ($null -eq $s) { throw "连不上" }

Write-Host "=== 1. 探针 + console 捕获 ==="
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
$null = Invoke-CdpEval $s $JS_INSTALL_PROBE $false 20

$rect = Invoke-CdpEval $s $JS_FIND_BUTTON $false 20
Write-Host "  按钮: $($rect | ConvertTo-Json -Compress)"

# 取窗口屏幕坐标
$app = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" | Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" } | Select-Object -First 1
$proc = Get-Process -Id $app.ProcessId
$h = $proc.MainWindowHandle
$null = [Hw32]::ShowWindow($h, 9)
$null = [Hw32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Rect32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static int[] WinRect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[]{r.Left, r.Top, r.Right, r.Bottom}; }
}
'@
$wr = [Rect32]::WinRect($h)
Write-Host "  窗口矩形: $($wr -join ',')"
# 按钮是页面坐标 → 屏幕坐标（窗口矩形含边框，页面从 client area 开始）
$clientX = $wr[0] + [int]$rect.x + 8
$clientY = $wr[1] + [int]$rect.y + 31
Write-Host "  屏幕坐标: ($clientX,$clientY)"

Write-Host "=== 2. Win32 硬件级点击 ==="
$null = [Hw32]::SetCursorPos($clientX, $clientY)
Start-Sleep -Milliseconds 120
$null = [Hw32]::mouse_event([Hw32]::MOUSEEVENTF_LEFTDOWN, $clientX, $clientY, 0, 0)
Start-Sleep -Milliseconds 60
$null = [Hw32]::mouse_event([Hw32]::MOUSEEVENTF_LEFTUP, $clientX, $clientY, 0, 0)
Write-Host "  已硬件点击"

Write-Host "=== 3. 观察 15 秒 ==="
$got = 0
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Seconds 1
  try { $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15 } catch { Write-Host "  t=$i eval fail"; continue }
  $consoleLine = ""
  $cl = Invoke-CdpEval $s "(() => { const m = (window.__consoleLog||[]).slice(); return m.length ? m.join(' || ').slice(0,200) : ''; })()" $false 15
  if ($cl) { $consoleLine = " console=$cl" }
  Write-Host ("  t={0}s chunks={1} rate={2} mean={3} peak={4} err={5}{6}" -f $i, $snap.chunks, $snap.rate, $snap.lastMean, $snap.lastPeak, (@($snap.errors) -join '|'), $consoleLine)
  if ($snap.chunks -gt 0) { $got = $snap.chunks; break }
}

Write-Host "=== 4. 汇总 ==="
$final = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$final | ConvertTo-Json -Depth 8 -Compress
$cl2 = Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15
Write-Host "=== console ==="
@($cl2) | ForEach-Object { Write-Host "  $_" }

@{
  at = (Get-Date -Format o)
  kind = "loopback-win32-click"
  buttonClick = $rect
  final = $final
  console = @($cl2)
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "loopback-win32-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "loopback-win32-$stamp.json")"
Close-Cdp $s
