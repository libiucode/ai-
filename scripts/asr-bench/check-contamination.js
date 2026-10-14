/**
 * 证据完整性核查：会话 2920b432 的 44 条片段里，
 * 哪些来自我驱动的 CCTV-13 窗口（23:45:31~23:47:36），
 * 哪些是之后被其他音频源污染进来的。
 *
 * 背景：我的 level2-live.js 跑完 130 秒后退出（只关 WS，没点「结束」），
 * app 会话继续存活。此时音频采集开始播 TTS（其 ffplay PID 9352 起于 23:49:00），
 * 系统混音被注入 TTS 声音，被同一会话继续采到。
 * 只读。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });

const sid = process.argv[2] || "2920b432";
const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE ? ORDER BY started_at_iso DESC LIMIT 1").get(sid + "%");
const epoch = new Date(s.started_at_iso).getTime();
console.log("会话:", s.id);
console.log("开始:", s.started_at_iso, " 结束:", s.ended_at_iso);

const segs = db.prepare(
  "SELECT source_seq, connection_id, start_ms, end_ms, text, created_at FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms"
).all(s.id);

// 我的干净窗口：level2-live.js 报告时间 15:47:36Z，会话内偏移约 124280ms
const CLEAN_UNTIL_MS = 125000;
console.log("\n干净窗口: 会话偏移 0 ~ " + CLEAN_UNTIL_MS + "ms (对应 23:45:31 ~ 23:47:36)");
console.log("污染起点: 音频采集 ffplay 起于 23:49:00 (会话偏移约 208000ms)\n");

let clean = [], after = [];
for (const x of segs) {
  (x.start_ms < CLEAN_UNTIL_MS ? clean : after).push(x);
}
console.log(`总计 ${segs.length} 条：干净窗口内 ${clean.length} 条，之后 ${after.length} 条\n`);

function stats(arr, label) {
  if (!arr.length) { console.log(label + ": 无数据"); return; }
  const lens = arr.map((x) => x.end_ms - x.start_ms).sort((a, b) => a - b);
  const med = lens.length % 2 ? lens[(lens.length - 1) / 2] : Math.round((lens[lens.length / 2 - 1] + lens[lens.length / 2]) / 2);
  console.log(`${label}: n=${lens.length} min=${lens[0]}ms 中位=${med}ms mean=${Math.round(lens.reduce((a,b)=>a+b,0)/lens.length)}ms max=${lens.at(-1)}ms`);
}

console.log("=== 干净窗口内的片段（CCTV-13 真实直播）===");
for (const x of clean) {
  console.log(`  seq=${x.source_seq} [${x.start_ms}-${x.end_ms}] (${((x.end_ms-x.start_ms)/1000).toFixed(1)}s) ${x.text.slice(0, 60)}`);
}
stats(clean, "干净窗口长度分布");

console.log("\n=== 之后被污染的片段（前 12 条）===");
for (const x of after.slice(0, 12)) {
  const offsetMin = (x.start_ms / 60000).toFixed(1);
  console.log(`  seq=${x.source_seq} [+${offsetMin}min] (${((x.end_ms-x.start_ms)/1000).toFixed(1)}s) ${x.text.slice(0, 60)}`);
}
stats(after, "污染段长度分布");

// 判断污染性质：TTS 文本特征
const ttsHits = after.filter((x) => /王炸|家人们|谁懂|宝宝们|回购|链接/.test(x.text));
console.log(`\n污染段中命中 TTS 话术特征的: ${ttsHits.length}/${after.length}`);
db.close();
