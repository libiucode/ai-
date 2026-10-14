// 只读分析：用库里已有的 speech_intervals / transcript_segments 统计真实静默分布，
// 为「长期无音频自动结束」定阈值。零 ASR 额度、不采音。
//
// 用法: electron.exe scripts/analyze-silence.cjs  （需 ELECTRON_RUN_AS_NODE=1）
const path = require("node:path");
const Database = require(path.join("D:\\ai盯播工具\\app", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });

console.log("DB:", dbPath);
console.log("=== speech_intervals 表结构 ===");
console.log(db.prepare("PRAGMA table_info(speech_intervals)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== 各会话概况 ===");
const sessions = db.prepare(
  `SELECT s.id, s.started_at_iso, s.status, s.audio_source,
          (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS segs,
          (SELECT COUNT(*) FROM speech_intervals p WHERE p.session_id = s.id) AS intervals,
          (SELECT MAX(end_ms) FROM transcript_segments t WHERE t.session_id = s.id) AS max_end
   FROM sessions s ORDER BY s.started_at_iso DESC`
).all();

for (const s of sessions) {
  const dur = s.max_end ? (s.max_end / 1000).toFixed(0) + "s" : "-";
  console.log(`  ${s.id.slice(0, 8)} | ${s.started_at_iso} | ${s.status} | ${s.audio_source} | 片段${s.segs} | 语音区间${s.intervals} | 覆盖${dur}`);
}

// 静默分布：对每个会话，取所有语音区间的空隙
console.log("\n=== 静默段分布（基于 speech_intervals 的空隙）===");
const cols = db.prepare("PRAGMA table_info(speech_intervals)").all().map((c) => c.name);
const startCol = cols.includes("start_ms") ? "start_ms" : cols[0];
const endCol = cols.includes("end_ms") ? "end_ms" : cols[1];

let allGaps = [];
for (const s of sessions) {
  const iv = db.prepare(
    `SELECT ${startCol} AS s, ${endCol} AS e FROM speech_intervals WHERE session_id = ? ORDER BY ${startCol}`
  ).all(s.id);
  if (iv.length < 2) continue;
  const gaps = [];
  for (let i = 1; i < iv.length; i++) {
    const g = iv[i].s - iv[i - 1].e;
    if (g > 0) gaps.push({ gap: g, at: iv[i - 1].e });
  }
  if (gaps.length) {
    const sorted = gaps.map((x) => x.gap).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(
      `  ${s.id.slice(0, 8)} | 静默段${gaps.length} | 中位${med}ms | p95 ${p95}ms | 最长${sorted[sorted.length - 1]}ms`
    );
    allGaps = allGaps.concat(gaps.map((x) => x.gap));
  }
}

if (allGaps.length) {
  const sorted = allGaps.slice().sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(sorted.length * p)];
  console.log("\n=== 全体静默段统计（n=" + sorted.length + "）===");
  console.log(`  最小   ${sorted[0]}ms`);
  console.log(`  中位   ${pct(0.5)}ms`);
  console.log(`  p90    ${pct(0.9)}ms`);
  console.log(`  p95    ${pct(0.95)}ms`);
  console.log(`  p99    ${pct(0.99)}ms`);
  console.log(`  最长   ${sorted[sorted.length - 1]}ms (${(sorted[sorted.length - 1] / 1000).toFixed(1)}s)`);
  const over = (ms) => sorted.filter((x) => x >= ms).length;
  console.log("\n=== 阈值候选（超过该时长的静默段数）===");
  for (const t of [5000, 15000, 30000, 60000, 120000, 300000, 900000, 1800000]) {
    const n = over(t);
    console.log(`  ≥ ${(t / 1000).toFixed(0)}s: ${n} 段 (${((n / sorted.length) * 100).toFixed(2)}%)`);
  }
}

// 会话级别的「最长连续无语音」——这才是自动结束阈值的真正依据
console.log("\n=== 会话级：最长连续无语音段 ===");
for (const s of sessions) {
  const iv = db.prepare(
    `SELECT ${startCol} AS s, ${endCol} AS e FROM speech_intervals WHERE session_id = ? ORDER BY ${startCol}`
  ).all(s.id);
  if (iv.length < 2) continue;
  let maxGap = 0, maxAt = 0;
  for (let i = 1; i < iv.length; i++) {
    const g = iv[i].s - iv[i - 1].e;
    if (g > maxGap) { maxGap = g; maxAt = iv[i - 1].e; }
  }
  console.log(`  ${s.id.slice(0, 8)} | 最长连续无语音 ${(maxGap / 1000).toFixed(1)}s（发生在 ${(maxAt / 1000).toFixed(0)}s 处）`);
}

db.close();
