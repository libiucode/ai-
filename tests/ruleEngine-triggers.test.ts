import { describe, it, expect } from "vitest";
import { ScriptLoopState, matchRules, normalizeDigits } from "../src/main/analysis/ruleEngine";

/**
 * task-8 补测：阶段触发词排序 + 标点打断数字-单位组合。
 *
 * 归因纪律：每条发现标清 规则问题 / 上游识别问题 / 两者皆有。
 *
 * 2026-10-15 task-8 收口更新：本文件原先钉住的是**修复前**的实测行为
 * （cta 排最后 → 同句竞争必输；`.*号链接` 过宽 → 误报）。
 * 话术分析已按「cta 排第一」修复（与 STEP_PHASE_KEYWORDS 口径统一），
 * 并把 `.*号链接` 收紧为 `[一二三四五六七八九十\d]+号链接`。
 * 因此下列断言从「钉住旧行为」改为「钉住修复后的期望行为」——
 * 这不是放宽测试，是把「已知错误」转成「已知正确」。
 */

describe("阶段触发词排序：cta 排第一，同句竞争应判 cta", () => {
  /**
   * 修复后实测：`PHASE_TRIGGERS` 里 cta 排第一，所以同句含 productIntro
   * 与 cta 关键词时判 cta——主播介绍完立刻催单是正常话术，
   * 报告该记「成交引导」而不是「产品介绍」。
   *
   * 归因：**规则问题**（排序），已修。
   */
  it("cta 与 productIntro 同句：cta 赢（无论先后顺序）", () => {
    const both = [
      "今天给大家介绍这款产品，大家点击小黄车下单",
      "大家点击小黄车下单，今天给大家介绍这款产品",
      "今天带来新品，拍一号链接",
      "拍一号链接，今天带来新品",
    ];
    for (const text of both) {
      expect(new ScriptLoopState().feed(text, 0), text).toBe("cta");
    }
  });

  it("cta 与 opening 同句：cta 赢", () => {
    expect(new ScriptLoopState().feed("开场欢迎来到直播间，点击小黄车", 0)).toBe("cta");
    expect(new ScriptLoopState().feed("欢迎来到直播间，今天介绍这款面膜，点击小黄车下单", 0)).toBe("cta");
  });

  it("单独成句时各自判对：介绍→productIntro，促单→cta，开场→opening", () => {
    expect(new ScriptLoopState().feed("今天给大家介绍这款面膜", 0)).toBe("productIntro");
    expect(new ScriptLoopState().feed("大家点击小黄车下单", 1000)).toBe("cta");
    expect(new ScriptLoopState().feed("开场欢迎来到直播间", 1000)).toBe("opening");
  });
});

describe("cta 触发词已收紧：「号链接」不再误触发（误报修复）", () => {
  /**
   * 修复前 `/.*号链接/` 的 `.*` 前缀匹配任意位置的「号链接」，
   * 连「型号链接不对」都判 cta。已收紧为 `[一二三四五六七八九十\d]+号链接`
   * ——「号」前必须是数字或中文数字（「3号链接」「一号链接」），
   * 不靠放宽 `.*` 换召回。
   *
   * 归因：**规则问题**（模式过宽），已修。
   */
  it("含「号链接」的非促单文本不再判 cta", () => {
    const falsePositives = ["型号链接不对", "号链接", "这个号链接", "下一号链接哦", "上一号链接"];
    for (const text of falsePositives) {
      expect(new ScriptLoopState().feed(text, 0), text).not.toBe("cta");
    }
  });

  it("真实促单文本判 cta 仍正常", () => {
    expect(new ScriptLoopState().feed("这是3号链接", 0)).toBe("cta");
    expect(new ScriptLoopState().feed("这是一号链接", 0)).toBe("cta");
    expect(new ScriptLoopState().feed("拍一号链接", 0)).toBe("cta");
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
