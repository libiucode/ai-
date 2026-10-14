// 只读核实：第一轮分析窗口(0-125000)的片段内容性质与污染边界。
const path = require("node:path");
const Database = require("better-sqlite3");
const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true, fileMustExist: true });
const sid = db.prepare("SELECT id FROM sessions WHERE id LIKE '2920b432%'").get().id;
const rows = db.prepare("SELECT source_seq AS seq, start_ms AS a, end_ms AS b, text FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms").all(sid);
console.log("会话:", sid);
console.log("总片段数:", rows.length);
console.log("\n--- 前 4 条（分析窗口 0-125000 覆盖范围）---");
for (const r of rows.slice(0, 4)) console.log(`[${r.a}-${r.b}] ${r.text.slice(0, 100)}`);
console.log("\n--- 第 5~7 条（污染起点之后）---");
for (const r of rows.slice(4, 7)) console.log(`[${r.a}-${r.b}] ${r.text.slice(0, 100)}`);
const after = rows.filter((r) => r.a >= 125000);
console.log(`\n125000ms 之后片段数: ${after.length}`);
db.close();
