/**
 * 真实库现状体检（只读）。
 *
 * 回答「现在能不能正常用」需要看真实数据，而不是看代码：
 * 1. schema 版本（v6 迁移是否已应用到真实库）
 * 2. 各表数据量与最新会话
 * 3. 新字段是否就位（timebase / audio_clock_ratio）
 * 4. 凭证状态（只报布尔，绝不打印密钥值）
 */
const D = require("D:/ai盯播工具/app/node_modules/better-sqlite3");

async function main() {
  const { app, safeStorage } = require("electron");
  await app.whenReady();

  const DB = process.env.APPDATA + "/ai-live-monitor/live-monitor.db";
  const db = new D(DB, { readonly: true });

  console.log("=== [1] schema ===");
  const ver = db.prepare("select max(version) v from schema_version").get().v;
  console.log("  当前版本 =", ver, "(代码常量 = 6)");

  console.log("\n=== [2] 数据量 ===");
  for (const t of ["sessions", "transcript_segments", "speech_intervals", "issues", "frameworks", "analysis_runs"]) {
    try {
      console.log(`  ${t.padEnd(20)} = ${db.prepare(`select count(*) c from ${t}`).get().c}`);
    } catch (e) {
      console.log(`  ${t.padEnd(20)} = 查询失败`);
    }
  }

  console.log("\n=== [3] 最新 3 场会话 ===");
  const rows = db.prepare(
    `select id, started_at_iso, ended_at_iso, status, audio_source,
            (select count(*) from transcript_segments t where t.session_id = s.id) segs,
            (select count(*) from issues i where i.session_id = s.id) iss
     from sessions s order by started_at_iso desc limit 3`,
  ).all();
  for (const r of rows) {
    console.log(`  ${r.started_at_iso.slice(0, 16)} ${r.audio_source.padEnd(14)} ${r.status.padEnd(8)} 转写${String(r.segs).padStart(4)} 问题${String(r.iss).padStart(3)}  ratio=${r.audio_clock_ratio ?? "NULL"}`);
  }

  console.log("\n=== [4] v6 新字段 ===");
  const ivCols = db.prepare("pragma table_info(speech_intervals)").all().map((c) => c.name);
  const sCols = db.prepare("pragma table_info(sessions)").all().map((c) => c.name);
  console.log("  speech_intervals.timebase 存在 =", ivCols.includes("timebase"));
  console.log("  sessions.audio_clock_ratio 存在 =", sCols.includes("audio_clock_ratio"));

  console.log("\n=== [5] 凭证状态（只报布尔，不打印值）===");
  console.log("  safeStorage 可用 =", safeStorage.isEncryptionAvailable());
  const raw = db.prepare("select value from settings where key='credential_store_v1'").get();
  if (!raw) {
    console.log("  界面存储的凭证 = 无");
  } else {
    const keys = Object.keys(JSON.parse(raw.value));
    console.log("  界面存储的凭证键 =", keys.join(", ") || "(空)");
    console.log("  是否含明文前缀 =", raw.value.includes("plain:"));
  }
  const envKeys = ["DSH_SECRET_TENCENT_ASR_SECRET_ID", "DSH_SECRET_TENCENT_ASR_SECRET_KEY", "DSH_SECRET_LLM_API_KEY"];
  console.log("  环境变量提供 =", envKeys.map((k) => `${k.replace("DSH_SECRET_", "")}:${process.env[k] ? "有" : "无"}`).join(" "));

  const asr = db.prepare("select value from settings where key='app_settings'").get();
  if (asr) {
    const j = JSON.parse(asr.value);
    console.log("  ASR AppID =", j.asr?.appId ?? "(未配置)");
    console.log("  LLM base_url =", j.llm?.base_url ?? "(未配置)", "| model =", j.llm?.model ?? "(未配置)");
  }

  db.close();
  app.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
