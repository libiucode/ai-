/**
 * 第③级稳定性 + 端到端延迟统计（只读，直接读 app 的 SQLite）。
 *
 * 口径说明（必须随结论一起报）：
 *   t_recv  = transcript_segments.created_at   （final 落库/到达主进程的时刻）
 *   t_start = sessions.started_at_iso          （会话起点）
 *   end_ms  = 该片段在 ASR 连接内的结束时间 + orchestrator 的 asrAudioStartMs 锚点
 *   e2e = (t_recv - t_start) - end_ms
 * 锚点取的是「连接建立时刻」，而音频实际是按 nowMs()-500 排水送出的，
 * 所以这个口径偏乐观（少算约 500ms 的排水延迟）。结论里标注为「app 内实测（偏乐观口径）」。
 *
 * 用法：electron.exe scripts/asr-bench/stability-stats.js <dbPath> [sessionId]
 */
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const dbPath = rawArgs[0] || "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const sessionArg = rawArgs[1] || null;
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database(dbPath, { readonly: true });

// 默认统计「出字最多」的会话；也可显式指定
const sess = sessionArg
  ? db.prepare("SELECT id, started_at_iso, ended_at_iso, status FROM sessions WHERE id = ?").get(sessionArg)
  : db.prepare(
      `SELECT s.id, s.started_at_iso, s.ended_at_iso, s.status
       FROM sessions s
       JOIN (SELECT session_id, COUNT(*) c FROM transcript_segments WHERE is_final=1 GROUP BY session_id) t
         ON t.session_id = s.id
       ORDER BY t.c DESC LIMIT 1`
    ).get();

const out = { session: sess ? { id: sess.id.slice(0, 8), start: sess.started_at_iso, end: sess.ended_at_iso, status: sess.status } : null };
if (sess) {
  const rows = db.prepare(
    "SELECT connection_id, source_seq, start_ms, end_ms, text, created_at FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY source_seq"
  ).all(sess.id);
  const t0 = Date.parse(sess.started_at_iso);
  const lat = [];
  let mono = true, prevEnd = -1, prevSeq = -1, badTs = 0;
  for (const r of rows) {
    const recv = Date.parse(r.created_at);
    const e2e = recv - t0 - r.end_ms;
    lat.push(e2e);
    if (r.end_ms < r.start_ms) badTs++;
    if (r.end_ms < prevEnd || r.source_seq <= prevSeq) mono = false;
    prevEnd = r.end_ms; prevSeq = r.source_seq;
  }
  const sorted = [...lat].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
  const conns = [...new Set(rows.map((r) => String(r.connection_id).slice(0, 8)))];
  const lastEnd = rows.length ? rows[rows.length - 1].end_ms : 0;
  out.result = {
    finals: rows.length,
    connections: conns,
    audioCoveredSec: Math.round(lastEnd / 100) / 10,
    timestampsMonotonic: mono,
    badTimestampRows: badTs,
    e2eLatencyMs: {
      n: sorted.length,
      min: sorted[0] ?? null,
      p50: q(0.5), p90: q(0.9), p95: q(0.95), max: sorted[sorted.length - 1] ?? null,
      mean: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    },
  };
  // 逐条 seq / 时间戳 / 延迟，抽样打印
  out.samples = rows.slice(0, 6).map((r, i) => ({ seq: r.source_seq, ms: `${r.start_ms}-${r.end_ms}`, e2e: lat[i], text: r.text.slice(0, 28) }));
  out.tail = rows.slice(-3).map((r, i) => ({ seq: r.source_seq, ms: `${r.start_ms}-${r.end_ms}`, e2e: lat[rows.length - 3 + i], text: r.text.slice(0, 28) }));
  const gapMax = (() => {
    let m = 0, prev = 0;
    for (const r of rows) { m = Math.max(m, r.start_ms - prev); prev = r.end_ms; }
    return m;
  })();
  out.result.maxInterSegmentGapMs = gapMax;
}

console.log("===STABILITY_STATS===");
console.log(JSON.stringify(out, null, 2));
db.close();
process.exit(0);
