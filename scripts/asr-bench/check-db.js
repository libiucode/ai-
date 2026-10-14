/**
 * 只读查询 app 的 SQLite，核对稳态片段、时间戳单调性、会话信息。
 * 用 better-sqlite3 的 node ABI 副本（electron ABI 130 与 node 20 兼容），
 * 不做任何写操作。
 */
const path = require("node:path");
const dbPath = process.argv[2] || "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
let Database;
try {
  Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
} catch (e) {
  console.log("better-sqlite3 load failed:", e.message.split("\n")[0]);
  console.log("falling back to raw sqlite via sqlite3 CLI if present");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, audio_source, status FROM sessions ORDER BY started_at_iso DESC LIMIT 10").all();
console.log("=== SESSIONS (latest 10) ===");
for (const s of sessions) console.log(`${s.id}  ${s.started_at_iso}  ended=${s.ended_at_iso || "-"}  src=${s.audio_source}  status=${s.status}`);

console.log("\n=== TRANSCRIPT SEGMENTS (latest session, finals only) ===");
const latest = sessions[0];
if (latest) {
  const segs = db.prepare("SELECT id, connection_id, source_seq, start_ms, end_ms, text, is_final, created_at FROM transcript_segments WHERE session_id = ? ORDER BY start_ms ASC").all(latest.id);
  console.log("session:", latest.id, "segments:", segs.length, "finals:", segs.filter((s) => s.is_final === 1).length);
  let monotonic = true, prevEnd = -1, prevSeq = -1;
  for (const s of segs) {
    if (s.end_ms < s.start_ms || s.end_ms < prevEnd || s.source_seq <= prevSeq) monotonic = false;
    prevEnd = s.end_ms; prevSeq = s.source_seq;
  }
  console.log("timestamp monotonic:", monotonic);
  for (const s of segs.slice(0, 30)) {
    console.log(`  seq=${s.source_seq} [${s.start_ms}-${s.end_ms}] final=${s.is_final} conn=${String(s.connection_id).slice(0, 8)} ${s.text}`);
  }
  const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id = ? ORDER BY start_ms").all(latest.id);
  console.log("speech_intervals:", si.length, si.slice(0, 5));
}
db.close();
