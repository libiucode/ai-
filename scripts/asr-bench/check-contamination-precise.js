/**
 * 精确污染判据：区分「纯 TTS 会话」（设计如此，非污染）与「混合会话」（真污染）。
 *
 * 关键认识：TTS 命中和污染不是一回事。
 *   - 第①/③级会话的设计音源就是 TTS → 命中 TTS 是**预期**
 *   - 污染 = 同一会话内**既有 TTS 又有非 TTS**（两种音源混进同一 session）
 *
 * 只读。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");
const DB = "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const SCRIPTS = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\live-scripts.txt";

const scriptLines = fs.readFileSync(SCRIPTS, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const marker = (line) => line.replace(/[，。！？、：；\s]/g, "").slice(0, 10);
const markers = scriptLines.map(marker).filter((s) => s.length >= 6);

const db = new Database(DB, { readonly: true });
const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, audio_source, status FROM sessions ORDER BY started_at_iso").all();

function isTts(text) {
  const clean = String(text || "").replace(/[，。！？、：；\s]/g, "");
  if (clean.length < 6) return false;
  return markers.some((m) => clean.includes(m));
}

console.log("=".repeat(104));
console.log("精确污染判据：混合会话 = 同一 session 内既有 TTS 又有非 TTS");
console.log("=".repeat(104));
console.log("会话      片段  TTS  非TTS  类型        正常结束  结论");
console.log("-".repeat(104));

const contaminated = [];
for (const s of sessions) {
  const segs = db.prepare("SELECT text FROM transcript_segments WHERE session_id = ? AND is_final = 1").all(s.id);
  const n = segs.length;
  const tts = segs.filter((x) => isTts(x.text)).length;
  const nonTts = n - tts;
  const endedOk = s.status === "stopped" && !!s.ended_at_iso;

  let type, verdict;
  if (n === 0) { type = "空"; verdict = "无片段"; }
  else if (tts === n) { type = "纯TTS"; verdict = "✅ 设计如此（该会话音源就是 TTS）"; }
  else if (tts === 0) { type = "纯直播/其他"; verdict = "✅ 单一音源，干净"; }
  else { type = "★混合"; verdict = "❌ 污染：两种音源混进同一会话"; contaminated.push({ id: s.id, n, tts, nonTts, started: s.started_at_iso }); }

  console.log(`${s.id.slice(0, 8)}  ${String(n).padStart(4)}  ${String(tts).padStart(4)}  ${String(nonTts).padStart(6)}  ${type.padEnd(11)} ${endedOk ? "是" : "否 ←残留"}    ${verdict}`);
}

console.log("\n" + "=".repeat(104));
console.log("真污染会话清单（混合音源）");
console.log("=".repeat(104));
if (!contaminated.length) console.log("无");
for (const c of contaminated) {
  console.log(`  ${c.id}`);
  console.log(`    起于 ${c.started}  片段 ${c.n} 条（TTS ${c.tts} + 非TTS ${c.nonTts}）`);
}

console.log("\n" + "=".repeat(104));
console.log("残留会话（未正常结束）—— 与污染是两个独立问题");
console.log("=".repeat(104));
const res = sessions.filter((s) => s.status !== "stopped" || !s.ended_at_iso);
if (!res.length) console.log("无");
for (const s of res) {
  const segs = db.prepare("SELECT start_ms, end_ms FROM transcript_segments WHERE session_id = ? AND is_final = 1").all(s.id);
  const span = segs.length ? Math.max(...segs.map((x) => x.end_ms)) : 0;
  const epoch = new Date(s.started_at_iso).getTime();
  const wallSec = Math.round((Date.now() - epoch) / 1000);
  console.log(`  ${s.id.slice(0, 8)}  status=${s.status}  起于 ${s.started_at_iso}`);
  console.log(`    已挂 ${(wallSec/60).toFixed(0)} 分钟，但片段只覆盖 ${(span/1000).toFixed(0)} 秒，片段数 ${segs.length}`);
}
db.close();
