// 只读核算：ASR 音频时长与 LLM 请求量，用于估算账单。不打印任何凭证。
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const sessions = db.prepare(`
  SELECT id, started_at_iso, ended_at_iso, audio_source, status
  FROM sessions ORDER BY started_at_iso
`).all();

console.log("=== 各会话音频时长（按转写片段覆盖的时间跨度估算 ASR 输入） ===");
let totalSec = 0;
for (const s of sessions) {
  const span = db.prepare(`
    SELECT MIN(start_ms) AS a, MAX(end_ms) AS b, COUNT(*) AS n
    FROM transcript_segments WHERE session_id = ?
  `).get(s.id);
  const sec = span && span.b ? (span.b - (span.a || 0)) / 1000 : 0;
  totalSec += sec;
  const wall = s.ended_at_iso
    ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000
    : (Date.now() - new Date(s.started_at_iso)) / 1000;
  if (sec > 0 || span.n > 0) {
    console.log(`  ${s.id.slice(0,8)} | 音源=${s.audio_source} | 状态=${s.status} | 片段=${span.n} | 音频跨度=${sec.toFixed(0)}s | 墙钟=${wall.toFixed(0)}s`);
  }
}
console.log(`\n有转写的会话音频跨度合计: ${totalSec.toFixed(0)} 秒 = ${(totalSec/3600).toFixed(2)} 音频小时`);

// 没有转写的会话也消耗了 ASR 连接时间（但可能未成功计费），单独统计
const noSeg = sessions.filter((s) => {
  const n = db.prepare("SELECT COUNT(*) AS c FROM transcript_segments WHERE session_id = ?").get(s.id).c;
  return n === 0;
});
let noSegWall = 0;
for (const s of noSeg) {
  const wall = s.ended_at_iso
    ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000
    : (Date.now() - new Date(s.started_at_iso)) / 1000;
  if (wall > 30 && wall < 86400) noSegWall += wall; // 排除异常长挂
}
console.log(`无转写会话墙钟合计（上限参考）: ${noSegWall.toFixed(0)} 秒 = ${(noSegWall/3600).toFixed(2)} 小时`);

console.log("\n=== LLM 分析运行统计 ===");
const runs = db.prepare("SELECT status, COUNT(*) AS c FROM analysis_runs GROUP BY status").all();
let runTotal = 0;
for (const r of runs) { console.log(`  status=${r.status}: ${r.c}`); runTotal += r.c; }
console.log(`  分析运行总次数: ${runTotal}`);

const speechIv = db.prepare("SELECT COUNT(*) AS c FROM speech_intervals").get();
console.log(`  speech_intervals 总数: ${speechIv.c} （约 ${(speechIv.c*0.2).toFixed(0)} 秒有声音）`);

console.log("\n=== 真实 LLM 单次消耗（来自真实验证）===");
console.log("  prompt_tokens=1108, completion_tokens=3702, total=4810, 耗时=65~103s");
db.close();
