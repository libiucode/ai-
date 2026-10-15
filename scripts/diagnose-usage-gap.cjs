// 只读：逐会话列出「墙钟时长」与「音频时间轴」，找出控制台用量高于本地墙钟的差额来源。
// 背景：腾讯云控制台显示实时语音识别 1.1042 小时，而本地 18 会话墙钟合计仅 0.793 小时。
// 差 0.31 小时必须有出处，不能糊过去。
const path = require("node:path");
const fs = require("node:fs");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });
console.log("库:", dbPath);
console.log("库文件大小:", fs.statSync(dbPath).size, "bytes");
console.log("库 mtime:", fs.statSync(dbPath).mtime.toISOString());
for (const sfx of ["-wal", "-shm"]) {
  if (fs.existsSync(dbPath + sfx)) console.log(`  ${sfx}: ${fs.statSync(dbPath + sfx).size} bytes`);
}

const sessions = db.prepare("SELECT id, started_at_iso, ended_at_iso, status, audio_source FROM sessions ORDER BY started_at_iso").all();
console.log("\n会话总数:", sessions.length);

let wallTotal = 0;
let audioTotal = 0;
console.log("\n短名 | 开始(UTC) | 状态 | 墙钟s | 音频跨度s | 片段 | 区间");
console.log("-".repeat(88));
for (const s of sessions) {
  const wall = s.ended_at_iso ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000 : null;
  const iv = db.prepare("SELECT MAX(end_ms) AS m, COUNT(*) AS n FROM speech_intervals WHERE session_id = ?").get(s.id);
  const seg = db.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ?").get(s.id);
  const audio = (iv.m ?? 0) / 1000;
  if (wall) wallTotal += wall;
  audioTotal += audio;
  console.log(`${s.id.slice(0, 8)} | ${s.started_at_iso} | ${s.status.padEnd(8)} | ${wall ? wall.toFixed(0).padStart(5) : "  -  "} | ${audio.toFixed(0).padStart(8)} | ${String(seg.n).padStart(3)} | ${String(iv.n).padStart(4)}`);
}

console.log("\n=== 合计 ===");
console.log(`墙钟合计:   ${wallTotal.toFixed(0)}s = ${(wallTotal / 3600).toFixed(4)} 小时  （计费上界）`);
console.log(`音频合计:   ${audioTotal.toFixed(0)}s = ${(audioTotal / 3600).toFixed(4)} 小时  （计费下界）`);
console.log(`控制台显示: 1.1042 小时 = ${(1.1042 * 3600).toFixed(0)}s`);
console.log(`差额（控制台 - 墙钟上界）: ${((1.1042 * 3600) - wallTotal).toFixed(0)}s = ${(1.1042 - wallTotal / 3600).toFixed(4)} 小时`);

// 双管线会话的特殊性：音频被送两遍，ASR 实收音频量 > 墙钟
console.log("\n=== 双管线会话（发送给 ASR 的音频量 > 墙钟）===");
const dual = [];
for (const s of sessions) {
  const wall = s.ended_at_iso ? (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000 : null;
  const iv = db.prepare("SELECT MAX(end_ms) AS m FROM speech_intervals WHERE session_id = ?").get(s.id);
  const audio = (iv.m ?? 0) / 1000;
  if (wall && audio / wall > 1.05) {
    dual.push({ short: s.id.slice(0, 8), wall, audio, extra: audio - wall });
    console.log(`  ${s.id.slice(0, 8)}: 墙钟 ${wall.toFixed(0)}s → 实发音频 ${audio.toFixed(0)}s（多 ${(audio - wall).toFixed(0)}s）`);
  }
}
const dualExtra = dual.reduce((a, b) => a + b.extra, 0);
console.log(`  双管线额外多发的音频合计: ${dualExtra.toFixed(0)}s`);

console.log("\n=== 把「双管线多发量」计入后的估算 ===");
// 计费口径 = ASR 实际收到的音频时长。双管线会话按实发量算，其余按墙钟算。
const billed = wallTotal - dual.reduce((a, b) => a + b.wall, 0) + dual.reduce((a, b) => a + b.audio, 0);
console.log(`  修正后估算: ${billed.toFixed(0)}s = ${(billed / 3600).toFixed(4)} 小时`);
console.log(`  与控制台差额: ${((1.1042 * 3600) - billed).toFixed(0)}s`);

// 是否还有残留/未结束会话
console.log("\n=== 状态分布 ===");
for (const r of db.prepare("SELECT status, COUNT(*) AS c FROM sessions GROUP BY status").all()) {
  console.log(`  ${r.status}: ${r.c}`);
}

console.log("\n=== 被删除会话的痕迹（analysis_runs 中 session_id 不在 sessions 表里的）===");
const orphan = db.prepare(
  `SELECT DISTINCT session_id FROM analysis_runs
   WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)`,
).all();
console.log(orphan.length ? orphan.map((r) => r.session_id).join("\n") : "  无孤儿 analysis_runs");

const orphanSeg = db.prepare(
  `SELECT DISTINCT session_id, COUNT(*) AS c FROM transcript_segments
   WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)
   GROUP BY session_id`,
).all();
console.log("\n=== 孤儿 transcript_segments（会话已删但片段还在）===");
if (orphanSeg.length) {
  for (const r of orphanSeg) console.log(`  ${String(r.session_id).slice(0, 8)}: ${r.c} 条`);
} else {
  console.log("  无");
}

const orphanIv = db.prepare(
  `SELECT DISTINCT session_id, COUNT(*) AS c FROM speech_intervals
   WHERE session_id IS NOT NULL AND session_id NOT IN (SELECT id FROM sessions)
   GROUP BY session_id`,
).all();
console.log("\n=== 孤儿 speech_intervals ===");
if (orphanIv.length) {
  for (const r of orphanIv) console.log(`  ${String(r.session_id).slice(0, 8)}: ${r.c} 条`);
} else {
  console.log("  无");
}

db.close();
