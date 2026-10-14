/**
 * 用 ffmpeg 把指定的 WAV 目录按顺序循环播放到 VB-CABLE Input。
 * 这样 loopback 采集（grab "CABLE Output"）能采到真实的语音信号。
 *
 * 注意：播放侧是「CABLE Input (VB-Audio Virtual Cable)」，
 *       采集侧是「CABLE Output (VB-Audio Virtual Cable)」——同一个虚拟声卡的收发两端。
 *       所以真实扬声器不会出声，不会打扰用户，也不会和别人的麦克风采集冲突。
 *
 * 用法：node play-to-cable.js <音频目录> [循环次数]
 */
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2] || "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";
const loops = Number(process.argv[3] || "0"); // 0 = 一直循环，直到被杀

const FFMPEG = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";

// 先确认 dshow 能不能看到 CABLE Input
try {
  const list = execSync(`"${FFMPEG}" -hide_banner -list_devices true -f dshow -i dummy 2>&1`, { encoding: "utf8" });
  console.log("--- dshow audio devices ---");
  console.log(list.split(/\r?\n/).filter((l) => /Cable|CABLE|Virtual/.test(l)).join("\n") || "(no cable line found)");
} catch (e) {
  console.log("list_devices failed:", e.message.slice(0, 200));
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).sort().map((f) => path.join(dir, f));
if (!files.length) { console.error("no wav in", dir); process.exit(1); }
console.log("files:", files.length);

// 用 concat demuxer 拼成一个长流，循环播放到 CABLE Input
const listFile = path.join(path.dirname(files[0]), "playlist.txt");
const body = [];
for (let i = 0; i < (loops || 100); i++) for (const f of files) body.push("file '" + f.replace(/'/g, "'\\''") + "'");
fs.writeFileSync(listFile, body.join("\n"), "utf8");

const args = [
  "-hide_banner", "-loglevel", "warning",
  "-f", "concat", "-safe", "0", "-i", listFile,
  // 统一成 48k stereo（dshow 声卡的常用格式）
  "-ar", "48000", "-ac", "2",
  "-f", "dshow",
  "-audio_buffer_size", "50",
  "-i", "audio=CABLE Input (VB-Audio Virtual Cable)",
];
// 注意：向 dshow 输入要用 -f dshow 且设备名作为输出，正确写法是把设备放最后
const args2 = [
  "-hide_banner", "-loglevel", "warning",
  "-stream_loop", "-1",
  "-f", "concat", "-safe", "0", "-i", listFile,
  "-ar", "48000", "-ac", "2",
  "-f", "dshow", "audio=CABLE Input (VB-Audio Virtual Cable)",
];

console.log("spawning ffmpeg:", args2.join(" "));
const child = spawn(FFMPEG, args2, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => process.stdout.write("[ffmpeg] " + d));
child.stderr.on("data", (d) => process.stdout.write("[ffmpeg] " + d));
child.on("exit", (c) => { console.log("ffmpeg exited", c); process.exit(c ?? 0); });

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
