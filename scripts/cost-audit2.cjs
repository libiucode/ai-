// 只读：逐会话核算音频时长（ASR 计费依据）。不打印任何凭证。
const path = require("node:path");
const Database = require("better-sqlite3");
const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const rows = db.prepare(`
  SELECT s.id, s.started_at_iso AS started, s.ended_at_iso AS ended, s.audio_source AS src, s.status,
    (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS segs,
    (SELECT COALESCE(MAX(t.end_ms),0) FROM transcript_segments t WHERE t.session_id = s.id) AS span_ms,
    (SELECT COUNT(*) FROM speech_intervals v WHERE v.session_id = s.id) AS ivs,
    (SELECT COALESCE(MAX(v.end_ms),0) FROM speech_intervals v WHERE v.session_id = s.id) AS iv_span_ms
  FROM sessions s ORDER BY s.started_at_iso
`).all();

let asrCandidateSec = 0;   // 有音频流证据的会话（转写或 VAD 区间）
let speechSec = 0;
console.log("会话    音源      片段  转写跨度   VAD条   VAD跨度   墙钟   判定");
for (const r of rows) {
  const wall = r.ended ? (new Date(r.ended) - new Date(r.started)) / 1000
                       : (Date.now() - new Date(r.started)) / 1000;
  const span = r.span_ms / 1000;
  const ivSpan = r.iv_span_ms / 1000;
  const hasAudio = r.segs > 0 || r.ivs > 0;
  // ASR 计费按「实际送出的音频」；以 VAD 跨度与转写跨度中的较大者作为保守下界，
  // 墙钟作为上界（音频可能在转写结束后仍继续送）。
  const billed = hasAudio ? Math.max(ivSpan, span) : 0;
  if (hasAudio) asrCandidateSec += billed;
  speechSec += ivSpan;
  console.log(
    `${r.id.slice(0,8)} ${r.src === "microphone" ? "麦克风  " : "系统声音"} ${String(r.segs).padStart(5)} ` +
    `${span.toFixed(0).padStart(7)}s ${String(r.ivs).padStart(7)} ${ivSpan.toFixed(0).padStart(7)}s ` +
    `${wall.toFixed(0).padStart(6)}s  ${hasAudio ? "有音频" : "无音频(未计入)"}`
  );
}

console.log("\n=== 汇总 ===");
console.log(`有音频流证据的会话数: ${rows.filter(r => r.segs > 0 || r.ivs > 0).length} / ${rows.length}`);
console.log(`有语音时长(VAD跨度)合计: ${speechSec.toFixed(0)} 秒 = ${(speechSec/3600).toFixed(2)} 小时`);
console.log(`保守送音频时长合计: ${asrCandidateSec.toFixed(0)} 秒 = ${(asrCandidateSec/3600).toFixed(2)} 小时`);
console.log(`\n按腾讯云实时ASR 3.20 元/音频小时估算：`);
console.log(`  保守（仅计入有语音证据的时长）: ${(asrCandidateSec/3600*3.2).toFixed(2)} 元`);
db.close();
