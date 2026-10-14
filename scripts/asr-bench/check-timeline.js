const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("D:\\ai盯播工具\\app\\.verify-tmp\\myrun-9555\\live-monitor.db", { readonly: true });
const s = db.prepare("SELECT * FROM sessions WHERE id LIKE 'f941151f%'").get();
console.log("=== 会话 f941151f 完整记录 ===");
for(const [k,v] of Object.entries(s)) console.log(`  ${k} = ${v}`);

console.log("\n=== 片段时间线 ===");
const segs = db.prepare("SELECT source_seq,start_ms,end_ms,text,created_at FROM transcript_segments WHERE session_id=? ORDER BY start_ms").all(s.id);
const epoch = new Date(s.started_at_iso).getTime();
for(const x of segs){
  const createdRel = Math.round((new Date(x.created_at).getTime()-epoch)/1000);
  console.log(`  seq=${x.source_seq} [${x.start_ms}-${x.end_ms}] created@${createdRel}s ${x.text.slice(0,50)}`);
}

console.log("\n=== speech_intervals 覆盖范围（判断何时停止收音频）===");
const si = db.prepare("SELECT MIN(start_ms) a, MAX(end_ms) b, COUNT(*) n FROM speech_intervals WHERE session_id=?").get(s.id);
console.log(`  区间数=${si.n}  覆盖 ${si.a}ms ~ ${si.b}ms (${((si.b-si.a)/1000).toFixed(1)}s)`);
console.log(`  会话时长 ${Math.round((new Date(s.ended_at_iso).getTime()-epoch)/1000)}s`);
console.log(`  音频在 ${(si.b/1000).toFixed(1)}s 处停止增长，会话在 ${Math.round((new Date(s.ended_at_iso).getTime()-epoch)/1000)}s 结束`);
db.close();