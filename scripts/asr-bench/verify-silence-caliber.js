/**
 * 核对「最长静默」口径差异。
 *
 * 背景：负责人/音频采集报「真实直播最长静默 49.8 秒、超 60 秒的 0 个」，
 * 而我用 speech_intervals 算出 f941151f 最长静默只有 0.8 秒。
 * 两个数字必须核对——差 60 倍说明口径不同，不能都当真。
 *
 * 可能的口径差异：
 *   A. 他们算在「渲染层音频电平」上（连续低电平）
 *   B. 我算在「speech_intervals 空隙」上（VAD 判定为讲话的区间之间）
 * VAD 会把 BGM/环境音也算作语音，所以 B 的空隙天然更短。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");

function analyze(label, path, sessionPrefix) {
  const db = new Database(path, { readonly: true });
  const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE ? LIMIT 1").get(sessionPrefix + "%");
  if (!s) { console.log(`${label}: 会话不存在`); db.close(); return; }
  const epoch = new Date(s.started_at_iso).getTime();
  const connMs = new Date(s.ended_at_iso).getTime() - epoch;
  const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id=? ORDER BY start_ms").all(s.id);

  // 口径 B：VAD 区间之间的空隙
  const merged = [];
  for (const x of si) {
    const last = merged[merged.length - 1];
    if (!last || x.start_ms > last.end) merged.push({ start: x.start_ms, end: x.end_ms });
    else last.end = Math.max(last.end, x.end_ms);
  }
  let gaps = [];
  for (let i = 1; i < merged.length; i++) gaps.push(merged[i].start - merged[i - 1].end);
  const tailGap = connMs - merged[merged.length - 1].end;
  gaps = gaps.filter((g) => g > 0).sort((a, b) => a - b);

  // 讲话覆盖率
  const speechMs = merged.reduce((a, m) => a + (m.end - m.start), 0);

  console.log(`${label}  ${s.id.slice(0, 8)}`);
  console.log(`  连接时长        ${(connMs / 1000).toFixed(1)}s`);
  console.log(`  VAD 区间数      ${si.length}（合并后 ${merged.length}）`);
  console.log(`  讲话覆盖        ${(speechMs / 1000).toFixed(1)}s  (${(speechMs / connMs * 100).toFixed(1)}%)`);
  console.log(`  区间空隙        ${gaps.length} 段`);
  if (gaps.length) {
    console.log(`    最长空隙      ${(gaps[gaps.length - 1] / 1000).toFixed(1)}s`);
    console.log(`    空隙 >1s      ${gaps.filter((g) => g > 1000).length} 段`);
    console.log(`    空隙 >5s      ${gaps.filter((g) => g > 5000).length} 段`);
    console.log(`    空隙 >30s     ${gaps.filter((g) => g > 30000).length} 段`);
  }
  console.log(`  会话尾部空隙    ${tailGap > 0 ? (tailGap / 1000).toFixed(1) + "s" : "无"}`);
  console.log("");
  db.close();
}

console.log("=".repeat(80));
console.log("口径核对：VAD 区间空隙 vs 报告的「最长静默」");
console.log("=".repeat(80));
analyze("我的长跑会话  ", "D:\\ai盯播工具\\app\\.verify-tmp\\myrun-9555\\live-monitor.db", "f941151f");
analyze("CCTV-1 会话    ", "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", "b217299a");
analyze("CCTV-13 会话   ", "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", "2920b432");

console.log("=".repeat(80));
console.log("说明");
console.log("=".repeat(80));
console.log("speech_intervals 来自 VAD：它把 BGM、环境音、气声也算作「讲话」，");
console.log("所以区间空隙天然短，不能代表「渲染层电平持续为 0」的时长。");
console.log("报告里的 49.8s 很可能来自渲染层电平判据，两个数字口径不同，都有用：");
console.log("  - VAD 空隙  → 适合定「ASR 侧空闲断开」的阈值（ASR 引擎按这个看）");
console.log("  - 电平静默  → 适合定「采集侧静默告警」的阈值（用户感知按这个）");
