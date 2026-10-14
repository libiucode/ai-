// 只读：核实长时真实直播会话的转写质量与时间轴，用于验证「识别直播间」能力。
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const sid = "2920b432";
const full = db.prepare("SELECT id FROM sessions WHERE id LIKE ?").get(sid + "%");
if (!full) { console.log("会话不存在"); process.exit(1); }
const rows = db.prepare(`
  SELECT source_seq AS seq, start_ms AS a, end_ms AS b, text
  FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms
`).all(full.id);
console.log(`会话 ${sid} 稳态片段数: ${rows.length}`);
if (rows.length) {
  console.log(`时间跨度: ${rows[0].a} -> ${rows[rows.length - 1].b} ms (${((rows[rows.length-1].b - rows[0].a)/1000).toFixed(1)} 秒)`);
  let mono = true, empty = 0;
  let prevEnd = -1;
  const durations = [];
  for (const r of rows) {
    if (r.a < prevEnd - 1) mono = false;
    prevEnd = r.b;
    if (!r.text || !r.text.trim()) empty++;
    durations.push((r.b - r.a) / 1000);
  }
  durations.sort((x, y) => x - y);
  const mid = durations[Math.floor(durations.length / 2)];
  console.log(`单调递增: ${mono}  空文本: ${empty}`);
  console.log(`片段时长 秒: min=${durations[0].toFixed(1)} 中位=${mid.toFixed(1)} max=${durations[durations.length-1].toFixed(1)}`);
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].a - rows[i-1].b);
  gaps.sort((a,b)=>a-b);
  console.log(`片段间隔 秒: min=${(gaps[0]/1000).toFixed(1)} 中位=${(gaps[Math.floor(gaps.length/2)]/1000).toFixed(1)} max=${(gaps[gaps.length-1]/1000).toFixed(1)}`);
  console.log(`\n最后 3 条原文：`);
  for (const r of rows.slice(-3)) console.log(`  [${r.a}-${r.b}] ${r.text.slice(0, 70)}`);
}
const iv = db.prepare("SELECT COUNT(*) AS c FROM speech_intervals WHERE session_id = ?").get(full.id);
console.log(`\nspeech_intervals: ${iv.c} 条（约 ${(iv.c * 0.2).toFixed(0)} 秒有声音）`);
db.close();
