# 生成真实中文语音 WAV（直播口语风格，含网络用语/品牌词/口头禅）
# Windows 内置中文 TTS（Microsoft Huihui）合成，16kHz 单声道 16bit PCM WAV。
# 用途：ASR 真实音频联调音源。参数：args[0]=输出目录，args[1]=脚本文本文件。
$OutDir = $args[0]
if (-not $OutDir) { $OutDir = "D:\ai盯播工具\app\scripts\asr-bench\audio" }
$ScriptFile = $args[1]
if (-not $ScriptFile) { $ScriptFile = "D:\ai盯播工具\app\scripts\asr-bench\live-scripts.txt" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path -LiteralPath $ScriptFile)) { throw ("scripts not found: " + $ScriptFile) }

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -eq "zh-CN" } | Select-Object -First 1
if (-not $voice) { throw "no zh-CN TTS voice" }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = 0

function Save-Wav([string]$text, [string]$path) {
  $fs = [System.IO.File]::Create($path)
  try {
    $synth.SetOutputToWaveStream($fs)
    $synth.Speak($text)
    $synth.SetOutputToNull()
  } finally { $fs.Dispose() }
}

$list = @(Get-Content -LiteralPath $ScriptFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
$i = 0
foreach ($s in $list) {
  $i++
  $p = Join-Path $OutDir ("seg-{0:d3}.wav" -f $i)
  Save-Wav $s $p
  $fi = Get-Item -LiteralPath $p
  $sec = [math]::Round(($fi.Length - 44) / 32000, 1)
  Write-Output ("{0}  {1}s  {2}chars" -f $fi.Name, $sec, $s.Length)
}
Write-Output ("TOTAL_SEGMENTS=" + $i)
