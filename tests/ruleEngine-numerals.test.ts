import { describe, it, expect } from "vitest";
import {
  matchRules,
  normalizeDigits,
  normalizePatternNumerals,
  type RuleHit,
} from "../src/main/analysis/ruleEngine";
import type { Framework } from "../src/shared/contracts";

/**
 * task-8：ruleEngine 数字归一化的边界与归因。
 *
 * 核心问题（2026-10-15 负责人派活时指出）：
 * 「7天」被 ASR 识别成「一天」→ 归一化为「1天」→ `\d+` 照样匹配。
 * 规则报了，但报的是**被识别偏差改过的事实**（主播说 7 天，报告说 1 天），
 * 且 quote 逐字来自原文，F3 证据校验也通——**报了个假问题还带着真证据**。
 *
 * 本次审计实测发现的第二个问题（更严重，已修）：
 * 规则只匹配数字簇的一部分时（`\d小时` 命中「25小时」的「5小时」），
 * 簇内字符的 map 全等于簇起点，反查把整个簇圈进 quote，
 * 于是 quote 里出现规则**根本没匹配**的文字（「二十五小时」）。
 * 这不是 quote 失真，是**证据造假**——比数字被改更不可接受。
 *
 * 归因纪律：每条发现必须标清 规则问题 / 上游识别问题 / 两者皆有。
 */

/** 只用默认规则（不带框架）。 */
const def = { framework: null, productFacts: "" };

/** 某个 ruleId 的命中列表（默认规则同时在跑，必须按 ruleId 过滤才能看清单条规则）。 */
const hitsOf = (hits: RuleHit[], ruleId: string): RuleHit[] => hits.filter((h) => h.ruleId === ruleId);

/** 构造一个只带指定规则的框架，隔离默认规则干扰。 */
function withRules(rules: Array<{ id: string; ruleType: string; pattern: string }>): Framework {
  return {
    id: "f",
    name: "测试框架",
    productFacts: "",
    updatedAt: new Date().toISOString(),
    rules: rules.map((r) => ({ ...r, enabled: true, stepId: null })),
    steps: [],
  } as unknown as Framework;
}

describe("normalizeDigits 中文数字折叠", () => {
  it("单位组合：二十五 → 25，且簇区间被记录", () => {
    const n = normalizeDigits("保温二十五小时");
    expect(n.text).toBe("保温25小时");
    // 簇「二十五」在归一化后占据 [2,4)
    expect(n.clusters).toEqual([{ start: 2, end: 4 }]);
    // 簇内两个字符的 map 都指向簇的原文起点 2
    expect(n.map[2]).toBe(2);
    expect(n.map[3]).toBe(2);
    // 簇后字符一对一
    expect(n.map[4]).toBe(5);
  });

  it("口语省略与规范读法：一百二 → 102、两万三 → 20003", () => {
    // 这些不是 bug，是中文口语读法的真实歧义。归一化按「字面位值」解释，
    // 不猜测口语省略（「一百二」口语常指 120）。如实反映字面，不猜。
    expect(normalizeDigits("一百二").text).toBe("102");
    expect(normalizeDigits("两万三").text).toBe("20003");
    expect(normalizeDigits("三万五").text).toBe("30005");
    expect(normalizeDigits("三千五").text).toBe("3005");
    expect(normalizeDigits("二三十").text).toBe("230");
  });

  it("纯阿拉伯数字不产生簇（原文与归一化文本一一对应）", () => {
    for (const t of ["1", "12", "123", "原价399", "只剩3件"]) {
      expect(normalizeDigits(t).clusters).toEqual([]);
      expect(normalizeDigits(t).text).toBe(t);
    }
  });

  it("「零」「〇」在位值组合里会折叠，单独出现时不折叠", () => {
    // 实测行为：`零风险`/`〇添加` 不折叠——「零」只在位值组合里才被折成 0。
    // 这是保守行为：宁可保留原文，也不把「零添加」（一个完整词）误读成数字。
    expect(normalizeDigits("零风险").text).toBe("零风险");
    expect(normalizeDigits("零风险").clusters).toEqual([]);
    expect(normalizeDigits("〇添加").clusters).toEqual([]);
    // 位值组合里的零会折叠。注意「二十零五」折成 25 而不是 205：
    // 尾随的「零」在 section 累加里贡献 0×10+5=5，这是**既有实现的已知字面行为**，
    // 本任务如实记录，不擅自改归一化算法（改了会动到所有数字规则的匹配）。
    expect(normalizeDigits("二十零五").text).toBe("25");
  });

  it("相邻中文数字合并成一个簇（「三零五」是 305，不是三个数）", () => {
    const n = normalizeDigits("三零五");
    expect(n.clusters).toHaveLength(1);
    expect(n.text).toBe("305");
  });
});

describe("规则与文本的数字形态统一", () => {
  it("规则里的中文数字也被折叠，因此规则与文本可比", () => {
    expect(normalizePatternNumerals("七天见效")).toBe("7天见效");
    expect(normalizePatternNumerals("原价399")).toBe("原价399");
    // 字符类里的中文数字同样被折叠
    expect(normalizePatternNumerals("第[一二三四五六七八九十\\d]+天")).toBe("第[1234567890\\d]+天");
  });

  it("中文原文也能命中写阿拉伯数字的默认规则", () => {
    const hits = matchRules("原价三百九十九", def);
    expect(hits.map((h) => h.matchedText)).toContain("原价三百九十九");
    // 这条命中是「归一化之后才匹配上的」：原文写中文数字，规则写阿拉伯数字
    expect(hits.find((h) => h.matchedText === "原价三百九十九")?.numeralNormalized).toBe(true);
  });

  it("阿拉伯数字原文的命中不带 numeralNormalized", () => {
    const hits = matchRules("原价399", def);
    expect(hits.map((h) => h.matchedText)).toContain("原价399");
    expect(hits.find((h) => h.matchedText === "原价399")?.numeralNormalized).toBeUndefined();
  });
});

describe("数字簇截断守卫（本次审计发现并修复的问题）", () => {
  it("规则只匹配簇的一部分：丢弃，不生成带无关文字的 quote", () => {
    // 「保温二十五小时」归一到「保温25小时」；自定义规则 `\d小时` 只匹配「5小时」，
    // 命中区间 [3,6) 与簇 [2,4) 部分相交 → 守卫必须丢掉这条命中。
    // 若不过滤，簇内字符 map 全等于簇起点，quote 会圈进规则没匹配的「保温」。
    const hits = matchRules("保温二十五小时", {
      framework: withRules([{ id: "r-partial", ruleType: "unverifiedClaim", pattern: "\\d小时" }]),
      productFacts: "",
    });
    // 默认规则仍整簇命中（这是对的），但**自定义规则这条必须不存在**。
    expect(hitsOf(hits, "r-partial")).toEqual([]);
    expect(hits.map((h) => h.matchedText)).toContain("保温二十五小时");
  });

  it("规则匹配整个簇：正常命中", () => {
    const hits = matchRules("保温二十五小时", {
      framework: withRules([{ id: "r-full", ruleType: "unverifiedClaim", pattern: "保温\\d+小时" }]),
      productFacts: "",
    });
    expect(hitsOf(hits, "r-full").map((h) => h.matchedText)).toEqual(["保温二十五小时"]);
    expect(hitsOf(hits, "r-full")[0].numeralNormalized).toBe(true);
  });

  it("贪婪 `\\d+` 从簇首吃到尾，守卫不拦、quote 正确", () => {
    // `\d+小时` 在归一化文本「保温25小时」上匹配 [2,6)，完整覆盖簇 [2,4)
    // → 不是部分相交 → 守卫不拦。quote 反查得「二十五小时」，正确。
    // 这条钉住：守卫只在**真的截断**时才拦，不会因为「规则没写中文」就误伤。
    const hits = matchRules("保温二十五小时", {
      framework: withRules([{ id: "r-greedy", ruleType: "unverifiedClaim", pattern: "\\d+小时" }]),
      productFacts: "",
    });
    expect(hitsOf(hits, "r-greedy").map((h) => h.matchedText)).toEqual(["二十五小时"]);
    expect(hitsOf(hits, "r-greedy")[0].numeralNormalized).toBe(true);
  });

  it("真正被截断的是「单个数字」规则：守卫拦下", () => {
    // `\d小时`（无 +）在「保温25小时」上只能匹配 [3,6)，从簇第二位开始
    // → 部分相交 → 守卫丢弃。这是守卫唯一该出手的形态。
    const hits = matchRules("保温二十五小时", {
      framework: withRules([{ id: "r-single", ruleType: "unverifiedClaim", pattern: "\\d小时" }]),
      productFacts: "",
    });
    expect(hitsOf(hits, "r-single")).toEqual([]);
  });

  it("默认规则（写阿拉伯数字）对中文原文整簇命中，不受守卫影响", () => {
    const hits = matchRules("保温二十五小时", def);
    expect(hits.map((h) => h.matchedText)).toContain("保温二十五小时");
    expect(hits[0].numeralNormalized).toBe(true);
  });

  it("lookahead 只覆盖部分簇同样被守卫拦住", () => {
    const hits = matchRules("保温二十五小时", {
      framework: withRules([{ id: "r-look", ruleType: "unverifiedClaim", pattern: "\\d(?=小时)" }]),
      productFacts: "",
    });
    expect(hitsOf(hits, "r-look")).toEqual([]);
  });

  it("守卫不误伤完整覆盖簇的命中", () => {
    // 「原价399现价二百五十九」：399 是原文阿拉伯数字（无簇），
    // 259 是中文簇 [7,10)。规则 `现价\s*\d+` 命中区间起于 6、完整覆盖簇。
    const hits = matchRules("原价399现价二百五十九", {
      framework: withRules([{ id: "r-cross", ruleType: "unverifiedClaim", pattern: "现价\\s*\\d+" }]),
      productFacts: "",
    });
    expect(hitsOf(hits, "r-cross").map((h) => h.matchedText)).toEqual(["现价二百五十九"]);
    expect(hitsOf(hits, "r-cross")[0].numeralNormalized).toBe(true);
  });

  it("无中文数字时守卫完全不介入", () => {
    // 「只剩3件」的 3 是原文阿拉伯数字、无簇 → `只剩\d+` 正常命中。
    // 这条钉住守卫只关心中文簇，不会影响纯阿拉伯数字文本。
    const hits = matchRules("只剩3件", def);
    expect(hits.map((h) => h.matchedText)).toContain("只剩3");
  });

  it("既有行为：`只剩\\d+` 要求「只剩」紧贴数字，中间插入「最后」即失配", () => {
    // 实测（改动前后一致）：「只剩最后3件」不命中——正则里「只剩」后紧跟 `\\d+`，
    // 「最后」两个字让模式失配。**这不是本次改动引入的，也不是归一化问题**
    // （文本里没有中文数字簇）。归因：默认规则覆盖缺口。
    // 本任务只如实钉住事实，不擅自加正则（补正则的误报代价要单独评估）。
    expect(matchRules("只剩最后3件", def)).toEqual([]);
    expect(matchRules("只剩3件", def).map((h) => h.matchedText)).toContain("只剩3");
  });
});

describe("「7天→1天」：数字语义被 ASR 识别改变（上游问题，规则不漏）", () => {
  it("规则命中两种写法，但 quote 忠实反映被改变后的原文", () => {
    // 归因：**上游识别问题**。规则本身行为正确（两种写法都命中），
    // 数字从 7 变 1 是 ASR 识别偏差，ruleEngine 无从判断原音频是什么。
    // 本测试钉住的是「规则不漏」这个既有行为，不是宣称「这是对的」。
    const seven = matchRules("连续七天就能见效", def);
    const one = matchRules("连续一天就能见效", def);
    expect(seven.map((h) => h.matchedText)).toEqual(["连续七天"]);
    expect(one.map((h) => h.matchedText)).toEqual(["连续一天"]);
    // 两者都命中同一条规则：规则不漏
    expect(seven[0].ruleId).toBe(one[0].ruleId);
  });

  it("数字被识别改变时，numeralNormalized 不成立（原文是阿拉伯数字）", () => {
    // 「一天」是中文数字 → 归一为「1天」，命中带 numeralNormalized。
    // 这意味着 quote 里的「一」不是「7」的误写，而是 ASR 识别出的另一个字。
    // ruleEngine 无法从文本区分「主播说一天」和「主播说七天被识别成一天」。
    const hits = matchRules("连续一天就能见效", def);
    expect(hits[0].numeralNormalized).toBe(true);
    expect(hits[0].matchedText).toBe("连续一天");
  });

  it("字面规则「七天见效」对中文写法命中（原规则缺中文变体，已能自归一再命中）", () => {
    // 历史规则 "七天见效" 是字面量；归一化把两边都折叠，因此中文原文也能命中。
    const hits = matchRules("坚持七天见效", def);
    expect(hits.map((h) => h.matchedText)).toContain("七天见效");
  });
});

describe("默认规则召回（归因清单用，不是补正则的依据）", () => {
  it("能抓到的常见违规话术", () => {
    const shouldHit = [
      ["这款产品保证有效", "保证"],
      ["百分之百有效", "百分之百"],
      ["全网最低价", "全网最低"],
      ["所有肤质都能用", "所有肤质"],
      ["没有任何副作用", "没有任何副作用"],
      ["原价399现在只要99", "原价399"],
      ["改善80%", "改善80%"],
      ["减重5斤", "减重5斤"],
      ["只剩3件", "只剩3"],
      ["销量第一", "销量第一"],
      ["专柜价都要五百多", "专柜价都要五百多"],
      ["连续用三十天就能看到效果", "连续用三十天"],
      ["第七天就能见效", "第七天就"],
      ["浓度35%", "浓度35%"],
    ] as const;
    for (const [text, quoted] of shouldHit) {
      const hits = matchRules(text, def);
      expect(hits.map((h) => h.matchedText), text).toContain(quoted);
    }
  });

  it("漏报的常见话术（归因：规则缺覆盖，不是 ASR 问题）", () => {
    // 归因结论：这些在默认规则里没有对应模式，文本写法本身也没有歧义，
    // 属于**规则覆盖缺口**。本条测试只钉住「当前确实漏」这个事实，
    // 作为后续是否补规则的依据——**补不补要单独评估误报代价**，
    // 本任务只负责把事实钉住，不擅自加正则。
    const misses = [
      "七天无理由退换", "无效退款", "假一赔十", "吃了就好", "一抹就白",
      "立竿见影", "药到病除", "零添加", "纯天然", "无副作用",
      "最后一天", "错过再等一年", "手慢无", "抢完就没了", "限量100份",
      "孕妇可以用", "婴儿也能用", "完全不刺激", "明星同款", "医生推荐",
    ];
    for (const text of misses) {
      expect(matchRules(text, def), text).toEqual([]);
    }
  });

  it("「最后一天」同时是漏报项与促单话术（归因：规则缺覆盖）", () => {
    // 「最后一天」在漏报清单里：它既不是绝对化也不是未核实宣称，
    // 属于催单话术，默认规则没有对应模式。
    expect(matchRules("最后一天", def)).toEqual([]);
  });
});
