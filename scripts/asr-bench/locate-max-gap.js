/**
 * 精确定位 2920b432 的最大静默段在会话时间轴上的位置。
 *
 * 关键问题：49.8s 这个极值落在「干净窗口（0~125s，CCTV-13 直播）」
 * 还是「污染段（208s 之后，混入 TTS）」？
 *
 * 这决定了 auto-stop-threshold-analysis.md 的阈值推算是否有基础：
 *   - 若在干净窗口 → 该极值代表真实直播静默，文档 §3.2 的 12 倍边际成立
 *   - 若在污染段   → 该极值不代表真实直播，阈值推算基础不成立
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });

const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE '2920b432%'").get();
const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id=? ORDER BY start_ms").all(s.id);
const segs = db.prepare("SELECT source_seq, start_ms, end_ms, text FROM transcript_segments WHERE session_id=? AND is_final=1 ORDER BY start_ms").all(s.id);

// 已知：前 4 条片段 0~124780ms 是干净的 CCTV-13
const CLEAN_END_MS = 125000;

// 合并区间
const merged = [];
for (const x of si) {
  const last = merged[merged.length - 1];
  if (!last || x.start_ms > last.end) merged.push({ start: x.start_ms, end: x.end_ms });
  else last.end = Math.max(last.end, x.end_ms);
}

// 找所有空隙并标注落区
const gaps = [];
for (let i = 1; i < merged.length; i++) {
  const g = merged[i].start - merged[i - 1].end;
  if (g > 0) gaps.push({ startMs: merged[i - 1].end, endMs: merged[i].start, gapMs: g });
}
gaps.sort((a, b) => b.gapMs - a.gapMs);

console.log("=== 2920b432 最大静默段定位 ===");
console.log(`干净窗口: 0 ~ ${CLEAN_END_MS}ms (前 4 条 CCTV-13 片段)`);
console.log(`污染起点: ~208000ms (音频采集 ffplay 起于 23:49:00)\n`);

console.log("前 10 大静默段：");
for (const g of gaps.slice(0, 10)) {
  const zone = g.startMs < CLEAN_END_MS
    ? (g.endMs <= CLEAN_END_MS ? "✅ 干净窗口内" : "⚠️ 跨边界")
    : "❌ 污染段";
  console.log(`  [${(g.startMs/1000).toFixed(0)}s ~ ${(g.endMs/1000).toFixed(0)}s] ${(g.gapMs/1000).toFixed(1)}s  ${zone}`);
}

// 分区域统计
const clean = gaps.filter((g) => g.endMs <= CLEAN_END_MS);
const dirty = gaps.filter((g) => g.startMs >= CLEAN_END_MS);
const cross = gaps.filter((g) => g.startMs < CLEAN_END_MS && g.endMs > CLEAN_END_MS);

console.log("\n=== 分区统计 ===");
console.log(`干净窗口内 (0~${CLEAN_END_MS/1000}s):      ${clean.length} 段，最长 ${clean.length ? (Math.max(...clean.map(g=>g.gapMs))/1000).toFixed(1) : 0}s`);
console.log(`跨边界:                        ${cross.length} 段`);
console.log(`污染段 (${CLEAN_END_MS/1000}s 之后):      ${dirty.length} 段，最长 ${dirty.length ? (Math.max(...dirty.map(g=>g.gapMs))/1000).toFixed(1) : 0}s`);

console.log("\n=== 结论 ===");
const maxClean = clean.length ? Math.max(...clean.map(g=>g.gapMs)) : 0;
const maxDirty = dirty.length ? Math.max(...dirty.map(g=>g.gapMs)) : 0;
console.log(`干净窗口最长静默: ${(maxClean/1000).toFixed(1)}s`);
console.log(`污染段最长静默:   ${(maxDirty/1000).toFixed(1)}s`);
console.log(maxClean >= maxDirty
  ? "→ 极值来自干净窗口，阈值推算基础成立"
  : "→ 极值来自污染段，阈值推算基础不成立");
db.close();
