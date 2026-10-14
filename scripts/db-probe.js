// 临时诊断脚本（不提交）：用 Electron 运行时读 WAL 模式的 live-monitor.db。
// 用法：node_modules\.bin\electron scripts\db-probe.js --no-sandbox --disable-gpu
const { app } = require("electron");
const path = require("node:path");
const Database = require("better-sqlite3");

const DB_PATH = "C:/Users/libiu/AppData/Roaming/ai-live-monitor/live-monitor.db";

app.whenReady().then(() => {
  const out = {};
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    out.sessions = db
      .prepare(
        "SELECT id, device_id, audio_source, status, started_at_iso, ended_at_iso FROM sessions ORDER BY started_at_iso DESC LIMIT 5"
      )
      .all();
    out.transcript_segments_count = db
      .prepare("SELECT COUNT(*) c FROM transcript_segments")
      .get().c;
    try {
      out.analysis_runs_count = db.prepare("SELECT COUNT(*) c FROM analysis_runs").get().c;
    } catch (e) {
      out.analysis_runs_count = "N/A:" + e.message;
    }
    out.transcript_segments_cols = db
      .prepare("PRAGMA table_info(transcript_segments)")
      .all()
      .map((c) => c.name);
    // 若有 segment，看前几条
    out.transcript_segments_sample = db
      .prepare("SELECT * FROM transcript_segments ORDER BY rowid DESC LIMIT 5")
      .all();
    db.close();
  } catch (e) {
    out.error = e.stack || String(e);
  }
  console.log("===DB_PROBE_RESULT===");
  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
