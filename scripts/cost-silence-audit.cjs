// 只读核算：会话时长 vs 真实有声音时长，量化「空转计费」的比例。
const path = require("node:path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT s.id, s.started_at_iso AS started, s.ended_at_iso AS ended, s.status,
    (SELECT COUNT(*) FROM speech_intervals v WHERE v.session_id = s.id) AS ivs,
    (SELECT COALESCE(MAX(v.end_ms),0) FROM speech_intervals v WHERE v.session_id = s.id) AS iv_last,
    (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id AND t.is_final=1) AS finals
  FROM sessions s ORDER BY s.started_at_iso
`).all();

console.log("会话     片段  VAD条  有声秒  连接秒  说话占比  状态");
let totalConn = 0, totalSpeech = 0;
for (const r of rows) {
  const conn = r.ended ? (new Date(r.ended) - new Date(r.started)) / 1000 : (Date.now() - new Date(r.started)) / 1000;
  if (conn < 1 || conn > 86400 * 2) continue;
  const speech = r.ivs * 0.2; // 每个 VAD 区间约 200ms
  totalConn += conn;
  totalSpeech += speech;
  const ratio = conn > 0 ? (speech / conn * 100) : 0;
  console.log(
    `${r.id.slice(0,8)} ${String(r.finals).padStart(5)} ${String(r.ivs).padStart(6)} ${speech.toFixed(0).padStart(7)} ${conn.toFixed(0).padStart(7)} ${ratio.toFixed(1).padStart(8)}%  ${r.status}`
  );
}
console.log("\n=== 汇总 ===");
console.log(`ASR 连接总时长: ${(totalConn/3600).toFixed(2)} 小时 → 按量付费约 ${(totalConn/3600*3.2).toFixed(2)} 元`);
console.log(`其中真实有声音: ${(totalSpeech/3600).toFixed(2)} 小时 → 若只付有声部分约 ${(totalSpeech/3600*3.2).toFixed(2)} 元`);
console.log(`空转占比: ${((1 - totalSpeech/totalConn)*100).toFixed(1)}%`);
db.close();
