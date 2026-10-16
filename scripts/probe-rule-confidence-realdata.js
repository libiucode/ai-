/**
 * 规则库分级：真实素材回归（只读，不改任何数据）。
 *
 * 用途：用**真实库**里的转写验证新增的 statutory 规则是否产生误报。
 * 单元测试用的是构造输入，不能替代真实素材核对。
 *
 * ⚠️ 只读打开数据库，不写任何业务数据。
 */
const D = require("D:/ai盯播工具/app/node_modules/better-sqlite3");
const DB = process.env.APPDATA + "/ai-live-monitor/live-monitor.db";

async function main() {
  const { app } = require("electron");
  await app.whenReady();

  const { matchRules } = require("D:/ai盯播工具/app/dist/main/main/analysis/ruleEngine.js");
  const db = new D(DB, { readonly: true });

  // 只取真人质量段：2920b432 的 15:49–15:53（已知的真人口播，非 TTS）
  const rows = db.prepare(
    `select text from transcript_segments
     where created_at >= '2026-10-14T15:49:00' and created_at <= '2026-10-14T15:53:30'
     order by created_at`,
  ).all();

  console.log(`=== 真实素材：${rows.length} 条真人口播（2920b432 的 15:49–15:53）===\n`);

  let statTotal = 0;
  let broadTotal = 0;
  for (const r of rows) {
    const hits = matchRules(r.text, { framework: null, productFacts: "" });
    const stat = hits.filter((h) => h.confidence === "statutory");
    const broad = hits.filter((h) => h.confidence !== "statutory");
    statTotal += stat.length;
    broadTotal += broad.length;
    if (hits.length) {
      console.log("文本:", r.text.slice(0, 50));
      for (const h of hits) {
        console.log(`   [${h.confidence === "statutory" ? "法定" : "宽泛"}] ${h.ruleType} -> "${h.matchedText}"`);
      }
    }
  }
  console.log(`\n=== 汇总：statutory 命中 ${statTotal} 条 / broad 命中 ${broadTotal} 条 ===`);

  // 全库扫描：所有会话的转写，看 statutory 命中总量与内容
  const all = db.prepare("select text from transcript_segments").all();
  console.log(`\n=== 全库扫描（${all.length} 条转写）===`);
  const seen = new Map();
  for (const r of all) {
    for (const h of matchRules(r.text, { framework: null, productFacts: "" })) {
      if (h.confidence !== "statutory") continue;
      const key = h.matchedText;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(r.text.slice(0, 45));
    }
  }
  if (!seen.size) {
    console.log("全库无 statutory 命中");
  } else {
    for (const [quote, texts] of seen) {
      console.log(`\n命中 "${quote}" × ${texts.length}`);
      texts.slice(0, 3).forEach((t) => console.log("   上下文:", t));
    }
  }

  db.close();
  app.exit(0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
