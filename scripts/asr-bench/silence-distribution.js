/**
 * 静默时长分布分析（只读，零额度）。
 *
 * 目的：为「静音时断开 ASR」定阈值提供实测依据。
 * 方法：用 speech_intervals 还原「有声音」区间，取区间之间的空隙作为静默时长，
 * 统计其分布。阈值必须落在分布的长尾之外，否则会频繁误断。
 *
 * 同时统计：如果按某阈值断开，会触发多少次重连，以及对应的握手成本。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");

const DBS = [
  ["默认库", "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db"],
  ["myrun-9555", "D:\\ai盯播工具\\app\\.verify-tmp\\myrun-9555\\live-monitor.db"],
];

const THRESHOLDS = [30_000, 60_000, 120_000, 300_000, 600_000]; // 30s / 1min / 2min / 5min / 10min

const allGaps = [];
const perSession = [];

for (const [label, path] of DBS) {
  if (!fs.existsSync(path)) continue;
  let db;
  try { db = new Database(path, { readonly: true }); } catch (e) { console.log(`${label}: 打不开 (${e.message.split("\n")[0]})`); continue; }
  const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, status, audio_source FROM sessions").all();
  for (const s of sessions) {
    const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id = ? ORDER BY start_ms").all(s.id);
    if (si.length < 2) continue;
    const epoch = new Date(s.started_at_iso).getTime();
    const endMs = s.ended_at_iso ? new Date(s.ended_at_iso).getTime() - epoch : si[si.length - 1].end_ms;

    // 合并重叠区间
    const merged = [];
    for (const x of si) {
      const last = merged[merged.length - 1];
      if (!last || x.start_ms > last.end) merged.push({ start: x.start_ms, end: x.end_ms });
      else last.end = Math.max(last.end, x.end_ms);
    }
    const gaps = [];
    for (let i = 1; i < merged.length; i++) {
      const g = merged[i].start - merged[i - 1].end;
      if (g > 0) gaps.push(g);
    }
    // 会话尾部静默
    const tail = endMs - merged[merged.length - 1].end;
    if (tail > 0) gaps.push(tail);

    const maxGap = Math.max(...gaps);
    perSession.push({ label, id: s.id.slice(0, 8), src: s.audio_source, gaps: gaps.length, maxGapMs: maxGap, siCount: si.length });
    allGaps.push(...gaps);
  }
  db.close();
}

allGaps.sort((a, b) => a - b);
const q = (p) => allGaps.length ? allGaps[Math.min(allGaps.length - 1, Math.floor(allGaps.length * p))] : null;

console.log("=".repeat(88));
console.log("静默时长分布（全部会话，单位秒）");
console.log("=".repeat(88));
console.log(`样本数 ${allGaps.length}`);
console.log(`  min      ${(allGaps[0]/1000).toFixed(1)}s`);
console.log(`  p50      ${(q(0.5)/1000).toFixed(1)}s`);
console.log(`  p90      ${(q(0.9)/1000).toFixed(1)}s`);
console.log(`  p95      ${(q(0.95)/1000).toFixed(1)}s`);
console.log(`  p99      ${(q(0.99)/1000).toFixed(1)}s`);
console.log(`  max      ${(allGaps[allGaps.length-1]/1000).toFixed(1)}s`);

console.log("\n" + "=".repeat(88));
console.log("若按各阈值断开 ASR：触发次数（=重连次数）");
console.log("=".repeat(88));
console.log("阈值      触发次数   占静默总数   估算重连成本(按300ms握手)");
for (const t of THRESHOLDS) {
  const hits = allGaps.filter((g) => g >= t).length;
  const pct = ((hits / allGaps.length) * 100).toFixed(1);
  const cost = (hits * 0.3).toFixed(1);
  console.log(`${String(t/1000).padStart(4)}s     ${String(hits).padStart(6)}     ${String(pct).padStart(7)}%     ${cost}s`);
}

console.log("\n" + "=".repeat(88));
console.log("逐会话最长静默（前 15）");
console.log("=".repeat(88));
perSession.sort((a, b) => b.maxGapMs - a.maxGapMs);
for (const s of perSession.slice(0, 15)) {
  console.log(`  ${s.id} [${s.label}] ${s.src.padEnd(16)} 最长静默=${(s.maxGapMs/1000).toFixed(1)}s  静默段=${s.gaps}  VAD区间=${s.siCount}`);
}

const longSilences = allGaps.filter((g) => g >= 60_000);
console.log(`\n超过 60 秒的静默：${longSilences.length} 个`);
if (longSilences.length) console.log("  " + longSilences.map((g) => (g/1000).toFixed(0) + "s").join(", "));
