param(
  [int]$Port = 9230,
  [int]$DurationSec = 300,
  [int]$IntervalSec = 10,
  [int]$SwitchAtSec = 0,
  [string]$SwitchToName = "",
  [string]$OutDir = "D:\ai盯播工具\app\evidence",
  [string]$WavPath = "D:\asrbench-audio\merged.wav"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\cdp-lib.ps1", [System.Text.Encoding]::UTF8).Replace('$script:CdpPort = 9222', "`$script:CdpPort = $Port")))
. ([scriptblock]::Create([System.IO.File]::ReadAllText("$PWD\scripts\audio-device.ps1", [System.Text.Encoding]::UTF8)))

$s = $null
for ($a = 0; $a -lt 4; $a++) { try { $s = Connect-CdpPage -UrlPart "index.html" -Port $Port; break } catch { Start-Sleep -Seconds 3 } }
if ($null -eq $s) { throw "连不上 CDP $Port" }
Write-Host "attach: $($s.Page)"

$appProc = Get-CimInstance Win32_Process -Filter "Name like '%electron%'" |
  Where-Object { $_.CommandLine -like "*ai盯播工具\app --no-sandbox*" -and $_.CommandLine -like "*$Port*" } | Select-Object -First 1
$appPid = if ($appProc) { $appProc.ProcessId } else { 0 }
Write-Host "app PID=$appPid"

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
    if ($pr) {
      $ws += $pr.WorkingSet64
      try { $cpu += $pr.TotalProcessorTime.TotalSeconds } catch { }
      $n++
    }
  }
  return @{ procs = $n; workingSetMB = [Math]::Round($ws / 1MB, 1); cpuSec = [Math]::Round($cpu, 2) }
}

Write-Host "=== 1. 装观测器 ==="
$null = Invoke-CdpEval $s @'
(() => {
  window.__p = { t0: Date.now(), events: [], ctxs: [] };
  const p = window.__p;
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => p.events.push({ t: Date.now() - p.t0, type: "devicechange" }));
  }
  return true;
})()
'@ $false 20

# 关键：userGesture:true + 同一次表达式内完成 getDisplayMedia → ScriptProcessor → sendAudioChunk。
# 这台实例没开手势旁路，所以必须走这条路（b.click() 的后续微任务拿不到手势）。
Write-Host "=== 2. 建会话 + 起常驻 loopback（单表达式，userGesture:true）==="
$start = Invoke-CdpEval $s $JS_START_LOOPBACK_LIVE $true 60
Write-Host "  $($start | ConvertTo-Json -Compress)"
if (-not $start.ok) { Write-Host "!!! loopback 启动失败"; Close-Cdp $s; exit 3 }

# 通过 UI 建 app 会话（这样 orchestrator.status=active，音频才不会被 ingestAudio 丢掉）
Write-Host "=== 3. 通过 app 按钮建会话（让 status=active）==="
$null = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='监听系统声音'); if(b) b.click(); return true; })()" $true 30
Start-Sleep -Seconds 3
$sid = Invoke-CdpEval $s "(() => (document.body.innerText.match(/会话\s*([0-9a-zA-Z]+)/)||[])[1] || null)" $false 20
$chip = Invoke-CdpEval $s "(() => { const c=Array.from(document.querySelectorAll('.chip')).find(x=>/采集/.test(x.textContent)); return c?c.textContent.trim():null; })()" $false 20
Write-Host "  sessionId=$sid  captureChip=$chip"

Write-Host "=== 4. 起播放源 ==="
$player = Start-Process -FilePath "ffplay" -ArgumentList "-nodisp","-loop","0","-loglevel","quiet","`"$WavPath`"" -PassThru -WindowStyle Hidden
Write-Host "  ffplay PID=$($player.Id)"

$probe = @'
(() => {
  const p = window.__p || { events: [], t0: Date.now(), contextStates: [] };
  const live = window.__live || {};
  const chunks = live.chunks || [];
  const last = chunks.length ? chunks[chunks.length - 1] : null;
  // AudioContext 状态
  const ctxState = live.ctxState || (typeof live.ctxStateOf === "function" ? live.ctxStateOf() : null);
  const chip = (k) => { const c = Array.from(document.querySelectorAll('.chip')).find(x=>new RegExp(k).test(x.textContent)); return c?c.textContent.trim():null; };
  const t = document.body.innerText;
  return {
    chunks: chunks.length,
    lastMean: last ? last.mean : null,
    lastPeak: last ? last.peak : null,
    lastChunkT: last ? last.t : null,
    nonzeroPackets: chunks.filter(c => c.mean > 1e-9).length,
    zeroPackets: chunks.filter(c => c.mean <= 1e-9).length,
    trackEnded: (live.errors || []).some(e => /ended/i.test(e)),
    errors: (live.errors || []).slice(-3),
    captureChip: chip("采集"), asrChip: chip("ASR"), lastFinalChip: chip("最后稳态"),
    timer: (t.match(/监听时长\s*([0-9:]+)/)||[])[1] || null,
    finals: Number((t.match(/稳态片段数\s*(\d+)/)||[])[1] || 0),
    source: (t.match(/音源\s*(麦克风|系统声音)/)||[])[1] || null,
    callouts: Array.from(document.querySelectorAll('.callout,.callout-danger,.callout-warn')).map(e=>e.textContent.trim().slice(0,60)),
    events: p.events.slice(),
    pageAliveMs: Date.now() - p.t0
  };
})()
'@

$rows = @()
$memBase = Get-TreeMem -RootPid $appPid
$wallStart = Get-Date
$switched = $false
$switchResult = $null
$ticks = [Math]::Ceiling($DurationSec / $IntervalSec)

Write-Host "=== 5. 采样 $DurationSec 秒（每 ${IntervalSec}s）==="
for ($i = 1; $i -le $ticks; $i++) {
  Start-Sleep -Seconds $IntervalSec
  $elapsed = ((Get-Date) - $wallStart).TotalSeconds
  $st = $null
  try { $st = Invoke-CdpEval $s $probe $false 20 }
  catch {
    Write-Host "  [$i] eval 失败: $($_.Exception.Message.Substring(0,[Math]::Min(60,$_.Exception.Message.Length)))"
    try { $s = Connect-CdpPage -UrlPart "index.html" -Port $Port } catch { }
  }

  if ($SwitchAtSec -gt 0 -and -not $switched -and $elapsed -ge $SwitchAtSec -and $SwitchToName -ne "") {
    $switched = $true
    $devs = Get-AudioDevices -Kind playback
    $cur = $devs | Where-Object { $_.IsDefault } | Select-Object -First 1
    $target = $devs | Where-Object { $_.Name -like "*$SwitchToName*" } | Select-Object -First 1
    Write-Host "  >>> 切默认输出：$($cur.Name) → $($target.Name)"
    if ($target) {
      try {
        $codes = Set-DefaultAudioDevice -DeviceId $target.Id -Kind playback
        $after = (Get-AudioDevices -Kind playback | Where-Object { $_.IsDefault } | Select-Object -First 1).Name
        $switchResult = @{ from = $cur.Name; to = $after; roleCodes = $codes; atSec = [Math]::Round($elapsed,1) }
        Write-Host "  >>> 切换后默认 = $after"
      } catch {
        $switchResult = @{ from = $cur.Name; error = $_.Exception.Message.Substring(0,120); atSec = [Math]::Round($elapsed,1) }
        Write-Host "  >>> 切换失败: $($_.Exception.Message.Substring(0,100))"
      }
    }
  }

  $mem = Get-TreeMem -RootPid $appPid
  $rows += [pscustomobject]@{
    sec = [Math]::Round($elapsed,1); i = $i
    chunks = if ($st) { $st.chunks } else { $null }
    lastMean = if ($st) { $st.lastMean } else { $null }
    lastPeak = if ($st) { $st.lastPeak } else { $null }
    nonzero = if ($st) { $st.nonzeroPackets } else { $null }
    zero = if ($st) { $st.zeroPackets } else { $null }
    timer = if ($st) { $st.timer } else { $null }
    finals = if ($st) { $st.finals } else { $null }
    captureChip = if ($st) { $st.captureChip } else { $null }
    asrChip = if ($st) { $st.asrChip } else { $null }
    memMB = $mem.workingSetMB
    callouts = if ($st) { ($st.callouts -join "|") } else { $null }
    events = if ($st -and $st.events) { ($st.events | ForEach-Object { "$($_.type)@$($_.t)" }) -join "," } else { "" }
  }
  Write-Host ("  [{0,3}s] chunks={1,-5} mean={2,-9} zero={3,-4} finals={4,-3} capture={5,-10} mem={6}MB" -f `
    $rows[-1].sec, $rows[-1].chunks, $(if($rows[-1].lastMean){"{0:N5}" -f $rows[-1].lastMean}else{"-"}), $rows[-1].zero, $rows[-1].finals, $rows[-1].captureChip, $rows[-1].memMB)
}

Write-Host "=== 6. 收尾 ==="
try { if (-not $player.HasExited) { $player.Kill() } } catch { }
Start-Sleep -Seconds 2
$finalSt = Invoke-CdpEval $s $probe $false 20
$memEnd = Get-TreeMem -RootPid $appPid

# 不断开 __live（常驻测试要看它还在不在），但结束 app 会话以 flush
$endBtn = Invoke-CdpEval $s "(() => { const b = Array.from(document.querySelectorAll('button')).find(x=>/结束/.test(x.textContent)); if(!b) return null; b.click(); return {clicked:true}; })()" $true 30
Write-Host "  结束会话: $($endBtn | ConvertTo-Json -Compress)"

$memFirst = ($rows | Where-Object { $_.memMB } | Select-Object -First 1).memMB
$memLast = ($rows | Where-Object { $_.memMB } | Select-Object -Last 1).memMB
$durMin = [Math]::Round($DurationSec/60, 2)
$totalChunks = if ($rows[-1].chunks) { $rows[-1].chunks } else { 0 }
$totalZero = if ($rows[-1].zero) { $rows[-1].zero } else { 0 }
$finalEvents = if ($rows[-1].events) { $rows[-1].events } else { "" }

$summary = [pscustomobject]@{
  时长秒 = $DurationSec
  sessionId = $sid
  采样次数 = $ticks
  总chunk数 = $totalChunks
  全零chunk数 = $totalZero
  非零chunk数 = $totalChunks - $totalZero
  稳态片段_起 = ($rows | Select-Object -First 1).finals
  稳态片段_末 = ($rows | Select-Object -Last 1).finals
  采集chip_末 = ($rows | Select-Object -Last 1).captureChip
  ASRchip_末 = ($rows | Select-Object -Last 1).asrChip
  trackEnded事件 = if ($finalSt) { $finalSt.trackEnded } else { $null }
  内存_起MB = $memFirst
  内存_末MB = $memLast
  内存增长MB = if ($memFirst -and $memLast) { [Math]::Round($memLast - $memFirst, 1) } else { $null }
  切设备 = if ($switchResult) { "$($switchResult.from) → $($switchResult.to) @$($switchResult.atSec)s" } else { "未切" }
  devicechange事件 = $finalEvents
  callout_末 = ($rows | Select-Object -Last 1).callouts
}
$summary | Format-List

$extrap = if ($memFirst -and $memLast -and $durMin -gt 0) { [Math]::Round(($memLast - $memFirst) * (480 / $durMin), 1) } else { $null }
Write-Host "=== 7. 8 小时外推（线性，仅参考）==="
Write-Host "  $durMin 分钟增长 $($summary.内存增长MB) MB → 8 小时约 $extrap MB"

$resultFile = Join-Path $OutDir "persist5-$stamp.json"
@{
  at = (Get-Date -Format o); port = $Port; appPid = $appPid; sessionId = $sid
  durationSec = $DurationSec; intervalSec = $IntervalSec
  switchResult = $switchResult
  summary = $summary; projected8hGrowthMB = $extrap
  finalState = $finalSt; timeline = $rows
} | ConvertTo-Json -Depth 8 | Set-Content -Path $resultFile -Encoding utf8
Write-Host "证据 $resultFile"
Close-Cdp $s
