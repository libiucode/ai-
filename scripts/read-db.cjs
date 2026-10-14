// 读 SQLite 验证 transcript_segments 是否真的有对应稳态字幕行。
// 用 Electron 内置 Node 跑（better-sqlite3 ABI 130 匹配）。
const path = require("node:path");
const Database = require(path.join("D:\\ai盯播工具\\app", "node_modules", "better-sqlite3"));

const dbPath = process.argv[2] || path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
console.log("DB:", dbPath);
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("表:", tables.map((t) => t.name).join(", "));

console.log("\n=== sessions（最近 5 场）===");
const cols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
console.log("sessions 列:", cols.join(", "));
const sessions = db.prepare(`SELECT * FROM sessions ORDER BY rowid DESC LIMIT 5`).all();
for (const s of sessions) {
  const t = s.started_at_iso || s.started_at || s.startedAt || s.created_at || "?";
  console.log(`  ${s.id} | ${t} | ${s.status} | ${s.audio_source || s.audioSource || "-"}`);
}

console.log("\n=== transcript_segments 列 ===");
const tcols = db.prepare("PRAGMA table_info(transcript_segments)").all().map((c) => c.name);
console.log(tcols.join(", "));

console.log("\n=== transcript_segments（按场次统计）===");
const counts = db.prepare(
  `SELECT session_id, COUNT(*) AS n, MIN(start_ms) AS min_start, MAX(end_ms) AS max_end
   FROM transcript_segments GROUP BY session_id ORDER BY min_start DESC LIMIT 8`
).all();
for (const c of counts) console.log(`  session=${c.session_id} 行数=${c.n} 时间范围=[${c.min_start}, ${c.max_end}]`);

const latest = sessions.length ? sessions[0].id : null;
const sel = tcols.includes("seq") ? "seq" : (tcols.includes("source_seq") ? "source_seq" : "0 AS seq");
console.log(`\n=== 最近一场 (${latest}) 的稳态片段明细 ===`);
const rows = db.prepare(
  `SELECT source_seq AS seq, connection_id, start_ms, end_ms, text, is_final FROM transcript_segments
   WHERE session_id = ? ORDER BY start_ms ASC`
).all(latest);
for (const r of rows) {
  console.log(`  [${r.start_ms}→${r.end_ms}] (${r.end_ms - r.start_ms}ms) seq=${r.seq} conn=${(r.connection_id || "-").slice(0, 8)}`);
  console.log(`      text: ${r.text}`);
}
if (!rows.length) console.log("  (无记录)");

// 单调性检查
const monotonic = rows.every((r, i) => i === 0 || r.start_ms >= rows[i - 1].end_ms);
const seqMonotonic = rows.every((r, i) => i === 0 || r.source_seq >= rows[i - 1].source_seq);
console.log(`\n=== 单调性 ===`);
console.log(`  start_ms/end_ms 不重叠且递增: ${monotonic}`);
console.log(`  source_seq 递增: ${seqMonotonic}`);
console.log(`  非空 text 行数: ${rows.filter((r) => r.text && r.text.trim().length > 0).length}/${rows.length}`);
db.close();
