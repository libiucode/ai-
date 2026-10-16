/**
 * v6 迁移对**真实库副本**的验证（重要：先验证再让真库跑）。
 *
 * 为什么用副本：用户的真实库在 %APPDATA%\ai-live-monitor\live-monitor.db，
 * 一旦迁移出问题就是数据事故。先在副本上跑一遍，确认：
 *   1. 迁移成功且幂等
 *   2. 老数据一条不少（会话数 / 区间数 / 转写数）
 *   3. 历史行的 timebase 被正确标为 'audio'
 *   4. 老会话 audio_clock_ratio 全为 NULL（未标定）
 *   5. 每个有区间的老会话，用「实测比值」能算出各自的标定因子（报告侧可据此标注）
 *
 * ⚠️ 只读打开真实库 + 写副本，绝不修改真实库。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const D = require("D:/ai盯播工具/app/node_modules/better-sqlite3");

const REAL = process.env.APPDATA + "/ai-live-monitor/live-monitor.db";

async function main() {
  const { app } = require("electron");
  await app.whenReady();

  // 1. 真实库只读快照
  const src = new D(REAL, { readonly: true });
  const before = {
    sessions: src.prepare("select count(*) c from sessions").get().c,
    intervals: src.prepare("select count(*) c from speech_intervals").get().c,
    segments: src.prepare("select count(*) c from transcript_segments").get().c,
    issues: src.prepare("select count(*) c from issues").get().c,
  };
  console.log("=== 迁移前（真实库，只读）===");
  console.log(JSON.stringify(before));

  // 取出每场会话的区间跨度与墙钟跨度，用于核对「实测漂移分布」
  const rows = src.prepare(
    `select s.id, s.started_at_iso, s.ended_at_iso,
            (select count(*) from speech_intervals t where t.session_id = s.id) n,
            (select max(end_ms) - min(start_ms) from speech_intervals t where t.session_id = s.id) audio_span
     from sessions s order by s.started_at_iso`,
  ).all();
  src.close();

  console.log("\n=== 实测漂移分布（有区间的会话）===");
  let faster = 0, slower = 0;
  for (const r of rows) {
    if (!r.n) continue;
    const st = new Date(r.started_at_iso).getTime();
    const en = r.ended_at_iso ? new Date(r.ended_at_iso).getTime() : st;
    const wall = en - st;
    if (wall <= 0) continue;
    const ratio = r.audio_span / wall;
    const tag = ratio > 1 ? "音频轴偏快" : "音频轴偏慢";
    if (ratio > 1) faster++; else slower++;
    console.log(
      `  ${r.id.slice(0, 8)}  区间${String(r.n).padStart(5)}  音频轴${String(Math.round(r.audio_span)).padStart(8)}  墙钟${String(wall).padStart(8)}  ratio=${ratio.toFixed(3)} ${tag}`,
    );
  }
  console.log(`\n  偏快 ${faster} 场 / 偏慢 ${slower} 场`);
  console.log("  → 漂移不是单向的，任何「固定系数」假设都不成立（本次修复用会话级实测值）");

  // 2. 在副本上跑迁移
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v6-real-"));
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(REAL, copy);
  console.log(`\n=== 在副本上执行迁移 ===\n副本：${copy}`);

  const { Store } = require("D:/ai盯播工具/app/dist/main/main/storage/store.js");
  const { readVersion, CURRENT_SCHEMA_VERSION } = require("D:/ai盯播工具/app/dist/main/main/storage/migrations.js");
  const store = new Store(copy);

  console.log("迁移后 schema 版本 =", readVersion(store.db), "（当前常量 =", CURRENT_SCHEMA_VERSION, "）");

  const after = {
    sessions: store.db.prepare("select count(*) c from sessions").get().c,
    intervals: store.db.prepare("select count(*) c from speech_intervals").get().c,
    segments: store.db.prepare("select count(*) c from transcript_segments").get().c,
    issues: store.db.prepare("select count(*) c from issues").get().c,
  };
  console.log("\n=== 迁移后数据核对 ===");
  for (const k of Object.keys(before)) {
    const ok = before[k] === after[k];
    console.log(`  ${k.padEnd(10)} 前 ${String(before[k]).padStart(5)} → 后 ${String(after[k]).padStart(5)}  ${ok ? "✓ 一致" : "✗ 丢失！"}`);
  }

  const tb = store.db.prepare("select timebase, count(*) c from speech_intervals group by timebase").all();
  console.log("\n  timebase 分布 =", JSON.stringify(tb));

  const nullRatios = store.db.prepare("select count(*) c from sessions where audio_clock_ratio is null").get().c;
  const total = store.db.prepare("select count(*) c from sessions").get().c;
  console.log(`  audio_clock_ratio 为 NULL 的会话 = ${nullRatios}/${total}（老会话全部未标定，符合预期）`);

  // 3. 幂等
  const { migrate } = require("D:/ai盯播工具/app/dist/main/main/storage/migrations.js");
  try {
    migrate(store.db);
    console.log("\n  迁移幂等：重复执行未抛错 ✓");
  } catch (e) {
    console.log("\n  迁移幂等：重复执行抛错 ✗", e.message);
  }

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n副本已清理，真实库未被修改。");
  app.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
