// 只读复核：2920b432 的最大静默段到底落在会话时间轴的哪个位置。
// 目的：验证「49.8s 跨音源边界」这一结论。
// 零 ASR 额度、不采音、不写库。
//
// 用法: electron.exe scripts/analyze-boundary.cjs  （需 ELECTRON_RUN_AS_NODE=1）
const path = require("node:path");
const Database = require(path.join("D:\\ai盯播工具\\app", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });

const SID_LIKE = "2920b432%";
const s = db.prepare("SELECT * FROM sessions WHERE id LIKE ?").get(SID_LIKE);
if (!s) {
  console.log("no session");
  process.exit(1);
}
console.log("=== session ===");
console.log(JSON.stringify({
  id: s.id, started_at_iso: s.started_at_iso, ended_at_iso: s.ended_at_iso,
  status: s.status, audio_source: s.audio_source,
}, null, 2));

const iv = db.prepare(
  "SELECT start_ms AS s, end_ms AS e FROM speech_intervals WHERE session_id = ? ORDER BY start_ms"
).all(s.id);
console.log(`\nspeech_intervals: ${iv.length}`);
if (iv.length) {
  console.log(`first start_ms=${iv[0].s}  last end_ms=${iv[iv.length - 1].e}`);
}

// 逐空隙列出，标出 >2s 的
console.log("\n=== 所有 >2000ms 的空隙 ===");
const gaps = [];
for (let i = 1; i < iv.length; i++) {
  const g = iv[i].s - iv[i - 1].e;
  if (g > 0) gaps.push({ gap: g, from: iv[i - 1].e, to: iv[i].s, idx: i });
}
const big = gaps.filter((x) => x.gap > 2000).sort((a, b) => b.gap - a.gap);
for (const x of big.slice(0, 15)) {
  console.log(`  gap=${x.gap}ms  ${(x.from / 1000).toFixed(1)}s -> ${(x.to / 1000).toFixed(1)}s  (interval#${x.idx})`);
}

// 转录片段：前后各几条，看看内容在哪儿切换
console.log("\n=== transcript_segments (前 12 条) ===");
const segs = db.prepare(
  "SELECT id, start_ms, end_ms, text FROM transcript_segments WHERE session_id = ? ORDER BY start_ms"
).all(s.id);
console.log(`total segs = ${segs.length}`);
for (const t of segs.slice(0, 12)) {
  console.log(`  [${(t.start_ms / 1000).toFixed(1)}s-${(t.end_ms / 1000).toFixed(1)}s] ${String(t.text).slice(0, 60)}`);
}
console.log("\n=== transcript_segments (第 3~8 条，看切换点) ===");
for (const t of segs.slice(2, 8)) {
  console.log(`  [${(t.start_ms / 1000).toFixed(1)}s-${(t.end_ms / 1000).toFixed(1)}s] ${String(t.text).slice(0, 60)}`);
}

// 干净窗口 vs 污染段：以 125s 为界分别统计
const BOUNDARY = 125000;
const clean = gaps.filter((x) => x.to <= BOUNDARY);
const crossed = gaps.filter((x) => x.from < BOUNDARY && x.to > BOUNDARY);
const dirty = gaps.filter((x) => x.from >= BOUNDARY);
const stat = (arr) => {
  if (!arr.length) return "n=0";
  const sorted = arr.map((x) => x.gap).sort((a, b) => a - b);
  return `n=${sorted.length} 最长=${(sorted[sorted.length - 1] / 1000).toFixed(1)}s 中位=${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s`;
};
console.log(`\n=== 以 ${BOUNDARY / 1000}s 为界 ===`);
console.log(`  干净窗口内 (end<=125s):   ${stat(clean)}`);
console.log(`  跨边界:                   ${stat(crossed)}`);
console.log(`  污染段内 (start>=125s):   ${stat(dirty)}`);

// 结论性判定
const maxAll = gaps.length ? Math.max(...gaps.map((x) => x.gap)) : 0;
console.log(`\n=== 判定 ===`);
console.log(`  全库该会话最大空隙 = ${(maxAll / 1000).toFixed(1)}s`);
const maxClean = clean.length ? Math.max(...clean.map((x) => x.gap)) : 0;
console.log(`  干净窗口内最大空隙 = ${(maxClean / 1000).toFixed(1)}s`);

db.close();
