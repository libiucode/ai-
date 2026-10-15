# 常驻启动 Electron（带 CDP）。本机 PowerShell 对 npx.ps1 有执行策略限制，
# 故直接调用 node_modules\.bin\electron.cmd 或 electron.exe 全路径。
$ErrorActionPreference = "Stop"
$env:ELECTRON_RUN_AS_NODE = $null
$exe = "$PSScriptRoot\..\node_modules\electron\dist\electron.exe"
$appDir = "$PSScriptRoot\.."
$log = "$PSScriptRoot\..\logs-electron.txt"
Set-Content -Path $log -Value ""
$p = Start-Process -FilePath $exe -ArgumentList $appDir, "--no-sandbox", "--remote-debugging-port=9222" -WorkingDirectory $appDir -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
Write-Output "PID=$($p.Id)"
Start-Sleep -Seconds 12
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $r = (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/list" -UseBasicParsing -TimeoutSec 3).Content
    Write-Output "CDP OK: $($r.Length) bytes"
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ok) {
  Write-Output "CDP FAILED"
  Get-Content $log -Tail 20 -ErrorAction SilentlyContinue
  Get-Content "$log.err" -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Select-Object Id, ProcessName | Format-Table -AutoSize
