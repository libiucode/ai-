// 只读：按音源类型分别核算空转率，验证 44.3% 是否被测试会话污染。
const path = require("node:path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true, fileMustExist: true });

const rows = db.prepare("SELECT id, started_at_iso AS a, ended_at_iso AS b FROM sessions WHERE ended_at_iso IS NOT NULL").all();
const all = [], withAudio = [];
for (const r of rows) {
  const conn = (new Date(r.b) - new Date(r.a)) / 1000;
  if (conn <= 0 || conn > 86400 * 2) continue;
  const ivs = db.prepare("SELECT start_ms AS a, end_ms AS b FROM speech_intervals WHERE session_id=? ORDER BY start_ms").all(r.id);
  let speech = 0, lastEnd = -1;
  for (const iv of ivs) {
    const s = Math.max(Math.min(iv.a, conn * 1000), lastEnd);
    const e = Math.min(iv.b, conn * 1000);
    if (e > s) speech += (e - s) / 1000;
    lastEnd = Math.max(lastEnd, e);
  }
  const rec = { id: r.id.slice(0, 8), conn, speech, idle: conn - speech };
  all.push(rec);
  if (speech > 10) withAudio.push(rec);
}

function summarize(name, list) {
  const c = list.reduce((s, r) => s + r.conn, 0);
  const sp = list.reduce((s, r) => s + r.speech, 0);
  console.log(`\n【${name}】会话 ${list.length} 个`);
  console.log(`  连接 ${c.toFixed(0)}s = ${(c/3600).toFixed(3)}h`);
  console.log(`  有声 ${sp.toFixed(0)}s   空转 ${(c-sp).toFixed(0)}s`);
  console.log(`  >>> 空转占比 ${((c-sp)/c*100).toFixed(1)}%`);
  console.log(`  按 3.2元/h：浪费 ${((c-sp)/3600*3.2).toFixed(2)} 元`);
}

console.log("=== 逐个会话空转率 ===");
for (const r of all) {
  const pct = r.conn > 0 ? (r.idle / r.conn * 100) : 0;
  console.log(`${r.id} 连接=${r.conn.toFixed(0)}s 空转=${r.idle.toFixed(0)}s (${pct.toFixed(1)}%)`);
}
summarize("全部会话（含无音频的失败尝试）", all);
summarize("仅真实有音频的会话", withAudio);
db.close();
