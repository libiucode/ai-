// 只读核对各会话的稳态/临时片段数，用于判断第①级证据是否依赖特定实例状态。
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT s.id AS sid, s.started_at_iso AS started, s.audio_source AS src, s.status AS st,
         (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id AND t.is_final = 1) AS finals,
         (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id AND t.is_final = 0) AS partials
  FROM sessions s ORDER BY s.started_at_iso DESC LIMIT 15
`).all();
console.log("started | session | source | status | finals | partials");
for (const r of rows) {
  console.log(`${r.started} | ${r.sid.slice(0, 8)} | ${r.src} | ${r.st} | ${r.finals} | ${r.partials}`);
}
const lvl1 = db.prepare("SELECT COUNT(*) AS c FROM transcript_segments WHERE session_id LIKE '190ba540%' AND is_final = 1").get();
console.log(`\n190ba540 稳态片段数: ${lvl1.c}`);
const spans = db.prepare("SELECT MIN(start_ms) AS a, MAX(end_ms) AS b FROM transcript_segments WHERE session_id LIKE '190ba540%' AND is_final = 1").get();
console.log(`190ba540 时间跨度: ${spans.a} -> ${spans.b}`);
db.close();
