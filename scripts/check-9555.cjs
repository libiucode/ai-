// 只读：查 f941151f 会话的精确时间线，以及该库全部会话状态。
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = "D:\\ai盯播工具\\app\\.verify-tmp\\myrun-9555\\live-monitor.db";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare("SELECT id, started_at_iso, ended_at_iso, status, audio_source FROM sessions ORDER BY started_at_iso").all();
console.log("=== myrun-9555 库全部会话 ===");
for (const r of rows) {
  console.log(`${r.id.slice(0,8)} | 起 ${r.started_at_iso} | 止 ${r.ended_at_iso ?? "(null)"} | ${r.status} | ${r.audio_source}`);
}
console.log("\n=== 片段与语音区间 ===");
for (const r of rows) {
  const seg = db.prepare("SELECT COUNT(*) AS c, COALESCE(MAX(end_ms),0) AS last FROM transcript_segments WHERE session_id=?").get(r.id);
  const iv = db.prepare("SELECT COUNT(*) AS c, COALESCE(MAX(end_ms),0) AS last FROM speech_intervals WHERE session_id=?").get(r.id);
  console.log(`${r.id.slice(0,8)} 片段=${seg.c} 片段末=${seg.last}ms  VAD=${iv.c} VAD末=${iv.last}ms`);
}
db.close();
