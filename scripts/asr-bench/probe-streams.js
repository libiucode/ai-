/**
 * 探测 IPTV 直播源可用性：用 ffprobe 拉 5 秒，检查是否有真实音频轨且解码出非静音样本。
 * 只读探测，不播放。
 * 用法：node probe-streams.js <m3u文件> [最多测几个]
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const M3U = process.argv[2] || "D:\\ai盯播工具\\app\\scripts\\asr-bench\\cn.m3u";
const MAX = Number(process.argv[3] || "12");
const FFPROBE = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffprobe.exe";
const FFMPEG = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";

const text = fs.readFileSync(M3U, "utf8");
const lines = text.split(/\r?\n/);
const entries = [];
for (let i = 0; i < lines.length; i++) {
  if (/^#EXTINF/.test(lines[i])) {
    const name = (lines[i].split(",").pop() || "").trim();
    const url = (lines[i + 1] || "").trim();
    if (/^https?:/.test(url)) entries.push({ name, url });
  }
}

// 优先挑主流中文频道（大概率有持续人声）
const preferred = entries.filter((e) => /CCTV|卫视|新闻|Radio|广播|TV$/i.test(e.name));
const pool = (preferred.length >= MAX ? preferred : entries).slice(0, MAX);

console.log("testing", pool.length, "streams\n");
const ok = [];
for (const e of pool) {
  const t0 = Date.now();
  let verdict = "?";
  let detail = "";
  try {
    // 1. 检查音频轨
    const probe = execFileSync(FFPROBE, [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,channels,sample_rate",
      "-of", "csv=p=0", "-timeout", "8000000", e.url,
    ], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!probe) { verdict = "NO_AUDIO"; }
    else {
      // 2. 解码 5 秒，测平均音量（volumedetect）
      const vol = execFileSync(FFMPEG, [
        "-v", "error", "-t", "5", "-i", e.url,
        "-vn", "-af", "volumedetect", "-f", "null", "-",
      ], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
      const mean = (vol.match(/mean_volume:\s*(-?[\d.]+)\s*dB/) || [])[1];
      const max = (vol.match(/max_volume:\s*(-?[\d.]+)\s*dB/) || [])[1];
      if (mean === undefined) verdict = "NO_SAMPLES";
      else if (Number(mean) < -70) verdict = "SILENT";
      else { verdict = "OK"; detail = `mean=${mean}dB max=${max}dB`; }
      detail = (probe + " | " + detail).trim();
    }
  } catch (err) {
    verdict = "FAIL";
    detail = String(err.message || err).split("\n")[0].slice(0, 90);
  }
  const ms = Date.now() - t0;
  console.log(`${verdict.padEnd(10)} ${String(ms).padStart(6)}ms  ${e.name.slice(0, 34).padEnd(34)} ${detail}`);
  if (verdict === "OK") ok.push({ ...e, probe: detail });
}
console.log("\n===== PLAYABLE (" + ok.length + ") =====");
for (const o of ok) console.log(`${o.name}\n  ${o.url}\n  ${o.probe}`);
fs.writeFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\playable-streams.json", JSON.stringify(ok, null, 2));
