// 只读：生成「本地 ASR 用量对账表」，供用户与腾讯云控制台「实时语音识别」用量逐条核对。
//
// 关键口径（务必分清，否则会和云账单对不上）：
//   1) 计费基准 = ASR WebSocket 连接时长，不是会话墙钟时长。
//      会话墙钟时长里含「暂停」「崩溃残留」等没连 ASR 的时间，用它算会虚高。
//      本脚本用 speech_intervals 的最后时刻作为「有音频的时长」下界，
//      并以会话墙钟时长作为上界，给出区间估计。
//   2) 残留会话（进程被强杀，status 长期 active）会把墙钟时长拉得极长（实测 622 分钟），
//      但那段时间 ASR 早已断开，不计费——必须单独列出，避免误当成消耗。
//   3) 云控制台「选择产品」必须选 **实时语音识别**；选「录音文件识别」永远是 0。
//
// 零 ASR 额度、不采音、不写库。
// 用法: electron.exe scripts/usage-reconcile.cjs   （需 ELECTRON_RUN_AS_NODE=1）
const path = require("node:path");
const fs = require("node:fs");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });

const PRICE_PER_HOUR = 3.2; // 腾讯云实时语音识别，中国大陆，元/音频小时

// 库可能还没跑过 v4 迁移（end_reason 是 2026-10-15 才加的；迁移在 app 启动时执行）。
// 只读脚本不能假设列存在——先读 schema 再决定 SELECT 什么，
// 否则会拿"脚本报错"冒充"库里没有数据"。
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
const hasEndReason = sessionCols.includes("end_reason");
const schemaVersion = (() => {
  try {
    return db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v ?? 1;
  } catch {
    return 1;
  }
})();

const sessions = db.prepare(
  `SELECT id, started_at_iso, ended_at_iso, status, audio_source
          ${hasEndReason ? ", end_reason" : ""}
   FROM sessions ORDER BY started_at_iso`,
).all();

const rows = [];
for (const s of sessions) {
  const iv = db.prepare(
    "SELECT MIN(start_ms) AS a, MAX(end_ms) AS b, COUNT(*) AS n FROM speech_intervals WHERE session_id = ?",
  ).get(s.id);
  const seg = db.prepare(
    "SELECT COUNT(*) AS n, MAX(end_ms) AS b FROM transcript_segments WHERE session_id = ? AND is_final = 1",
  ).get(s.id);

  const wallMs = s.ended_at_iso
    ? new Date(s.ended_at_iso).getTime() - new Date(s.started_at_iso).getTime()
    : Date.now() - new Date(s.started_at_iso).getTime();
  // 有音频时长下界：语音区间覆盖到的最后时刻（ASR 至少连到那时）
  const audioMs = Math.max(iv.b ?? 0, seg.b ?? 0);

  rows.push({
    id: s.id,
    short: s.id.slice(0, 8),
    start: s.started_at_iso,
    status: s.status,
    source: s.audio_source,
    endReason: hasEndReason ? (s.end_reason ?? null) : null,
    finals: seg.n,
    intervals: iv.n,
    wallSec: Math.round(wallMs / 1000),
    audioSec: Math.round(audioMs / 1000),
  });
}

// 计费口径：优先用「有音频时长」，但它是下界（ASR 可能在最后一句后还挂着）。
// 对正常运行结束的会话，两者接近；对残留会话，墙钟会离谱地大 → 单列。
const normal = rows.filter((r) => r.wallSec <= 3600 * 2);
const residuals = rows.filter((r) => r.wallSec > 3600 * 2);

console.log("=== 本地 ASR 用量对账表（只读） ===");
console.log(`库: ${dbPath}`);
console.log(`schema 版本: ${schemaVersion}${hasEndReason ? "" : "（尚无 end_reason 列——本机 app 自 2026-10-15 改动后还没启动过，迁移未执行）"}`);
console.log(`生成时间: ${new Date().toISOString()}\n`);

console.log("会话 | 开始(UTC) | 状态 | 音源 | 结束原因 | 稳态片段 | 有音频 | 墙钟");
console.log("-".repeat(120));
for (const r of rows) {
  console.log(
    `${r.short} | ${r.start} | ${r.status.padEnd(8)} | ${r.source.padEnd(14)} | ${String(r.endReason ?? "-").padEnd(20)} | ` +
    `${String(r.finals).padStart(3)} | ${String(r.audioSec).padStart(5)}s | ${String(r.wallSec).padStart(5)}s` +
    (r.wallSec > 7200 ? "  ← 残留，墙钟极长但 ASR 早已断开，不计费" : ""),
  );
}

const sum = (arr, k) => arr.reduce((a, b) => a + b[k], 0);
const audioTotal = sum(normal, "audioSec");
const wallTotal = sum(normal, "wallSec");

console.log("\n=== 合计（不含残留会话）===");
console.log(`会话数:              ${normal.length}`);
console.log(`有音频时长（下界）:  ${audioTotal} 秒 = ${(audioTotal / 3600).toFixed(3)} 小时`);
console.log(`墙钟时长（上界）:    ${wallTotal} 秒 = ${(wallTotal / 3600).toFixed(3)} 小时`);
console.log(`费用区间（@${PRICE_PER_HOUR}元/小时）: ${(audioTotal / 3600 * PRICE_PER_HOUR).toFixed(2)} ~ ${(wallTotal / 3600 * PRICE_PER_HOUR).toFixed(2)} 元`);

console.log("\n=== 残留会话（单列，不计费）===");
if (!residuals.length) console.log("  无");
for (const r of residuals) {
  console.log(`  ${r.short} 墙钟 ${(r.wallSec / 60).toFixed(0)} 分钟，有音频仅 ${r.audioSec}s，结束原因=${r.endReason ?? "-"}`);
}

console.log("\n=== 对账提示 ===");
console.log("  1. 云控制台「选择产品」必须是【实时语音识别】，不是【录音文件识别】。");
console.log("  2. 控制台数字应落在上面的「费用区间」内；若远超上界，说明有本脚本看不到的消耗");
console.log("     （例如本机之外的调用、或子账号）。");
console.log("  3. 若控制台为 0 而本表不为 0，先确认统计时间覆盖 2026-10-14 ~ 10-15。");
console.log("  4. 本表的「有音频」列取自 speech_intervals，而该时间轴在 2 个会话上被实测为");
console.log("     快于墙钟（见 docs/audio-clock-anomaly.md）。因此它只作下界参考，");
console.log("     **计费基准请以「墙钟时长」上界为准**。");

const outPath = path.join(__dirname, "..", "evidence", "usage-reconcile.json");
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  pricePerHour: PRICE_PER_HOUR,
  totals: { sessions: normal.length, audioSec: audioTotal, wallSec: wallTotal },
  sessions: rows,
}, null, 2), "utf8");
console.log(`\n已写出: ${outPath}`);

db.close();
