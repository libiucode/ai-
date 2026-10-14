# 音频时钟当场断言（可被探针脚本 dot-source）
#
# 背景（2026-10-15 实测）：
#   probe-persist5.ps1 同时起了两条采集管线——
#     ① JS_START_LOOPBACK_LIVE 自建 ScriptProcessor，回调里调 sendAudioChunk
#     ② 点 app 的「监听系统声音」按钮，app 自己的 wireStream 也调 sendAudioChunk
#   两条管线都往主进程的 PcmResamplerSlicer 喂音频，切片器按样本数累加 nextStartMs，
#   于是音频时间轴跑到了墙钟的 1.27~1.69 倍（物理上不可能）。
#
#   事后才发现这个问题，代价是两次会话的数据不可用。
#   本模块提供「当场断言」，让下次采集立刻抓到，而不是事后算出来。
#
# 用法：在采样循环里每轮调用 Test-AudioClockRatio

# 读主进程侧音频时间轴（speech_intervals 最大 end_ms）
function Get-AudioTimelineMs {
  param([string]$DbPath = "$env:APPDATA\ai-live-monitor\live-monitor.db", [string]$SessionPrefix = "")
  if (-not (Test-Path $DbPath)) { return $null }
  $node = "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $node)) { return $null }
  $prevElectron = $env:ELECTRON_RUN_AS_NODE
  $env:ELECTRON_RUN_AS_NODE = "1"
  try {
    $code = @"
const Database=require('D:\\ai盯播工具\\app\\node_modules\\better-sqlite3');
const db=new Database(process.argv[2],{readonly:true});
const q=process.argv[3];
const s=db.prepare('SELECT id FROM sessions ORDER BY started_at_iso DESC LIMIT 1').get();
const r=db.prepare('SELECT MAX(end_ms) m, COUNT(*) n FROM speech_intervals WHERE session_id=?').get(s.id);
console.log(JSON.stringify({session:s.id,audioMs:r.m||0,intervals:r.n}));
db.close();
"@
    $tmp = [System.IO.Path]::GetTempFileName() + ".cjs"
    [System.IO.File]::WriteAllText($tmp, $code, (New-Object System.Text.UTF8Encoding($false)))
    $out = & $node $tmp $DbPath $SessionPrefix 2>$null | Select-Object -Last 1
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if (-not $out) { return $null }
    return ($out | ConvertFrom-Json)
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $prevElectron
  }
}

# 当场断言：音频时间轴增量 vs 墙钟增量
# 返回 @{ ok; ratio; audioMs; wallSec; message }
function Test-AudioClockRatio {
  param(
    [double]$WallSec,                 # 墙钟已过去秒数
    [double]$AudioMs,                 # 主进程侧音频时间轴（毫秒）
    [double]$Threshold = 1.1,         # 超过即报警
    [double]$MinWallSec = 20          # 太早不判（初始化阶段抖动大）
  )
  if ($WallSec -lt $MinWallSec) {
    return @{ ok = $true; ratio = $null; audioMs = $AudioMs; wallSec = $WallSec; message = "样本不足，跳过" }
  }  $audioSec = $AudioMs / 1000.0
  $ratio = $audioSec / $WallSec
  $ok = $ratio -le $Threshold
  # 注意：PowerShell 哈希字面量里不能直接写 if 表达式作值，必须先算好变量
  $msg = if ($ok) {
    "音频时钟正常（比值 $([Math]::Round($ratio,2)) ≤ $Threshold）"
  } else {
    "!!! 音频时钟快于墙钟：比值 $([Math]::Round($ratio,2)) > $Threshold（音频 $([Math]::Round($audioSec,0))s / 墙钟 $([Math]::Round($WallSec,0))s）。可能原因：双管线重复喂音频。请检查是否同时起了 JS_START_LOOPBACK_LIVE 和 app 按钮两条采集路径。"
  }
  return @{
    ok = $ok
    ratio = [Math]::Round($ratio, 3)
    audioMs = $AudioMs
    wallSec = [Math]::Round($WallSec, 1)
    message = $msg
  }
}

# 双管线静态检查：扫脚本里是否同时出现两种采集入口
# 注意：要排除注释里的提及——本修复在注释中解释了双管线事故，
# 若不排除会把「说明文字」误判成「实际调用」，产生假阳性。
function Test-DualPipelineRisk {
  param([string]$ScriptPath)
  if (-not (Test-Path $ScriptPath)) { return @{ risk = $false; reason = "脚本不存在" } }
  $lines = [System.IO.File]::ReadAllLines($ScriptPath, [System.Text.Encoding]::UTF8)
  # 去掉整行注释（# 开头）与行内注释（# 之后），只看可执行代码
  $code = ($lines | ForEach-Object {
    $l = $_
    $hash = $l.IndexOf('#')
    if ($hash -ge 0) { $l = $l.Substring(0, $hash) }
    $l
  }) -join "`n"

  # 只看「实际调用」，不看字符串字面量里的名字
  $callsJsLib = $code -match 'Invoke-CdpEval\s+\$s\s+\$JS_START_LOOPBACK_LIVE'
  $clicksBtn = $code -match '监听系统声音'
  if ($callsJsLib -and $clicksBtn) {
    return @{
      risk = $true
      reason = "同时调用 JS_START_LOOPBACK_LIVE（自建管线）和 app 按钮（原生管线），两条都会调 sendAudioChunk → 音频被送两遍。改用其中一条。"
    }
  }
  return @{ risk = $false; reason = "单一采集入口" }
}
