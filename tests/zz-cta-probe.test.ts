import { describe, it } from "vitest";
import { ScriptLoopState, matchRules, normalizeDigits } from "../src/main/analysis/ruleEngine";

describe("scratch cta + punctuation", () => {
  it("cta trigger ordering", () => {
    // 一句同时含 productIntro 与 cta 触发词
    const cases = [
      "今天给大家介绍这款产品，大家点击小黄车下单",
      "大家点击小黄车下单，今天给大家介绍这款产品",
      "今天带来新品，拍一号链接",
      "拍一号链接，今天带来新品",
      "开场欢迎来到直播间，点击小黄车",
      "欢迎来到直播间，今天介绍这款面膜，点击小黄车下单",
    ];
    for (const c of cases) {
      const st = new ScriptLoopState();
      console.log(`ORDER "${c}" -> ${st.feed(c, 0)}`);
    }
  });

  it("cta via separate segs", () => {
    const st = new ScriptLoopState();
    const seq = ["今天给大家介绍这款面膜", "大家点击小黄车下单"];
    const out: string[] = [];
    for (let i = 0; i < seq.length; i++) out.push(`${seq[i]} => ${st.feed(seq[i], i * 1000)}`);
    console.log("SEQ", JSON.stringify(out));
  });

  it("punctuation interrupting digit cluster", () => {
    for (const t of ["保温二十五，小时", "原价三百.九十九", "3.5折", "连续七、天", "改善80。%", "第7，天就有效"]) {
      const n = normalizeDigits(t);
      console.log(`PUNCT "${t}" -> ${JSON.stringify(n.text)} clusters=${JSON.stringify(n.clusters)}`);
      console.log(`   hits=${JSON.stringify(matchRules(t, { framework: null, productFacts: "" }).map((h) => h.matchedText))}`);
    }
  });

  it("cta keyword: does .*号链接 overtrigger", () => {
    for (const t of ["这是3号链接", "号链接", "这个号链接", "下一号链接哦", "型号链接不对"]) {
      const st = new ScriptLoopState();
      console.log(`CTAKEY "${t}" -> ${st.feed(t, 0)}`);
    }
  });
});
