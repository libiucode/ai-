// 只读：定位「音频时间轴快于墙钟」的成因。
// 假设 A：预备缓冲补发（≤3s）不足以解释 225s 的差距。
// 假设 B：多次 ASR 连接/暂停恢复后切片器累计未重置。
// 假设 C：speech_intervals 与 transcript_segments 用了不同时间基。
const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true });

const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, status FROM sessions").all();
console.log("会话 | 墙钟 | 音频时间轴 | 音频/墙钟比 | 连接数 | 片段数");
console.log("-".repeat(95));
for (const s of sessions) {
  const wall = s.ended_at_iso ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000 : null;
  const iv = db.prepare("SELECT MAX(end_ms) AS m FROM speech_intervals WHERE session_id = ?").get(s.id);
  const audio = (iv.m ?? 0) / 1000;
  const conns = db.prepare("SELECT COUNT(DISTINCT connection_id) AS c FROM transcript_segments WHERE session_id = ?").get(s.id);
  const segs = db.prepare("SELECT COUNT(*) AS c FROM transcript_segments WHERE session_id = ?").get(s.id);
  if (!wall || wall < 1) continue;
  const ratio = audio / wall;
  const flag = ratio > 1.05 ? "  ← 音频快于墙钟" : "";
  console.log(
    `${s.id.slice(0, 8)} | ${wall.toFixed(0).padStart(5)}s | ${audio.toFixed(0).padStart(6)}s | ${ratio.toFixed(2).padStart(5)} | ${String(conns.c).padStart(4)} | ${String(segs.c).padStart(3)}${flag}`,
  );
}

console.log("\n=== 5970a6d6 明细：区间的时间密度分布 ===");
const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE '5970a6d6%'").get();
const iv = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id = ? ORDER BY start_ms").all(s.id);
// 每 60 秒桶里的区间数，看是否均匀（均匀=真实音频；突然密集=补发）
const buckets = new Map();
for (const r of iv) {
  const b = Math.floor(r.start_ms / 60000);
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
for (const [b, n] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(b * 60).padStart(4)}s ~ ${String((b + 1) * 60).padStart(4)}s: ${"█".repeat(Math.min(60, Math.round(n / 6)))} ${n} 区间`);
}

console.log("\n=== 交叉核对：片段与区间的首尾 ===");
for (const short of ["5970a6d6", "d61e4b32"]) {
  const ss = db.prepare("SELECT id FROM sessions WHERE id LIKE ?").get(short + "%");
  const i = db.prepare("SELECT MIN(start_ms) AS a, MAX(end_ms) AS b FROM speech_intervals WHERE session_id = ?").get(ss.id);
  const t = db.prepare("SELECT MIN(start_ms) AS a, MAX(end_ms) AS b FROM transcript_segments WHERE session_id = ?").get(ss.id);
  const a2 = db.prepare("SELECT start_ms, end_ms FROM analysis_runs WHERE session_id = ?").all(ss.id);
  console.log(`  ${short}: 区间 ${i.a}~${i.b} | 片段 ${t.a}~${t.b} | 分析运行 ${a2.length} 次`);
}

db.close();
