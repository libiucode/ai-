param(
  [int]$Seconds = 20,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8)))

$sig = @'
using System;
using System.Runtime.InteropServices;
public class Hw33 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LDOWN = 0x0002;
  public const uint LUP = 0x0004;
  public static void Click(IntPtr h, int pageX, int pageY) {
    POINT origin; origin.X = 0; origin.Y = 0;
    ClientToScreen(h, ref origin);
    int sx = origin.X + pageX;
    int sy = origin.Y + pageY;
    SetForegroundWindow(h);
    ShowWindow(h, 9);
    System.Threading.Thread.Sleep(400);
    SetCursorPos(sx, sy);
    System.Threading.Thread.Sleep(120);
    mouse_event(LDOWN, sx, sy, 0, 0);
    System.Threading.Thread.Sleep(60);
    mouse_event(LUP, sx, sy, 0, 0);
  }
}
'@
if (-not ("Hw33" -as [type])) { Add-Type -TypeDefinition $sig }

$s = Connect-CdpPage -UrlPart "index.html"
Write-Host "=== 1. 探针 ==="
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

$app = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" | Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" } | Select-Object -First 1
$h = (Get-Process -Id $app.ProcessId).MainWindowHandle

$micRect = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='开始麦克风监听'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()" $false 20
Write-Host "=== 2. 对照：先点麦克风（验证坐标换算） ==="
Write-Host "  麦克风按钮页面坐标: $($micRect | ConvertTo-Json -Compress)"
$null = [Hw33]::Click($h, $micRect.x, $micRect.y)
Start-Sleep -Seconds 4
$st1 = Invoke-CdpEval $s "(() => ({ timer: (document.body.innerText.match(/监听时长\s*([0-9:]+)/)||[])[1], chunks: window.__live?window.__live.chunks.length:0, rate: window.__live?window.__live.sampleRate:null, lastMean: window.__live&&window.__live.chunks.length?window.__live.chunks[window.__live.chunks.length-1].mean:null, callout: (Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim())[0]||'').slice(0,60) }))()" $false 20
Write-Host "  点击后: $($st1 | ConvertTo-Json -Compress)"

if ($st1.chunks -gt 0) {
  Write-Host "  → 坐标换算正确，麦克风链路通！继续采 $Seconds 秒"
  for ($i = 5; $i -le $Seconds; $i++) {
    Start-Sleep -Seconds 1
    if ($i % 5 -eq 0) {
      $snap = Invoke-CdpEval $s $JS_PROBE_SNAP $false 15
      Write-Host ("  t={0}s chunks={1} mean={2} peak={3}" -f $i, $snap.chunks, $snap.lastMean, $snap.lastPeak)
    }
  }
}

Write-Host "=== 3. 汇总麦克风 ==="
$finalMic = Invoke-CdpEval $s $JS_PROBE_FINAL $false 40
$finalMic | ConvertTo-Json -Depth 8 -Compress
@{
  at = (Get-Date -Format o); kind = "mic-win32-click"; final = $finalMic
  console = @(Invoke-CdpEval $s "(() => (window.__consoleLog||[]).slice())" $false 15)
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir "mic-win32-$stamp.json") -Encoding utf8
Write-Host "证据 $(Join-Path $OutDir "mic-win32-$stamp.json")"
Close-Cdp $s
