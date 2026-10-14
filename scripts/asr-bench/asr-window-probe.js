/**
 * ASR 侧诊断：查询 app 数据库里指定时段的稳态片段 + 会话信息，
 * 并尝试从 app 的渲染层取 ASR 连接状态快照。
 *
 * 用法：node asr-window-probe.js <dbPath> <sessionId>
 * 例：node asr-window-probe.js "C:\Users\libiu\AppData\Roaming\ai-live-monitor\live-monitor.db" e0624009
 *
 * 只读，不写任何文件（除 stdout）。
 */
const path = require("node:path");
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// electron.exe 会把 --no-sandbox 之类的开关当成脚本参数，必须自己过滤掉；
// argv 里不含 electron 自身参数，所以第 1 个是 dbPath、第 2 个是 sessionId。
const dbPath = rawArgs[0] || "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const sessionId = rawArgs[1] || null;
let Database;
try {
  Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
} catch (e) {
  console.log("better-sqlite3 load failed:", e.message.split("\n")[0]);
  console.log("need electron node run");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
const out = {};

const sessions = db.prepare(
  "SELECT id, started_at_iso, ended_at_iso, audio_source, device_id, status FROM sessions ORDER BY started_at_iso DESC LIMIT 10"
).all();
out.sessions = sessions.map((s) => ({
  id: s.id,
  start: s.started_at_iso,
  end: s.ended_at_iso,
  src: s.audio_source,
  status: s.status,
}));

if (sessionId) {
  const segs = db.prepare(
    "SELECT connection_id, source_seq, start_ms, end_ms, text, is_final, created_at FROM transcript_segments WHERE session_id = ? ORDER BY start_ms ASC"
  ).all(sessionId);
  let mono = true, prevEnd = -1, prevSeq = -1;
  for (const s of segs) {
    if (s.end_ms < s.start_ms || s.end_ms < prevEnd || s.source_seq <= prevSeq) mono = false;
    prevEnd = s.end_ms; prevSeq = s.source_seq;
  }
  const byConn = {};
  for (const s of segs) {
    const k = String(s.connection_id).slice(0, 8);
    if (!byConn[k]) byConn[k] = { rows: 0, finals: 0, firstMs: s.start_ms, lastMs: s.end_ms };
    byConn[k].rows++;
    if (s.is_final === 1) byConn[k].finals++;
    byConn[k].lastMs = s.end_ms;
  }
  out.target = {
    sessionId,
    segments: segs.length,
    finals: segs.filter((s) => s.is_final === 1).length,
    partials: segs.filter((s) => s.is_final === 0).length,
    connections: Object.keys(byConn).length,
    byConn,
    timestampsMonotonic: mono,
    firstFinal: segs.find((s) => s.is_final === 1) || null,
    lastFinal: [...segs].reverse().find((s) => s.is_final === 1) || null,
    rows: segs.map((s) => ({
      conn: String(s.connection_id).slice(0, 8),
      seq: s.source_seq,
      ms: `[${s.start_ms}-${s.end_ms}]`,
      t: s.created_at,
      text: s.text,
    })),
  };
  const si = db.prepare(
    "SELECT COUNT(*) c, MIN(start_ms) mn, MAX(end_ms) mx FROM speech_intervals WHERE session_id = ?"
  ).get(sessionId);
  out.target.speechIntervals = si;
  // 语音区间有多少能量（直接读 PCM 太占内存，用区间总时长代替）
  const siDur = db.prepare(
    "SELECT SUM(end_ms - start_ms) total_ms FROM speech_intervals WHERE session_id = ?"
  ).get(sessionId);
  out.target.speechTotalMs = siDur;
  const runs = db.prepare(
    "SELECT status, COUNT(*) c FROM analysis_runs WHERE session_id = ? GROUP BY status"
  ).all(sessionId);
  out.target.analysisRuns = runs;
} else {
  // 总览模式：每个会话的「主进程收到音频」（speech_intervals）与「ASR 出字」（transcript_segments）对照。
  // 这两列一起看才能区分「采集没进来」和「ASR 没出字」。
  out.overview = sessions.map((s) => {
    const seg = db.prepare(
      "SELECT COUNT(*) c, SUM(is_final) f FROM transcript_segments WHERE session_id = ?"
    ).get(s.id);
    const iv = db.prepare(
      "SELECT COUNT(*) c, SUM(end_ms - start_ms) ms FROM speech_intervals WHERE session_id = ?"
    ).get(s.id);
    const runs = db.prepare(
      "SELECT status, COUNT(*) c FROM analysis_runs WHERE session_id = ? GROUP BY status"
    ).all(s.id);
    return {
      id: s.id.slice(0, 8),
      start: s.started_at_iso,
      end: s.ended_at_iso,
      src: s.audio_source,
      status: s.status,
      segRows: seg.c || 0,
      finals: seg.f || 0,
      speechIv: iv.c || 0,
      speechSec: Math.round((iv.ms || 0) / 100) / 10,
      runs: runs.map((r) => `${r.status}:${r.c}`).join(","),
    };
  });
}

// 全局视角：最近 24 小时的稳态片段分布（按 created_at）
out.recentFinals = db.prepare(
  "SELECT session_id, COUNT(*) c, MIN(created_at) first, MAX(created_at) last FROM transcript_segments WHERE is_final = 1 GROUP BY session_id ORDER BY last DESC LIMIT 10"
).all();

console.log("===ASR_WINDOW_PROBE===");
console.log(JSON.stringify(out, null, 2));
db.close();
// electron.exe 以主进程方式跑完脚本后不会自己退出，必须显式结束，
// 否则这个探针会一直挂住（2026-10-14 实测挂了两分钟）。
process.exit(0);
