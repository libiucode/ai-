const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("D:\\ai盯播工具\\app\\.verify-tmp\\myrun-9555\\live-monitor.db", { readonly: true });
const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE 'f941151f%'").get();
if(!s){ console.log("会话不存在"); process.exit(0); }
const epoch = new Date(s.started_at_iso).getTime();
const connMs = new Date(s.ended_at_iso).getTime() - epoch;
const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id=? ORDER BY start_ms").all(s.id);
// 合并重叠区间，算真实"有声音"覆盖
let speechMs = 0, curEnd = -1;
for(const x of si){
  if(x.start_ms > curEnd){ speechMs += x.end_ms - x.start_ms; curEnd = x.end_ms; }
  else if(x.end_ms > curEnd){ speechMs += x.end_ms - curEnd; curEnd = x.end_ms; }
}
const idleMs = connMs - speechMs;
console.log(`会话 ${s.id.slice(0,8)}`);
console.log(`  连接时长      ${(connMs/1000).toFixed(1)}s  ← 计费基准`);
console.log(`  有声音时长    ${(speechMs/1000).toFixed(1)}s`);
console.log(`  空转时长      ${(idleMs/1000).toFixed(1)}s`);
console.log(`  空转占比      ${(idleMs/connMs*100).toFixed(1)}%`);
console.log(`  speech_intervals 条数 ${si.length}`);
db.close();