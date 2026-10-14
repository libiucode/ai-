// 只读核算 v2：按 VAD 区间的真实 (end_ms - start_ms) 累加，不再用「条数×200ms」估算。
const path = require("node:path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT s.id, s.started_at_iso AS started, s.ended_at_iso AS ended, s.status,
    (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id AND t.is_final=1) AS finals
  FROM sessions s ORDER BY s.started_at_iso
`).all();

console.log("会话     片段   有声秒   连接秒  说话占比  状态");
let totalConn = 0, totalSpeech = 0;
const detail = [];
for (const r of rows) {
  const conn = r.ended ? (new Date(r.ended) - new Date(r.started)) / 1000 : (Date.now() - new Date(r.started)) / 1000;
  if (conn < 1 || conn > 86400 * 2) continue;

  // 真实语音时长：逐区间累加，并裁剪到会话时间范围内去重叠
  const ivs = db.prepare(
    "SELECT start_ms AS a, end_ms AS b FROM speech_intervals WHERE session_id = ? ORDER BY start_ms",
  ).all(r.id);
  let speech = 0;
  let lastEnd = -1;
  for (const iv of ivs) {
    const a = Math.max(0, Math.min(iv.a, conn * 1000));
    const b = Math.max(0, Math.min(iv.b, conn * 1000));
    if (b <= a) continue;
    const from = Math.max(a, lastEnd);
    if (b > from) speech += (b - from) / 1000;
    lastEnd = Math.max(lastEnd, b);
  }
  totalConn += conn;
  totalSpeech += speech;
  detail.push({ id: r.id.slice(0, 8), finals: r.finals, speech, conn, status: r.status });
  console.log(
    `${r.id.slice(0,8)} ${String(r.finals).padStart(5)} ${speech.toFixed(0).padStart(8)} ${conn.toFixed(0).padStart(8)} ${(speech/conn*100).toFixed(1).padStart(8)}%  ${r.status}`,
  );
}

console.log("\n=== 汇总（测试期全部会话）===");
console.log(`ASR 连接总时长: ${(totalConn/3600).toFixed(2)} 小时 → 按 3.2 元/小时 ≈ ${(totalConn/3600*3.2).toFixed(2)} 元`);
console.log(`其中真实有语音: ${(totalSpeech/3600).toFixed(2)} 小时（占比 ${(totalSpeech/totalConn*100).toFixed(1)}%）`);
console.log(`空转（无语音）: ${((totalConn-totalSpeech)/3600).toFixed(2)} 小时 ≈ ${((totalConn-totalSpeech)/3600*3.2).toFixed(2)} 元`);

console.log("\n=== 只算「真在做直播」的会话（排除测试噪音）===");
const live = detail.filter((d) => d.speech > 60);
let lc = 0, ls = 0;
for (const d of live) { lc += d.conn; ls += d.speech; }
console.log(`会话数: ${live.length}`);
console.log(`连接: ${(lc/3600).toFixed(2)} 小时, 有声: ${(ls/3600).toFixed(2)} 小时, 占比 ${(ls/lc*100).toFixed(1)}%`);

console.log("\n=== 客户真实场景估算（4 小时直播/场）===");
const perHour = 3.2;
for (const h of [4, 8]) {
  console.log(`  单场 ${h} 小时: ${(h*perHour).toFixed(1)} 元`);
}
console.log(`  每天 4 小时 × 30 天 = 120 小时/月: ${(120*perHour).toFixed(0)} 元/月`);
console.log(`  若空转占比 37.6% 被优化掉: 省 ${(120*0.376*perHour).toFixed(0)} 元/月`);
db.close();
