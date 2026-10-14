const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });
const rows = db.prepare("SELECT id, started_at_iso, ended_at_iso, status FROM sessions WHERE status != 'stopped' OR ended_at_iso IS NULL ORDER BY started_at_iso").all();
if(!rows.length){ console.log("无残留"); }
for(const r of rows){
  const c = db.prepare("SELECT COUNT(*) n FROM transcript_segments WHERE session_id=? AND is_final=1").get(r.id).n;
  const epoch = new Date(r.started_at_iso).getTime();
  const wall = Math.round((Date.now()-epoch)/60000);
  console.log(`${r.id.slice(0,8)}  status=${r.status}  挂=${wall}分钟  片段=${c}  起于 ${r.started_at_iso}`);
}
db.close();