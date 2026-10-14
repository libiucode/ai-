/**
 * 直播源稳定性对比：每个源连续拉 60 秒，统计丢帧/追播警告与音频连续性。
 * 目的是为 30 分钟长跑挑一个"源本身不丢帧"的源。
 *
 * 判据：
 *   - stderr 里 skipping / corrupt / discontinuity 出现次数（越少越稳）
 *   - 解码出的 PCM 总长 vs 期望时长（缺口越小越稳）
 *   - mean/峰值（确认有声）
 *
 * 用法：node compare-streams.js [每源秒数]
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const SECONDS = Number(process.argv[2] || "60");
const FFMPEG = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";
const OUT = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\probe-pcm";
fs.mkdirSync(OUT, { recursive: true });

// 从 playable-streams.json 取候选
const playable = JSON.parse(fs.readFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\playable-streams.json", "utf8"));
// 再加几个之前没测但可能更稳的
const extra = [
  { name: "CCTV-1 HD (1080p)", url: "http://69.30.245.50/live/cctv1.m3u8" },
  { name: "CCTV-13 HD (1080p)", url: "http://go.bkpcp.top/mg/cctv13" },
];
const seen = new Set();
const candidates = [...playable, ...extra].filter((e) => {
  if (seen.has(e.url)) return false;
  seen.add(e.url);
  return true;
});

console.log(`comparing ${candidates.length} streams, ${SECONDS}s each\n`);
const results = [];
for (const e of candidates) {
  const pcm = `${OUT}\\cmp.raw`;
  try { fs.unlinkSync(pcm); } catch {}
  const t0 = Date.now();
  const r = spawnSync(FFMPEG, [
    "-hide_banner", "-loglevel", "warning",
    "-i", e.url,
    "-t", String(SECONDS),
    "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-y", pcm,
  ], { timeout: (SECONDS + 40) * 1000, encoding: "utf8" });

  const err = String(r.stderr || "");
  const skip = (err.match(/skipping/gi) || []).length;
  const corrupt = (err.match(/corrupt/gi) || []).length;
  const disc = (err.match(/discontinuity/gi) || []).length;
  const httpErr = (err.match(/HTTP error|403|404|timed out|Connection/gi) || []).length;

  let bytes = 0, sec = 0, mean = 0, peak = 0;
  if (fs.existsSync(pcm)) {
    const buf = fs.readFileSync(pcm);
    bytes = buf.length;
    const n = Math.floor(bytes / 2);
    let sum = 0, pk = 0;
    for (let i = 0; i < n; i++) { const s = Math.abs(buf.readInt16LE(i * 2)); sum += s; if (s > pk) pk = s; }
    mean = n ? sum / n : 0; peak = pk;
    sec = bytes / 2 / 16000;
  }
  const gapSec = SECONDS - sec;
  const verdict = (skip + corrupt + disc === 0 && gapSec < 2 && mean > 3) ? "STABLE" : (mean > 3 ? "HAS_WARN" : "BAD");

  results.push({ ...e, skip, corrupt, disc, httpErr, decodedSec: +sec.toFixed(1), gapSec: +gapSec.toFixed(1), mean: Math.round(mean), peak, verdict, wallMs: Date.now() - t0 });
  console.log(
    `${verdict.padEnd(9)} skip=${String(skip).padStart(3)} corrupt=${String(corrupt).padStart(3)} disc=${String(disc).padStart(2)} ` +
    `解码=${String(sec.toFixed(1)).padStart(5)}s(缺${gapSec.toFixed(1)}s) mean=${String(Math.round(mean)).padStart(5)}  ${e.name.slice(0, 26)}`
  );
}

results.sort((a, b) => (a.skip + a.corrupt + a.disc) - (b.skip + b.corrupt + b.disc) || b.mean - a.mean);
console.log("\n===== 排名（丢帧警告最少、音频最强） =====");
for (const r of results) {
  console.log(`${r.verdict.padEnd(9)} warn=${r.skip + r.corrupt + r.disc}  mean=${r.mean}  解码${r.decodedSec}s  ${r.name}`);
  console.log(`          ${r.url}`);
}
fs.writeFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\stream-stability.json", JSON.stringify(results, null, 2));
console.log("\n最稳候选:", results[0]?.name, results[0]?.url);
