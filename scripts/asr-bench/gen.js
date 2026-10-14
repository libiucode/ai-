// 生成真实中文语音 WAV（直播口语风格，含网络用语/品牌词/口头禅）
// 用 Windows 内置中文 TTS（Microsoft Huihui）合成，16kHz 单声道 16bit PCM WAV。
// 用途：ASR 真实音频联调的音源（真实语音信号，非合成正弦波）。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const outDir = process.argv[2] || "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";
const scriptFile = process.argv[3] || "D:\\ai盯播工具\\app\\scripts\\asr-bench\\live-scripts.txt";

fs.mkdirSync(outDir, { recursive: true });
const lines = fs
  .readFileSync(scriptFile, "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

// PowerShell 片段：把 $env:WAV_TEXT 合成到 $env:WAV_OUT。
const PS = [
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  '$v = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -eq "zh-CN" } | Select-Object -First 1',
  'if (-not $v) { throw "no zh-CN voice" }',
  "$synth.SelectVoice($v.VoiceInfo.Name)",
  "$synth.Rate = 0",
  "$fs = [System.IO.File]::Create($env:WAV_OUT)",
  "$synth.SetOutputToWaveStream($fs)",
  "$synth.Speak([string]$env:WAV_TEXT)",
  "$synth.SetOutputToNull()",
  "$fs.Dispose()",
].join("\r\n");

let i = 0;
for (const line of lines) {
  i++;
  const p = path.join(outDir, "seg-" + String(i).padStart(3, "0") + ".wav");
  const env = { ...process.env, WAV_OUT: p, WAV_TEXT: line };
  execFileSync("powershell.exe", ["-NoProfile", "-STA", "-Command", PS], { env, stdio: "pipe" });
  const size = fs.statSync(p).size;
  const sec = Math.round(((size - 44) / 32000) * 10) / 10;
  console.log("seg-" + String(i).padStart(3, "0") + ".wav  " + sec + "s  " + line.length + "chars");
}
console.log("TOTAL=" + i);
