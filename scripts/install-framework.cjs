/**
 * 把 demo/framework-skincare-real.json 写入真实库（可重复执行）。
 *
 * 步骤：schema 校验 → 正则合法性校验 → 写入 → 回读核对。
 * 不触碰任何密钥，只写 frameworks / framework_steps / framework_rules 三张表。
 */
const fs = require("node:fs");

async function main() {
  const { app } = require("electron");
  await app.whenReady();

  const src = "D:/ai盯播工具/app/demo/framework-skincare-real.json";
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const fw = raw.framework;

  // 1. 手工等价校验（与界面导入的 FrameworkEditSchema 口径一致：
  //    id/name 非空、priority 只能 0/1/2、maxWaitMs 非负整数、ruleType 枚举、正则合法、
  //    stepId 必须指向本框架内已存在的步骤）
  const errs = [];
  if (!fw.id) errs.push("缺少 id");
  if (!fw.name) errs.push("缺少 name");
  if (!Array.isArray(fw.steps) || !fw.steps.length) errs.push("steps 为空");
  if (!Array.isArray(fw.rules)) errs.push("rules 缺失");
  for (const s of fw.steps || []) {
    if (!s.id || !s.name) errs.push(`步骤缺字段: ${JSON.stringify(s).slice(0, 60)}`);
    if (![0, 1, 2].includes(s.priority)) errs.push(`步骤 ${s.id} priority 非法`);
    if (!Number.isInteger(s.maxWaitMs) || s.maxWaitMs < 0) errs.push(`步骤 ${s.id} maxWaitMs 非法`);
    if (s.frameworkId !== fw.id) errs.push(`步骤 ${s.id} frameworkId 不匹配`);
  }
  for (const r of fw.rules || []) {
    if (!["bannedWord", "absolutization", "unverifiedClaim", "repetition", "hotWord"].includes(r.ruleType)) {
      errs.push(`规则 ${r.id} ruleType 非法: ${r.ruleType}`);
    }
    try {
      new RegExp(r.pattern);
    } catch (e) {
      errs.push(`规则 ${r.id} 正则非法: ${e.message}`);
    }
    if (r.frameworkId !== fw.id) errs.push(`规则 ${r.id} frameworkId 不匹配`);
    if (r.stepId && !fw.steps.some((s) => s.id === r.stepId)) errs.push(`规则 ${r.id} 的 stepId 不存在: ${r.stepId}`);
  }
  if (errs.length) {
    console.log("✗ 校验失败：");
    errs.forEach((e) => console.log("   -", e));
    app.exit(1);
    return;
  }
  console.log(`✓ 校验通过：${fw.steps.length} 个步骤 / ${fw.rules.length} 条规则`);

  // 2. 写入真实库
  const { Store } = require("D:/ai盯播工具/app/dist/main/main/storage/store.js");
  const { migrate } = require("D:/ai盯播工具/app/dist/main/main/storage/migrations.js");
  const DB = process.env.APPDATA + "/ai-live-monitor/live-monitor.db";
  const store = new Store(DB);
  migrate(store.db);

  store.saveFramework({
    id: fw.id,
    name: fw.name,
    productFacts: fw.productFacts,
    updatedAt: new Date().toISOString(),
    steps: fw.steps,
    rules: fw.rules,
  });
  console.log("✓ 已写入数据库");

  // 3. 回读核对
  const list = store.listFrameworks();
  console.log(`\n=== 回读：库中现有 ${list.length} 个框架 ===`);
  for (const f of list) {
    console.log(`  · ${f.name}  (id=${f.id})`);
    console.log(`    步骤 ${f.steps.length} / 规则 ${f.rules.length} / 商品事实 ${f.productFacts.length} 字`);
    console.log(`    启用规则 ${f.rules.filter((r) => r.enabled).length} 条`);
  }

  // 4. 实测：拿真实口播文本跑一遍，看能不能产出问题
  const { matchRules } = require("D:/ai盯播工具/app/dist/main/main/analysis/ruleEngine.js");
  const { parseFactAssertions, compareSegmentsAgainstFacts } = require("D:/ai盯播工具/app/dist/main/main/analysis/factCheck.js");
  const saved = store.listFrameworks().find((f) => f.id === fw.id);

  // 用库里真实口播（会话 2920b432 的 15:49–15:53）做验证
  const rows = store.db.prepare(
    `select text from transcript_segments
     where created_at >= '2026-10-14T15:49:00' and created_at <= '2026-10-14T15:53:30'
     order by created_at limit 16`,
  ).all();

  console.log(`\n=== 用真实口播验证（${rows.length} 条）===`);
  let hitTotal = 0;
  const seen = new Set();
  for (const r of rows) {
    const hits = matchRules(r.text, { framework: saved, productFacts: saved.productFacts });
    for (const h of hits) {
      hitTotal++;
      const key = `${h.ruleType}|${h.matchedText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  [${h.confidence === "statutory" ? "法定" : "规则"}] ${h.ruleType.padEnd(22)} "${h.matchedText}"`);
      console.log(`        原文: ${r.text.slice(0, 50)}`);
    }
  }
  console.log(`\n  合计命中 ${hitTotal} 处（去重后 ${seen.size} 类）`);

  // 5. 框架事实解析（通道 A 的输入）
  const facts = parseFactAssertions(saved.productFacts);
  console.log(`\n=== 框架事实可核对断言（通道 A 输入）===`);
  if (!facts.length) {
    console.log("  0 条 —— 本框架的事实是「合规约束」型，不含数值断言");
    console.log("  这是设计选择：护肤品的合规约束多为文字禁令（不得宣称医疗功效），");
    console.log("  而非「保温12小时」这类数值参数，故通道 A 在此框架下不产出，");
    console.log("  由规则引擎（上方命中）承担主要检出。");
  } else {
    facts.forEach((f) => console.log(`  · ${f.raw} → ${f.value}${f.unit} (${f.dimension})`));
  }

  store.close();
  app.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
