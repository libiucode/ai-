/**
 * 查最近的会话及其片段数——用于核实"12 分钟 / 44 条字幕"是哪场会话。
 * 只读。同时统计各会话的识别错误特征（同音字疑似）。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });

const sessions = db.prepare(
  "SELECT id, started_at_iso, ended_at_iso, audio_source, status FROM sessions ORDER BY started_at_iso DESC LIMIT 8"
).all();

console.log("=== 最近 8 场会话 ===");
for (const s of sessions) {
  const c = db.prepare("SELECT COUNT(*) n FROM transcript_segments WHERE session_id = ? AND is_final = 1").get(s.id).n;
  const startMs = new Date(s.started_at_iso).getTime();
  const endMs = s.ended_at_iso ? new Date(s.ended_at_iso).getTime() : Date.now();
  const durMin = ((endMs - startMs) / 60000).toFixed(1);
  console.log(`${s.id.slice(0,8)}  ${s.started_at_iso}  时长=${durMin}min  片段=${c}  src=${s.audio_source}  status=${s.status}`);
}

// 找出片段数最多的那场，看它的文本
const top = db.prepare(
  "SELECT session_id, COUNT(*) n FROM transcript_segments WHERE is_final = 1 GROUP BY session_id ORDER BY n DESC LIMIT 3"
).all();
console.log("\n=== 片段最多的会话 ===");
for (const t of top) {
  console.log(`${t.session_id.slice(0,8)}  ${t.n} 条`);
  const segs = db.prepare(
    "SELECT source_seq, start_ms, end_ms, text FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms LIMIT 60"
  ).all(t.session_id);
  const lens = segs.map((s) => s.end_ms - s.start_ms).sort((a, b) => a - b);
  if (lens.length) {
    const med = lens.length % 2 ? lens[(lens.length-1)/2] : Math.round((lens[lens.length/2-1]+lens[lens.length/2])/2);
    console.log(`  片段长度: min=${lens[0]}ms 中位=${med}ms mean=${Math.round(lens.reduce((a,b)=>a+b,0)/lens.length)}ms max=${lens.at(-1)}ms`);
  }
  console.log(`  最后一条: [${segs.at(-1)?.start_ms}-${segs.at(-1)?.end_ms}] ${segs.at(-1)?.text?.slice(0,80)}`);
}
db.close();
