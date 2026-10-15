import { describe, it, expect } from "vitest";
import { ScriptLoopState, matchRules, normalizeDigits } from "../src/main/analysis/ruleEngine";

/**
 * task-8 补测：阶段触发词排序 + 标点打断数字-单位组合。
 *
 * 归因纪律：每条发现标清 规则问题 / 上游识别问题 / 两者皆有。
 * 本文件只**钉住当前实测行为**并给出归因，不擅自改触发词或加正则
 * （改阶段判定会影响话术步骤覆盖，属话术分析范围；加正则有误报代价）。
 */

describe("阶段触发词排序：先匹配者胜，cta 永远打不赢同句竞争", () => {
  /**
   * 实测：`feed()` 按 PHASE_TRIGGERS 数组顺序取**第一个**命中的，
   * 而 cta 排在最后。所以一句话里同时含 productIntro 和 cta 关键词时，
   * 无论 cta 在句首还是句尾，都判成 productIntro。
   */
  it("cta 与 productIntro 同句：cta 输（无论先后顺序）", () => {
    // 归因：**规则问题**（排序）。不是 ASR 问题——文本没被改。
    const both = [
      "今天给大家介绍这款产品，大家点击小黄车下单",
      "大家点击小黄车下单，今天给大家介绍这款产品",
      "今天带来新品，拍一号链接",
      "拍一号链接，今天带来新品",
    ];
    for (const text of both) {
      expect(new ScriptLoopState().feed(text, 0), text).toBe("productIntro");
    }
  });

  it("cta 与 opening 同句：opening 赢（cta 在最后）", () => {
    const st = new ScriptLoopState();
    expect(st.feed("开场欢迎来到直播间，点击小黄车", 0)).toBe("opening");
    expect(new ScriptLoopState().feed("欢迎来到直播间，今天介绍这款面膜，点击小黄车下单", 0)).toBe("opening");
  });

  it("cta 单独成句时正常判为 cta", () => {
    const st = new ScriptLoopState();
    expect(st.feed("今天给大家介绍这款面膜", 0)).toBe("productIntro");
    expect(st.feed("大家点击小黄车下单", 1000)).toBe("cta");
  });
});

describe("cta 触发词 `.*号链接` 会误触发（误报）", () => {
  /**
   * 实测：`/.*号链接/` 的 `.*` 前缀让它匹配**任意位置**的「号链接」，
   * 含「型号链接」这类与促单无关的短语也判成 cta。
   *
   * 归因：**规则问题**（模式过宽）。
   * 误报方向——按「宁可漏一条，也不要报错一条」的纪律，
   * 本类问题比漏报更该修。但改阶段判定会影响话术步骤覆盖
   * （属话术分析范围），故**已报负责人，未擅自改**。
   */
  it("含「号链接」的非促单文本也被判 cta", () => {
    const falsePositives = ["型号链接不对", "号链接", "这个号链接", "下一号链接哦"];
    for (const text of falsePositives) {
      expect(new ScriptLoopState().feed(text, 0), text).toBe("cta");
    }
  });

  it("真实促单文本判 cta 仍正常", () => {
    expect(new ScriptLoopState().feed("这是3号链接", 0)).toBe("cta");
    expect(new ScriptLoopState().feed("大家点击小黄车下单", 0)).toBe("cta");
  });
});

describe("标点打断数字-单位组合（归因：两者皆有）", () => {
  /**
   * ASR 常在数字与单位之间插入标点（「二十五，小时」「80。%」），
   * 而默认规则的 `\s*` 只容忍空白、不容忍标点 → 失配。
   *
   * 归因：**两者皆有**——上游（ASR 插入了原文没有的标点）
   * + 规则（未容忍数字与单位之间的标点）。
   * 修任一侧都能缓解；本任务不擅自加正则（有误报代价），只钉住事实。
   */
  it("标点插在数字与单位之间 → 失配（原本会命中的规则不再命中）", () => {
    // 无标点：命中
    expect(matchRules("保温二十五小时", { framework: null, productFacts: "" }).map((h) => h.matchedText))
      .toContain("保温二十五小时");
    expect(matchRules("改善80%", { framework: null, productFacts: "" }).map((h) => h.matchedText))
      .toContain("改善80%");
    expect(matchRules("连续七天", { framework: null, productFacts: "" }).map((h) => h.matchedText))
      .toContain("连续七天");

    // 插入标点后全部失配
    expect(matchRules("保温二十五，小时", { framework: null, productFacts: "" })).toEqual([]);
    expect(matchRules("改善80。%", { framework: null, productFacts: "" })).toEqual([]);
    expect(matchRules("连续七、天", { framework: null, productFacts: "" })).toEqual([]);
    expect(matchRules("第7，天就有效", { framework: null, productFacts: "" })).toEqual([]);
  });

  it("小数点不是标点打断：3.5折 正常命中（规则里已含小数位）", () => {
    // 归因：**无误**。规则写了 `(?:\.\d+)?`，小数点是数字的一部分。
    expect(matchRules("3.5折", { framework: null, productFacts: "" }).map((h) => h.matchedText))
      .toEqual(["3.5折"]);
    expect(normalizeDigits("3.5折").clusters).toEqual([]);
  });

  it("中文句号被当成分隔符：三百.九十九 拆成两个簇（既有行为）", () => {
    // 归因：**上游问题**——「三百.九十九」是 ASR 的怪写法，
    // 归一化按字面拆成 300 和 99 两个簇。规则仍命中（因为 `原价\s*\d+` 吃到 300）。
    const n = normalizeDigits("原价三百.九十九");
    expect(n.clusters).toHaveLength(2);
    expect(n.text).toBe("原价300.99");
    expect(matchRules("原价三百.九十九", { framework: null, productFacts: "" }).map((h) => h.matchedText))
      .toContain("原价三百.九十九");
  });
});
