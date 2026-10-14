/**
 * 核对指定会话的 SQLite 落库内容（只读）。
 * 用法：node check-session.js <sessionId前缀>
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const dbPath = "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const prefix = process.argv[2] || "";

const db = new Database(dbPath, { readonly: true });
const sessions = db.prepare(
  "SELECT id, started_at_iso, ended_at_iso, audio_source, status FROM sessions WHERE id LIKE ? ORDER BY started_at_iso DESC LIMIT 5"
).all(prefix + "%");

console.log("=== SESSIONS ===");
for (const s of sessions) console.log(`${s.id}  ${s.started_at_iso}  ended=${s.ended_at_iso || "-"}  src=${s.audio_source}  status=${s.status}`);

for (const s of sessions) {
  const segs = db.prepare(
    "SELECT source_seq, connection_id, start_ms, end_ms, text, is_final, created_at FROM transcript_segments WHERE session_id = ? ORDER BY start_ms ASC"
  ).all(s.id);
  const fin = segs.filter((x) => x.is_final === 1);
  const si = db.prepare("SELECT COUNT(*) c FROM speech_intervals WHERE session_id = ?").get(s.id);
  console.log(`\n=== SESSION ${s.id} ===`);
  console.log(`segments=${segs.length} finals=${fin.length} speech_intervals=${si.c}`);
  let monotonic = true, prevEnd = -1, prevSeq = -1;
  for (const x of fin) {
    if (x.end_ms < x.start_ms || x.end_ms < prevEnd || x.source_seq <= prevSeq) monotonic = false;
    prevEnd = x.end_ms; prevSeq = x.source_seq;
  }
  console.log(`timestamps monotonic: ${monotonic}`);
  for (const x of fin) {
    console.log(`  seq=${x.source_seq} [${x.start_ms}-${x.end_ms}] (${((x.end_ms-x.start_ms)/1000).toFixed(1)}s) ${x.text}`);
  }
}
db.close();
