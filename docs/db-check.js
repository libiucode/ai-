// 查询本次会话的落库情况（只读，不写任何表）。
// 用法: node docs/db-check.js <sessionIdPrefix>
const path = require("node:path");
const os = require("node:os");

const dbPath = "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
let Database;
try {
  Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
} catch (e) {
  console.error("better-sqlite3 加载失败（ABI 不匹配？）: " + e.message.split("\n")[0]);
  process.exit(3);
}

const prefix = process.argv[2] || "";
let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error("打开 DB 失败（可能 app 独占）: " + e.message.split("\n")[0]);
  process.exit(4);
}

try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  console.log("tables: " + tables.join(", "));

  const sessions = db
    .prepare("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 5")
    .all();
  console.log("\n-- 最近 5 个会话 --");
  for (const s of sessions) {
    console.log(JSON.stringify({ id: s.id, started: s.started_at_iso ?? s.startedAtIso, status: s.status, src: s.audio_source ?? s.audioSource }));
  }

  const target = prefix ? sessions.find((s) => s.id.startsWith(prefix)) : sessions[0];
  if (!target) {
    console.log("\n未找到匹配会话: " + prefix);
  } else {
    const sid = target.id;
    const segCols = db.prepare(`PRAGMA table_info(transcript_segments)`).all().map((c) => c.name);
    const segs = db.prepare(`SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY rowid`).all(sid);
    console.log("\n-- 会话 " + sid + " 稳态片段 " + segs.length + " 行 --");
    console.log("列: " + segCols.join(","));
    for (const r of segs.slice(0, 12)) {
      console.log(JSON.stringify({
        start: r.start_ms ?? r.startMs,
        end: r.end_ms ?? r.endMs,
        seq: r.source_seq ?? r.sourceSeq,
        text: r.text,
      }));
    }
    const runs = db.prepare(`SELECT * FROM analysis_runs WHERE session_id = ? ORDER BY rowid`).all(sid);
    console.log("\n分析窗口 " + runs.length + " 次: " + JSON.stringify(runs.map((r) => ({ s: r.status, at: r.started_at_iso ?? r.startedAtIso }))));
  }
} finally {
  db.close();
}
