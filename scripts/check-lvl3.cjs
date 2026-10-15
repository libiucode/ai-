const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true });
const sid = process.argv[2] || "ae6d96d7-662d-4d13-aa53-881e9254d6a5";
const rows = db.prepare("SELECT source_seq, connection_id, start_ms, end_ms, text, is_final FROM transcript_segments WHERE session_id = ? ORDER BY start_ms ASC").all(sid);
console.log(`session=${sid} 行数=${rows.length}`);
let mono = true, seqMono = true, empty = 0, dupConn = new Set();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (i > 0) {
    if (r.start_ms < rows[i - 1].end_ms) mono = false;
    if (r.source_seq < rows[i - 1].source_seq) seqMono = false;
  }
  if (!r.text || !r.text.trim()) empty++;
  dupConn.add(r.connection_id);
}
const dur = rows.length ? (rows[rows.length - 1].end_ms - rows[0].start_ms) / 1000 : 0;
console.log(`时间跨度=${dur.toFixed(1)}s`);
console.log(`start/end 不重叠递增: ${mono}`);
console.log(`source_seq 递增: ${seqMono}`);
console.log(`空文本行: ${empty}`);
console.log(`涉及连接数: ${dupConn.size}（>1 表示发生过重连）`);
console.log(`连接 id: ${[...dupConn].join(", ")}`);
const interval = rows.length > 1 ? (rows[rows.length - 1].start_ms - rows[0].start_ms) / (rows.length - 1) : 0;
console.log(`平均片段间隔=${Math.round(interval)}ms`);
// 每条连接内的 seq 与时间戳是否从 0 重计数
const byConn = {};
for (const r of rows) { (byConn[r.connection_id] ||= []).push(r); }
for (const [c, rs] of Object.entries(byConn)) {
  console.log(`  conn=${c.slice(0, 8)}… 行数=${rs.length} seq范围=[${rs[0].source_seq}, ${rs[rs.length-1].source_seq}] 时间=[${rs[0].start_ms}, ${rs[rs.length-1].end_ms}]`);
}
db.close();
