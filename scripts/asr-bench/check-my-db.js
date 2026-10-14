const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
const rows = db.prepare("SELECT id, started_at_iso, ended_at_iso, status, audio_source FROM sessions ORDER BY started_at_iso DESC LIMIT 6").all();
console.log("=== 我的 9555 实例库里的会话 ===");
for(const r of rows){
  const segs = db.prepare("SELECT source_seq,start_ms,end_ms,text FROM transcript_segments WHERE session_id=? AND is_final=1 ORDER BY start_ms").all(r.id);
  const epoch = new Date(r.started_at_iso).getTime();
  const wallSec = r.ended_at_iso ? Math.round((new Date(r.ended_at_iso).getTime()-epoch)/1000) : Math.round((Date.now()-epoch)/1000);
  console.log(`\n${r.id}  status=${r.status}  src=${r.audio_source}`);
  console.log(`  起 ${r.started_at_iso}  止 ${r.ended_at_iso || "(未结束!)"}  时长=${wallSec}s  片段=${segs.length}`);
  for(const s of segs) console.log(`    [${s.start_ms}-${s.end_ms}] ${s.text.slice(0,70)}`);
}
const res = db.prepare("SELECT COUNT(*) n FROM sessions WHERE status != 'stopped' OR ended_at_iso IS NULL").get();
console.log(`\n残留会话数: ${res.n}`);
db.close();