// 只读复核：音频时间轴是否「快于墙钟」，以及快多少。
// 判据：会话的 speech_intervals 跨度 > 会话墙钟 > 5% 即为异常。
// 成因假设：切片器按「输出样本数/16000」推进时间戳，但 48kHz 设备的真实输入
// 采样数与之存在偏移；若某次 push 的输入样本数与时间不同步累积，音频时钟会漂移。
const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true });

console.log("短名 | 墙钟s | 音频跨度s | 比值 | 异常");
console.log("-".repeat(60));
const rows = [];
for (const s of db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions").all()) {
  if (!s.ended_at_iso) continue;
  const wall = (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000;
  if (wall < 1) continue;
  const iv = db.prepare("SELECT MAX(end_ms) AS m FROM speech_intervals WHERE session_id = ?").get(s.id);
  const audio = (iv.m ?? 0) / 1000;
  if (audio === 0) continue;
  const ratio = audio / wall;
  const bad = ratio > 1.05;
  rows.push({ short: s.id.slice(0, 8), wall, audio, ratio, bad });
  console.log(
    `${s.id.slice(0, 8)} | ${wall.toFixed(0).padStart(5)} | ${audio.toFixed(0).padStart(8)} | ${ratio.toFixed(2).padStart(5)} | ${bad ? "★ 音频快于墙钟" : "正常"}`,
  );
}
const bad = rows.filter((r) => r.bad);
console.log(`\n有音频的会话: ${rows.length}，其中异常: ${bad.length}`);
if (bad.length) {
  console.log("异常会话每次 ASR 计费基准是墙钟，但库里时间轴更长 → 按时间轴算用量会高估。");
  for (const r of bad) console.log(`  ${r.short}: 高估 ${(r.audio - r.wall).toFixed(0)}s`);
}

// 关键：d61e4b32 与 5970a6d6 都是「只有 1~2 条片段、却有上千个语音区间」的会话。
// 语音区间由 detectSpeechIntervals 从音频包直接产出，与 ASR 无关 —— 它反映的是
// 送了多久音频，而不是 ASR 连了多久。
console.log("\n=== 语音区间 vs 稳态片段（两者的时间轴来源不同）===");
for (const short of ["5970a6d6", "d61e4b32", "b217299a", "2920b432"]) {
  const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE ?").get(short + "%");
  if (!s) continue;
  const wall = ((new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000).toFixed(0);
  const i = db.prepare("SELECT COUNT(*) AS n, MAX(end_ms) AS m FROM speech_intervals WHERE session_id = ?").get(s.id);
  const t = db.prepare("SELECT COUNT(*) AS n, MAX(end_ms) AS m FROM transcript_segments WHERE session_id = ?").get(s.id);
  console.log(`  ${short}: 墙钟${wall}s | 区间 ${i.n}个到${(i.m / 1000).toFixed(0)}s | 片段 ${t.n}个到${((t.m ?? 0) / 1000).toFixed(0)}s`);
}

db.close();
