import { describe, it, expect } from "vitest";
import { matchRules, type RuleHit } from "../src/main/analysis/ruleEngine";
import type { Framework, FrameworkRule } from "../src/shared/contracts";

/**
 * 默认规则「确定度分级」回归测试。
 *
 * 背景（2026-10-16）：默认规则原为两个扁平 `string[]`，无法表达「这条比那条更确定」。
 * 结果是一刀切的「宁漏勿误报」被套在了性质不同的词上——
 * `假一赔十`（完整固定短语，误报风险为零）与 `保证`（宽泛模式，必须保守）
 * 被同等对待，导致前者静默漏报。
 *
 * 现引入 `confidence: "statutory" | "broad"` 分级。本文件钉住三件事：
 *   1. 契约：只有 statutory 命中带 confidence 字段，broad 命中形状不变
 *   2. 正例：12 条法定表述必须命中且为 statutory
 *   3. **反例：正常直播话术不得命中任何 statutory 规则**（本文件重心）
 *
 * 反例集来源：docs/plan-rule-confidence-tiering.md §4.3
 * ⚠️ 该 42 条为**构造输入**，不是真实直播回放（known-limitations 明确
 * 「干净的真实带货直播样本 = 0 场」）。它证明「在已知构造反例集上零误报」，
 * **不等于真实场景误报率为零**——真实误报率仍需抽检支撑，未抽检前
 * 不得对外宣称「零误报」。
 */

/** matchRules 的入参是 { framework, productFacts } 对象，不是 framework 本身。 */
const def = { framework: null as Framework | null, productFacts: "" };

/** 只取确定度为 statutory 的命中。 */
function statutoryHits(text: string): RuleHit[] {
  return matchRules(text, def).filter((h) => h.confidence === "statutory");
}

describe("确定度字段契约", () => {
  it("statutory 命中带 confidence: 'statutory'", () => {
    const hit = matchRules("假一赔十", def).find((h) => h.matchedText === "假一赔十");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe("statutory");
  });

  it("broad 命中**不带** confidence 字段（对象形状与改造前一致）", () => {
    const hits = matchRules("保证有效", def);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.confidence).toBeUndefined();
    }
  });

  it("broad 命中对象的键集合与改造前逐字一致", () => {
    const hit = matchRules("保证有效", def)[0];
    expect(Object.keys(hit).sort()).toEqual([
      "matchedText",
      "pattern",
      "ruleId",
      "ruleType",
      "stepId",
    ]);
  });

  it("statutory 命中对象的键集合多出 confidence", () => {
    // 用「药到病除」而非「假一赔十」：后者含中文数字「十」，
    // 会被 normalizeDigits 折叠并附带 numeralNormalized —— 那是既有机制
    // 正常工作，但会让本用例的键集合断言混入无关变量。
    const hit = matchRules("药到病除", def).find((h) => h.confidence === "statutory")!;
    expect(Object.keys(hit).sort()).toEqual([
      "confidence",
      "matchedText",
      "pattern",
      "ruleId",
      "ruleType",
      "stepId",
    ]);
  });

  it("含中文数字的 statutory 命中同时带 numeralNormalized（既有机制不回归）", () => {
    const hit = matchRules("假一赔十", def).find((h) => h.confidence === "statutory")!;
    expect(hit.numeralNormalized).toBe(true);
    // quote 仍必须是原文写法，不是折叠后的阿拉伯数字
    expect(hit.matchedText).toBe("假一赔十");
  });

  it("用户自配的框架规则不带 confidence（由用户自己定责）", () => {
    const rule: FrameworkRule = {
      id: "user-1",
      frameworkId: "fw",
      stepId: null,
      ruleType: "bannedWord",
      pattern: "用户禁用词",
      enabled: true,
    };
    const fw = { id: "fw", name: "t", steps: [], rules: [rule], productFacts: "", updatedAt: "" } as Framework;
    const hits = matchRules("这里出现了用户禁用词", { framework: fw, productFacts: "" });
    const hit = hits.find((h) => h.pattern === "用户禁用词");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeUndefined();
  });
});

describe("法定违规表述必须命中（statutory 正例）", () => {
  it.each([
    ["假一赔十", "假一赔十"],
    ["假一赔万", "假一赔万"],
    ["假一赔三", "假一赔三"],
    ["药到病除", "药到病除"],
    ["包治百病", "包治百病"],
    ["纯天然", "纯天然"],
    ["纯植物提取", "纯植物"],
    ["纯中药配方", "纯中药"],
    ["无副作用", "无副作用"],
    ["零添加", "零添加"],
    ["明星同款", "明星同款"],
    ["医生推荐", "医生推荐"],
    ["这是械字号产品", "械字号"],
  ])("%s → 命中 %s 且为 statutory", (text, quote) => {
    const hit = statutoryHits(text).find((h) => h.matchedText === quote);
    expect(hit, text).toBeDefined();
  });
});

describe("⛔ 反例：正常直播话术不得命中任何 statutory 规则（本文件重心）", () => {
  it.each([
    // 价格与促销
    "今天这款只要九十九",
    "原价三百九十九，现在下单立减一百",
    // 售后（法定权利用语——主播必须说，绝不能报）
    "七天无理由退换货",
    "支持七天无理由",
    "不满意可以退货",
    "不满意就退款",
    // 「纯」字家族的正常用法
    "纯棉材质",
    "纯色设计",
    "纯手工制作",
    "纯正口感",
    "纯牛奶",
    "纯棉的",
    // 「无」字家族
    "无门槛优惠券",
    "无忧购物",
    "无人直播",
    "无限回购",
    "无纺布",
    // 「零」字家族
    "零风险",
    "零门槛",
    "零首付",
    "零食",
    "零件",
    "零售价",
    // 成分相关
    "添加了保湿成分",
    "不添加防腐剂",
    "添加剂很多",
    // 「明星 / 医生」的正常用法
    "这个明星演的电视剧",
    "明星代言的产品很多",
    "有问题请看医生",
    "医生说的要遵医嘱",
    "专家门诊很难挂",
    // 「孕妇 / 婴儿」
    "宝宝的东西也有卖",
    "孕妇要慎用",
    "孕妇不建议使用",
    // 普通讲解
    "这款面膜补水效果不错",
    "坚持使用皮肤会变好",
    "成分很温和",
    "天然成分",
    "天然色素",
    "医用口罩",
    "医用酒精",
  ])("不得命中 statutory：%s", (text) => {
    expect(statutoryHits(text), text).toEqual([]);
  });
});

describe("有意不抓的表述（防回归，把取舍钉死）", () => {
  it.each([
    // 法定售后义务：不抓是**正确行为**，不是漏报
    "七天无理由退换",
    "七天无理由退换货",
    "支持七天无理由",
    // 「否认句」形态：主播在否认，报成违规是方向性错误
    "不能根治",
    "难以根治",
    "无法治愈",
    // 反向话术 / 疑问句极常见，抓「可以用」必然误伤
    "孕妇可以用吗",
    "孕妇不建议使用",
    // 正常售后
    "不满意可以退货",
    "不满意就退款",
  ])("不得作为 statutory 命中：%s", (text) => {
    expect(statutoryHits(text), text).toEqual([]);
  });
});

describe("真实素材回归（会话 2920b432 的 15:49–15:53 真人口播）", () => {
  it("真实口播「假一赔十」必须被抓到（这条此前静默漏报）", () => {
    // 真实转写原文第 15 条：
    // 「今天这场是品牌专场，所有货都是官方仓直发，支持专柜验货，假一赔十。」
    const text = "今天这场是品牌专场，所有货都是官方仓直发，支持专柜验货，假一赔十。";
    const hit = statutoryHits(text).find((h) => h.matchedText === "假一赔十");
    expect(hit).toBeDefined();
  });

  it("真实口播「七天无理由退换货」不得被抓（法定义务）", () => {
    const text = "我们现在做的是7天无理由退换货，而且赠送运费险。";
    expect(statutoryHits(text)).toEqual([]);
  });

  it("真实口播「所有肤质都可以放心食用」仍按既有 broad 规则命中（不回归）", () => {
    const text = "我在这里承诺，所有肤质都可以放心食用，没有任何刺激。";
    const broad = matchRules(text, def).filter((h) => h.confidence === undefined);
    expect(broad.length).toBeGreaterThan(0);
  });
});
