// 只读诊断：用户本机真实库的 schema 版本与列，以及「ASR 时间轴 > 会话墙钟」的异常会话。
// 背景：usage-reconcile.cjs 实测到本机库 schema_version=1 且无 end_reason 列，
// 与「迁移框架已实现」不符，必须查清是「从未启动过新版」还是「迁移没生效」。
const path = require("node:path");
const Database = require(path.join("D:\\ai盯播工具\\app", "node_modules", "better-sqlite3"));

const dbPath = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const db = new Database(dbPath, { readonly: true });

console.log("库:", dbPath);
console.log("\n=== schema_version 表内容 ===");
try {
  console.log(JSON.stringify(db.prepare("SELECT * FROM schema_version").all()));
} catch (e) {
  console.log("查询失败:", e.message);
}

console.log("\n=== sessions 列 ===");
console.log(db.prepare("PRAGMA table_info(sessions)").all().map((c) => `${c.name}:${c.type}`).join(", "));

console.log("\n=== 所有表 ===");
console.log(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(", "));

console.log("\n=== 异常：ASR 时间轴超过会话墙钟（不可能，除非基准不同）===");
const rows = db.prepare(
  `SELECT s.id, s.started_at_iso, s.ended_at_iso,
          (SELECT MAX(end_ms) FROM speech_intervals p WHERE p.session_id = s.id) AS spe,
          (SELECT MAX(end_ms) FROM transcript_segments t WHERE t.session_id = s.id) AS sege
   FROM sessions s`,
).all();
for (const r of rows) {
  const wall = r.ended_at_iso
    ? (new Date(r.ended_at_iso) - new Date(r.started_at_iso)) / 1000
    : null;
  const audio = Math.max(r.spe ?? 0, r.sege ?? 0) / 1000;
  if (wall !== null && audio > wall + 5) {
    console.log(`  ${r.id.slice(0, 8)} 墙钟 ${wall.toFixed(0)}s  但 ASR 时间轴到 ${audio.toFixed(0)}s（超出 ${(audio - wall).toFixed(0)}s）`);
    console.log(`     started=${r.started_at_iso} ended=${r.ended_at_iso}`);
  }
}

console.log("\n=== 检查 settings 表是否还有明文密钥字段 ===");
try {
  const raw = db.prepare("SELECT key, value FROM settings").all();
  for (const r of raw) {
    if (r.key === "app_settings") {
      let parsed = null;
      try { parsed = JSON.parse(r.value); } catch { /* ignore */ }
      const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      const llmKeys = parsed?.llm ? Object.keys(parsed.llm) : [];
      console.log(`  app_settings 顶层键: ${keys.join(", ")}`);
      console.log(`  app_settings.llm 键: ${llmKeys.join(", ") || "(无)"}`);
      const hasSecret = "api_key" in (parsed?.llm ?? {});
      console.log(`  ⚠ 是否含明文 llm.api_key: ${hasSecret ? "是（值不打印）" : "否"}`);
      const asrSecret = parsed?.asr ? Object.keys(parsed.asr) : [];
      console.log(`  app_settings.asr 键: ${asrSecret.join(", ") || "(无)"}`);
    } else {
      console.log(`  ${r.key} (长度 ${String(r.value).length})`);
    }
  }
} catch (e) {
  console.log("  查询失败:", e.message);
}

db.close();
