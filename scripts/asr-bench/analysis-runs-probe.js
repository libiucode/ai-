/**
 * 只读查 analysis_runs 的失败原因（跨线排查用，不写库）。
 * 用法：electron.exe scripts/asr-bench/analysis-runs-probe.js <dbPath> [sessionId]
 */
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const dbPath = rawArgs[0] || "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const sessionId = rawArgs[1] || null;
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database(dbPath, { readonly: true });

const out = {};
out.recentRuns = db.prepare(
  "SELECT session_id, status, started_at, finished_at, substr(COALESCE(error_message,''),1,160) err FROM analysis_runs ORDER BY started_at DESC LIMIT 20"
).all().map((r) => ({ s: String(r.session_id).slice(0, 8), st: r.status, at: r.started_at, err: r.err }));
out.latestSessions = db.prepare(
  "SELECT id, started_at_iso, ended_at_iso, status FROM sessions ORDER BY started_at_iso DESC LIMIT 3"
).all().map((s) => ({ id: s.id.slice(0, 8), start: s.started_at_iso, end: s.ended_at_iso, st: s.status }));
out.counts = db.prepare(
  "SELECT (SELECT COUNT(*) FROM issues) issues, (SELECT COUNT(*) FROM transcript_segments WHERE is_final=1) finals, (SELECT COUNT(*) FROM sessions) sessions"
).get();

if (sessionId) {
  out.target = db.prepare(
    "SELECT status, started_at, finished_at, COALESCE(error_message,'') err FROM analysis_runs WHERE session_id = ? ORDER BY started_at"
  ).all(sessionId).map((r) => ({ st: r.status, at: r.started_at, fin: r.finished_at, err: r.err.slice(0, 200) }));
}

console.log("===ANALYSIS_RUNS_PROBE===");
console.log(JSON.stringify(out, null, 2));
db.close();
process.exit(0);
