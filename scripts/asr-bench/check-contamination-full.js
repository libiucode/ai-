/**
 * 证据污染范围核查（只读，不写任何文件）。
 *
 * 污染条件：会话残留（未正常结束）+ 后续有声音 → 别的音源被同一会话采进来。
 *
 * 两条交叉判据：
 *   ① 会话是否被正常结束：status=stopped 且 ended_at 与片段最后时间吻合
 *   ② 片段文本是否命中文档化话术特征（scripts/asr-bench/live-scripts.txt）
 *
 * 命中 TTS 话术特征的片段 = 该会话被 TTS 音源污染（无论是否还被直播内容污染）。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");

const DB = "C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db";
const SCRIPTS = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\live-scripts.txt";

// 目标会话（负责人指定）
const TARGETS = [
  ["b217299a", "长跑（CCTV-1）"],
  ["ae6d96d7", "第③级（58 条，TTS 源）"],
  ["5970a6d6", "8 条"],
  ["e0624009", "1793 VAD / 0 转写"],
  ["a83d2607", "518 VAD / 0 转写"],
  ["190ba540", "第①级（5 条，TTS）"],
  ["ae85dc7c", "第①级（7 条，TTS，音频采集跑的）"],
  ["2920b432", "第②级（已确认污染 40 条）"],
];

// 读话术特征：取每句的关键词片段（中文按 6 字窗口做子串匹配）
const scriptLines = fs.readFileSync(SCRIPTS, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const scriptMarkers = scriptLines.map((line) => line.replace(/[，。！？、：；]/g, "").slice(0, 10)).filter((s) => s.length >= 6);
console.log(`话术特征标记 ${scriptMarkers.length} 条（来自 live-scripts.txt）\n`);

const db = new Database(DB, { readonly: true });
const allSessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, audio_source, status FROM sessions ORDER BY started_at_iso").all();

function hitsTts(text) {
  const clean = String(text || "").replace(/[，。！？、：；\s]/g, "");
  if (clean.length < 6) return false;
  // 精确子串匹配：特征串出现在文本里
  return scriptMarkers.some((m) => clean.includes(m));
}

console.log("=".repeat(100));
console.log("污染核查结果");
console.log("=".repeat(100));

const summary = [];
for (const [prefix, label] of TARGETS) {
  const s = allSessions.find((x) => x.id.startsWith(prefix));
  if (!s) { console.log(`\n[${prefix}] 未找到`); continue; }
  const segs = db.prepare(
    "SELECT source_seq, start_ms, end_ms, text FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms"
  ).all(s.id);
  const si = db.prepare("SELECT COUNT(*) n, MIN(start_ms) a, MAX(end_ms) b FROM speech_intervals WHERE session_id = ?").get(s.id);

  // 判据①：会话是否正常结束
  const endedOk = s.status === "stopped" && !!s.ended_at_iso;
  // 片段最后结束时间 vs 会话 ended_at（粗查：会话时长覆盖片段跨度）
  const epoch = new Date(s.started_at_iso).getTime();
  const wallDurMs = s.ended_at_iso ? new Date(s.ended_at_iso).getTime() - epoch : (Date.now() - epoch);
  const lastSegEnd = segs.length ? Math.max(...segs.map((x) => x.end_ms)) : 0;
  // 判据②：TTS 特征命中
  const ttsSegs = segs.filter((x) => hitsTts(x.text));

  const lens = segs.map((x) => x.end_ms - x.start_ms).sort((a, b) => a - b);
  const med = lens.length ? (lens.length % 2 ? lens[(lens.length - 1) / 2] : Math.round((lens[lens.length / 2 - 1] + lens[lens.length / 2]) / 2)) : null;

  const verdict = segs.length === 0
    ? (si.n > 0 ? "有VAD无转写（非污染，属ASR无输出）" : "空会话")
    : (ttsSegs.length === 0
      ? "✅ 干净（无 TTS 特征）"
      : (ttsSegs.length === segs.length ? "❌ 全污染（全部是 TTS）" : `⚠️ 部分污染（${ttsSegs.length}/${segs.length} 条命中 TTS）`));

  console.log(`\n[${prefix}] ${label}`);
  console.log(`  会话: ${s.id}`);
  console.log(`  起止: ${s.started_at_iso} → ${s.ended_at_iso || "(未结束)"}  status=${s.status}  src=${s.audio_source}`);
  console.log(`  判据①正常结束: ${endedOk ? "是" : "否 ← 残留会话，有污染风险"}`);
  console.log(`  判据②TTS特征: ${ttsSegs.length}/${segs.length} 条命中`);
  console.log(`  片段: ${segs.length} 条  VAD区间: ${si.n}  片段跨度: ${(lastSegEnd / 1000).toFixed(1)}s  会话墙钟: ${(wallDurMs / 1000).toFixed(0)}s`);
  if (med !== null) console.log(`  长度分布: min=${lens[0]}ms 中位=${med}ms max=${lens.at(-1)}ms`);
  console.log(`  判定: ${verdict}`);
  if (ttsSegs.length) {
    console.log(`  TTS 命中示例: ${ttsSegs.slice(0, 2).map((x) => x.text.slice(0, 40)).join(" | ")}`);
  }
  summary.push({ prefix, label, segments: segs.length, vad: si.n, ttsHits: ttsSegs.length, endedOk, verdict, wallDurSec: Math.round(wallDurMs / 1000), lastSegEndMs: lastSegEnd });
}

console.log("\n" + "=".repeat(100));
console.log("汇总表");
console.log("=".repeat(100));
console.log("会话      片段  VAD    TTS命中  正常结束  判定");
for (const r of summary) {
  console.log(`${r.prefix}  ${String(r.segments).padStart(4)}  ${String(r.vad).padStart(5)}  ${String(r.ttsHits).padStart(6)}   ${r.endedOk ? "是" : "否"}      ${r.verdict}`);
}

// 额外：扫描全部会话，找出「未正常结束但仍有片段」的
console.log("\n" + "=".repeat(100));
console.log("全库扫描：未正常结束（残留）的会话");
console.log("=".repeat(100));
const residual = allSessions.filter((s) => s.status !== "stopped" || !s.ended_at_iso);
if (!residual.length) console.log("无残留会话");
for (const s of residual) {
  const c = db.prepare("SELECT COUNT(*) n FROM transcript_segments WHERE session_id = ? AND is_final = 1").get(s.id).n;
  const tts = db.prepare("SELECT text FROM transcript_segments WHERE session_id = ? AND is_final = 1").all(s.id).filter((x) => hitsTts(x.text)).length;
  console.log(`  ${s.id.slice(0, 8)}  status=${s.status}  ended=${s.ended_at_iso || "无"}  片段=${c}  TTS命中=${tts}  起于 ${s.started_at_iso}`);
}
db.close();
