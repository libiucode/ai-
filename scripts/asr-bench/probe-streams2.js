/**
 * 更可靠的直播源探测 v2。
 * v1 的问题：-t 5 对直播流太短，volumedetect 在流还没稳定时就结束，
 * 导致大量 NO_SAMPLES（音频轨明明存在）。
 *
 * v2 做法：直接解码 8 秒到 s16le PCM，从字节层面统计真实音量。
 * 有音频轨 + PCM 字节里有明显非零样本 = 真的在播且有声。
 *
 * 用法：node probe-streams2.js <m3u文件> [最多测几个] [每个测几秒]
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const M3U = process.argv[2] || "D:\\ai盯播工具\\app\\scripts\\asr-bench\\cn.m3u";
const MAX = Number(process.argv[3] || "10");
const SECONDS = Number(process.argv[4] || "8");
const FFMPEG = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";
const OUT = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\probe-pcm";
fs.mkdirSync(OUT, { recursive: true });

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

// 优先中文新闻/综合频道（持续人声，非音乐台）
const score = (n) =>
  (/CCTV-1|CCTV-13|新闻|综合/.test(n) ? 3 : 0) +
  (/卫视/.test(n) ? 2 : 0) +
  (/CCTV/.test(n) ? 1 : 0) -
  (/音乐|Music|少儿|Children|体育|Sport/i.test(n) ? 3 : 0);
const pool = [...entries].sort((a, b) => score(b.name) - score(a.name)).slice(0, MAX);

console.log(`testing ${pool.length} streams, ${SECONDS}s each\n`);
const ok = [];
for (const e of pool) {
  const pcmFile = `${OUT}\\probe.raw`;
  const t0 = Date.now();
  let verdict = "?", detail = "";
  try {
    const r = spawnSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-rw_timeout", "15000000",
      "-i", e.url,
      "-t", String(SECONDS),
      "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-y", pcmFile,
    ], { timeout: 40000, encoding: "utf8" });

    if (r.status !== 0 && !fs.existsSync(pcmFile)) {
      verdict = "FAIL";
      detail = String(r.stderr || "").split("\n").filter(Boolean).pop()?.slice(0, 80) || "no output";
    } else {
      const buf = fs.readFileSync(pcmFile);
      if (buf.length < 16000) {
        verdict = "TOO_SHORT";
        detail = `${buf.length} bytes`;
      } else {
        // 统计 16bit LE 样本：均值绝对值 + 峰值
        let sum = 0, peak = 0, nonzero = 0;
        const n = Math.floor(buf.length / 2);
        for (let i = 0; i < n; i++) {
          const s = Math.abs(buf.readInt16LE(i * 2));
          sum += s; if (s > peak) peak = s; if (s > 64) nonzero++;
        }
        const mean = sum / n, peakPct = peak / 32768, nzPct = (nonzero / n) * 100;
        const sec = (buf.length / 2 / 16000).toFixed(1);
        detail = `${sec}s mean=${mean.toFixed(0)} peak=${(peakPct * 100).toFixed(1)}% nz=${nzPct.toFixed(0)}%`;
        if (mean < 3 && peak < 200) verdict = "SILENT";
        else if (nzPct < 2) verdict = "MOSTLY_SILENT";
        else verdict = "OK";
      }
    }
  } catch (err) {
    verdict = "FAIL";
    detail = String(err.message || err).split("\n")[0].slice(0, 80);
  }
  const ms = Date.now() - t0;
  console.log(`${verdict.padEnd(14)} ${String(ms).padStart(6)}ms  ${e.name.slice(0, 30).padEnd(30)} ${detail}`);
  if (verdict === "OK") ok.push({ ...e, probe: detail, seconds: SECONDS });
}

console.log(`\n===== PLAYABLE (${ok.length}) =====`);
for (const o of ok) console.log(`${o.name}\n  ${o.url}\n  ${o.probe}`);
fs.writeFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\playable-streams.json", JSON.stringify(ok, null, 2));
