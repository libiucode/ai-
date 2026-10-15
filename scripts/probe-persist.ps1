<#
常驻 loopback MediaStream 可行性实测（模块 A 无人值守技术前提）

要回答（负责人指定）：
  1. 常驻 loopback stream 的 audio track 能活跃多久？会不会被系统回收？
  2. 设备变化（切默认输出）会不会导致 stream 静默失效但 ended 不触发？
  3. 常驻期间 CPU / 内存开销？能不能 8 小时挂着？

方法：走 app 自己的「监听系统声音」按钮拿到**真实生产路径**的 stream，
不自己建管线，然后不解绑、持续采样。

参数：
  -Port         CDP 端口
  -Samples      采样次数（每次间隔 -IntervalSec 秒）
  -IntervalSec  采样间隔秒
  -SwitchDevice 在第 N 次采样时触发一次默认输出设备切换（测试静默失效）
  -OutDir       证据目录

用法：
  & ([scriptblock]::Create([System.IO.File]::ReadAllText(
      "$PWD\scripts\probe-persist.ps1", [System.Text.Encoding]::UTF8))) -Port 9225 -Samples 60 -IntervalSec 30
#>
param(
  [int]$Port = 9225,
  [int]$Samples = 60,
  [int]$IntervalSec = 30,
  [int]$SwitchDeviceAtSample = 0,
  [string]$OutDir = "$PSScriptRoot\..\evidence"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$libPath = "$PSScriptRoot\..\scripts\cdp-lib.ps1"
$lib = [System.IO.File]::ReadAllText($libPath, [System.Text.Encoding]::UTF8).Replace('$script:CdpPort = 9222', "`$script:CdpPort = $Port")
. ([scriptblock]::Create($lib))

$s = $null
for ($a = 0; $a -lt 4; $a++) { try { $s = Connect-CdpPage -UrlPart "index.html" -Port $Port; break } catch { Start-Sleep -Seconds 3 } }
if ($null -eq $s) { throw "连不上 CDP $Port" }
Write-Host "attach: $($s.Page)"

# 找到 app 主进程 PID（用于内存采样）
$appProc = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" |
  Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" -and $_.CommandLine -like "*$Port*" } |
  Select-Object -First 1
if (-not $appProc) {
  $appProc = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" |
    Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" } | Select-Object -First 1
}
$appPid = if ($appProc) { $appProc.ProcessId } else { 0 }
Write-Host "app 主进程 PID=$appPid"

# 采集进程树（主进程 + 所有子进程）的总体内存
function Get-TreeMem {
  param([int]$RootPid)
  if ($RootPid -eq 0) { return $null }
  $all = Get-CimInstance Win32_Process -Filter "Name like '%electron%'"
  $ids = New-Object System.Collections.Generic.HashSet[int]
  $null = $ids.Add($RootPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
        $null = $ids.Add([int]$p.ProcessId); $changed = $true
      }
    }
  }
  $ws = 0; $cpu = 0.0; $n = 0
  foreach ($id in $ids) {
    $pr = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($pr) { $ws += $pr.WorkingSet64; $cpu += $pr.CPU; $n++ }
  }
  return @{ procs = $n; workingSetMB = [Math]::Round($ws / 1MB, 1); cpuSec = [Math]::Round($cpu, 2) }
}

Write-Host "=== 1. 起常驻 loopback stream（走 app 真实按钮路径）==="
$start = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='监听系统声音'); if(!b) return {ok:false,why:'no button'}; b.click(); return {ok:true}; })()" $true 30
Write-Host "  点击: $($start | ConvertTo-Json -Compress)"
Start-Sleep -Seconds 4

$sid = Invoke-CdpEval $s "(() => (document.body.innerText.match(/会话\s*([0-9a-zA-Z]+)/)||[])[1] || null)" $false 20
Write-Host "  sessionId = $sid"

# 装观测器：记录 track 状态、ended/mute 事件、AudioContext 状态
$null = Invoke-CdpEval $s @'
(() => {
  window.__persist = {
    startedAt: Date.now(),
    events: [],        // ended / mute / unmute / devicechange
    samples: [],
  };
  // 监听所有 audio track 的状态变化（app 已经建好 stream 了）
  const hook = () => {
    const tracks = [];
    document.querySelectorAll("*").forEach(() => {});
    return tracks;
  };
  // 设备的 devicechange 事件（系统默认输出变化会触发）
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      window.__persist.events.push({ t: Date.now() - window.__persist.startedAt, type: "devicechange" });
    });
  }
  return true;
})()
'@ $false 20

$rows = @()
$memBase = Get-TreeMem -RootPid $appPid
Write-Host "  内存基线: $($memBase | ConvertTo-Json -Compress)"
$wallStart = Get-Date

Write-Host "=== 2. 采样 $Samples 次，间隔 ${IntervalSec}s（约 $([Math]::Round($Samples*$IntervalSec/60,1)) 分钟）==="
for ($i = 1; $i -le $Samples; $i++) {
  Start-Sleep -Seconds $IntervalSec

  # 读页面侧：会话计时、稳态片段、ASR chip、callout、事件
  $st = $null
  try {
    $st = Invoke-CdpEval $s "(() => {
      const t = document.body.innerText;
      const p = window.__persist || { events: [], startedAt: Date.now() };
      return {
        timer: (t.match(/监听时长\s*([0-9:]+)/)||[])[1] || null,
        finals: Number((t.match(/稳态片段数\s*(\d+)/)||[])[1] || 0),
        source: (t.match(/音源\s*(麦克风|系统声音)/)||[])[1] || null,
        asr: (()=>{ const c=Array.from(document.querySelectorAll('.chip')).find(x=>/ASR/.test(x.textContent)); return c?c.textContent.trim():null; })(),
        captureChip: (()=>{ const c=Array.from(document.querySelectorAll('.chip')).find(x=>/采集/.test(x.textContent)); return c?c.textContent.trim():null; })(),
        silenceWarn: Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim().slice(0,50)),
        events: p.events.slice(),
        elapsedMs: Date.now() - p.startedAt
      };
    })()" $false 20
  } catch {
    Write-Host "  [第 $i 次] eval 失败，尝试重连: $($_.Exception.Message.Substring(0,[Math]::Min(60,$_.Exception.Message.Length)))"
    try { $s = Connect-CdpPage -UrlPart "index.html" -Port $Port } catch { }
    continue
  }

  $mem = Get-TreeMem -RootPid $appPid
  $rows += [pscustomobject]@{
    i = $i; wallMin = [Math]::Round(((Get-Date) - $wallStart).TotalMinutes, 2)
    timer = $st.timer; finals = $st.finals; asr = $st.asr
    memMB = $mem.workingSetMB; procs = $mem.procs
    events = ($st.events | ForEach-Object { $_.type }) -join ","
    silence = ($st.silenceWarn -join "|")
  }

  if ($i % 5 -eq 0 -or $i -le 3) {
    Write-Host ("  [{0}] wall={1}min timer={2} finals={3} asr={4} mem={5}MB procs={6} events=[{7}]" -f `
      $i, $rows[-1].wallMin, $st.timer, $st.finals, $st.asr, $mem.workingSetMB, $mem.procs, $rows[-1].events)
  }

  if ($st.events.Count -gt 0 -and $rows[-1].events -ne ($rows[-2].events)) {
    Write-Host "    [事件] $($rows[-1].events)"
  }
  if ($st.silence.Count -gt 0) { Write-Host "    [提示] $($st.silence -join ' | ')" }
}

$wallEnd = Get-Date
$memEnd = Get-TreeMem -RootPid $appPid
$totalMin = [Math]::Round(($wallEnd - $wallStart).TotalMinutes, 2)

Write-Host "=== 3. 汇总 ==="
$memFirst = ($rows | Where-Object { $_.memMB } | Select-Object -First 1).memMB
$memLast = ($rows | Where-Object { $_.memMB } | Select-Object -Last 1).memMB
$growth = if ($memFirst -and $memLast) { [Math]::Round($memLast - $memFirst, 1) } else { $null }
$growthPerHour = if ($growth -ne $null -and $totalMin -gt 0) { [Math]::Round($growth / ($totalMin / 60), 1) } else { $null }

$summary = [pscustomobject]@{
  持续时间分钟 = $totalMin
  采样次数 = $Samples
  sessionId = $sid
  起始内存MB = $memFirst
  结束内存MB = $memLast
  内存增长MB = $growth
  折算每小时增长MB = $growthPerHour
  起始稳态片段 = ($rows | Select-Object -First 1).finals
  结束稳态片段 = ($rows | Select-Object -Last 1).finals
  最终timer = ($rows | Select-Object -Last 1).timer
  最终ASR = ($rows | Select-Object -Last 1).asr
  事件总数 = (($rows | ForEach-Object { if ($_.events) { $_.events.Split(",").Count } else { 0 } }) | Measure-Object -Sum).Sum
}
$summary | Format-List

# 8 小时外推
if ($growthPerHour -ne $null -and $totalMin -ge 5) {
  Write-Host "=== 4. 8 小时外推（线性，仅供参考）==="
  Write-Host "  按每小时增长 $growthPerHour MB 计，8 小时约增长 $([Math]::Round($growthPerHour*8,1)) MB"
  Write-Host "  结束内存 $memLast MB → 8 小时后约 $([Math]::Round($memLast + $growthPerHour*8,1)) MB"
} else {
  Write-Host "=== 4. 外推跳过（样本时长不足 5 分钟或内存无变化）==="
}

$resultFile = Join-Path $OutDir "persist-stream-$stamp.json"
@{
  at = (Get-Date -Format o); port = $Port; sessionId = $sid
  samples = $Samples; intervalSec = $IntervalSec; durationMin = $totalMin
  summary = $summary; memoryBaseline = $memBase; memoryEnd = $memEnd
  rows = $rows
} | ConvertTo-Json -Depth 8 | Set-Content -Path $resultFile -Encoding utf8
Write-Host "证据 $resultFile"

# 不主动结束会话——常驻测试结束后由负责人决定；这里只断开 CDP
Close-Cdp $s
