import { describe, it, expect } from "vitest";
import {
  parseFactAssertions,
  compareTextAgainstFacts,
  compareSegmentsAgainstFacts,
} from "../src/main/analysis/factCheck";

/**
 * 框架「一致性比对」通道 A（数值核对）测试。
 *
 * 本文件的重心是**反例**，不是正例。
 * 项目纪律：误报摧毁信任（见 docs/known-limitations.md §3b.3）。
 * 因此每个「应当报」的用例，都配一个「看起来像但不应报」的对照。
 */

describe("事实解析：只解析得出可核对断言，其余静默跳过", () => {
  it("解析带单位的数值事实", () => {
    const facts = parseFactAssertions("实验室恒温测试12小时（25℃环境）");
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe(12);
    expect(facts[0].unit).toBe("小时");
    expect(facts[0].dimension).toBe("时长");
    expect(facts[0].baseValue).toBe(720);
  });

  it("解析容积事实", () => {
    const facts = parseFactAssertions("容量500mL");
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe(500);
    expect(facts[0].dimension).toBe("容积");
  });

  it("中文数字被折叠后仍能解析", () => {
    const facts = parseFactAssertions("保温二十五小时");
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe(25);
    expect(facts[0].baseValue).toBe(1500);
  });

  it("自由描述型事实解析不出断言（不报错、不硬凑）", () => {
    expect(parseFactAssertions("304不锈钢内胆")).toHaveLength(0);
    expect(parseFactAssertions("原装进口，海外直邮")).toHaveLength(0);
  });

  it("空文本与空行安全", () => {
    expect(parseFactAssertions("")).toHaveLength(0);
    expect(parseFactAssertions("\n\n  \n")).toHaveLength(0);
  });

  it("多行事实逐行解析", () => {
    const facts = parseFactAssertions("保温12小时\n容量500毫升\n304不锈钢内胆");
    expect(facts).toHaveLength(2);
  });

  it("合规规则说明行不得被当成商品参数（实测发现的误报来源）", () => {
    // 真实框架里的一行：「售后：7天无理由退换属平台法定规则，可以正常讲解，不视为违规」
    // 若不排除，会被解析成「时长=7天」的断言，之后主播说「30天无理由退换」就会误报。
    const facts = parseFactAssertions(
      "售后：7天无理由退换属平台法定规则，可以正常讲解，不视为违规",
    );
    expect(facts).toHaveLength(0);
  });

  it.each([
    "不得使用「立竿见影」等表述",
    "不得宣称医疗功效",
    "禁止承诺治愈任何疾病",
    "价格以商品页面实时信息为准",
    "注意：首次使用前清洗",
    "合规约束：不得做无条件承诺",
  ])("规则说明行被排除：%s", (line) => {
    expect(parseFactAssertions(line)).toHaveLength(0);
  });

  it("真实商品参数行仍能解析（排除规则不能过宽）", () => {
    const facts = parseFactAssertions("实验室恒温测试12小时（25℃环境）");
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe(12);
  });
});

describe("数值冲突：应当报", () => {
  const facts = parseFactAssertions("实验室恒温测试12小时");

  it("同量纲、数值不同 → 报冲突", () => {
    const c = compareTextAgainstFacts("这款保温杯保温24小时，非常耐用", facts);
    expect(c).toHaveLength(1);
    expect(c[0].fact.value).toBe(12);
    expect(c[0].spokenValue).toBe(24);
    expect(c[0].quote).toBe("24小时");
  });

  it("中文数字口播也能对上 → 报冲突", () => {
    const c = compareTextAgainstFacts("这款保温杯能保温二十五小时", facts);
    expect(c).toHaveLength(1);
    expect(c[0].spokenValue).toBe(25);
    // quote 必须逐字来自原文
    expect("这款保温杯能保温二十五小时").toContain(c[0].quote);
  });

  it("单位换算后不等 → 报冲突（框架12小时=720分钟，口播100分钟）", () => {
    const c = compareTextAgainstFacts("保温100分钟", facts);
    expect(c).toHaveLength(1);
    expect(c[0].spokenValue).toBe(100);
  });
});

describe("反例：看起来像冲突但绝不能报（误报摧毁信任）", () => {
  const facts = parseFactAssertions("实验室恒温测试12小时");

  it("数值一致 → 不报（正常复述）", () => {
    expect(compareTextAgainstFacts("这款保温12小时", facts)).toHaveLength(0);
  });

  it("单位换算后一致 → 不报（720分钟 = 12小时）", () => {
    expect(compareTextAgainstFacts("保温720分钟", facts)).toHaveLength(0);
  });

  it("量纲不同 → 不报（容积数值不能拿去比时长）", () => {
    expect(compareTextAgainstFacts("容量500毫升", facts)).toHaveLength(0);
  });

  it("对比语境 → 不报（这是增量描述，不是事实陈述）", () => {
    // 「比上一代多了200毫升」里的 200 不是对容量事实的陈述
    const capFacts = parseFactAssertions("容量500毫升");
    expect(compareTextAgainstFacts("比上一代多了200毫升", capFacts)).toHaveLength(0);
    expect(compareTextAgainstFacts("相比旧款提升了3小时", facts)).toHaveLength(0);
  });

  it("文本里没有数字-单位对 → 不报", () => {
    expect(compareTextAgainstFacts("这款产品保温效果非常好", facts)).toHaveLength(0);
  });

  it("空事实列表 → 绝不报", () => {
    expect(compareTextAgainstFacts("保温24小时", [])).toHaveLength(0);
  });

  it("空文本 → 不报", () => {
    expect(compareTextAgainstFacts("", facts)).toHaveLength(0);
  });

  it("无关数值（无单位）→ 不报", () => {
    expect(compareTextAgainstFacts("只剩下最后3件了", facts)).toHaveLength(0);
  });
});

describe("多值同句：只报真正不一致的那一项", () => {
  it("句中有两个同量纲数值，只有一个与事实不符", () => {
    const facts = parseFactAssertions("保温12小时");
    const text = "保温12小时，冷饮可保24小时";
    const c = compareTextAgainstFacts(text, facts);
    expect(c).toHaveLength(1);
    expect(c[0].spokenValue).toBe(24);
  });
});

describe("逐片段核对：冲突需带 segmentId 供证据门禁使用", () => {
  it("按片段产出冲突并带上 segmentId", () => {
    const facts = parseFactAssertions("容量500毫升");
    const segs = [
      { id: "seg-1", text: "大家好，欢迎来到直播间" },
      { id: "seg-2", text: "这款杯子容量800毫升" },
    ];
    const out = compareSegmentsAgainstFacts(segs, facts);
    expect(out).toHaveLength(1);
    expect(out[0].segmentId).toBe("seg-2");
    expect(out[0].quote).toBe("800毫升");
  });
});

describe("证据完整性：quote 必须是原文连续子串", () => {
  it("冲突 quote 逐字来自原文", () => {
    const facts = parseFactAssertions("保温12小时");
    const text = "咱们这个杯子可以保温48小时哦";
    const c = compareTextAgainstFacts(text, facts);
    expect(c).toHaveLength(1);
    expect(text).toContain(c[0].quote);
    expect(c[0].quote).toBe("48小时");
  });

  it("中文数字场景下 quote 仍取原文写法（不是折叠后的阿拉伯数字）", () => {
    const facts = parseFactAssertions("保温12小时");
    const text = "能保温四十八小时";
    const c = compareTextAgainstFacts(text, facts);
    expect(c).toHaveLength(1);
    expect(c[0].quote).toBe("四十八小时");
  });
});

describe("真实素材回归（会话 2920b432 的 15:49–15:53 真人口播）", () => {
  it("真实口播里的 300多 不会被当成冲突（无单位）", () => {
    const facts = parseFactAssertions("官方旗舰店售价399元");
    const text = "官方旗舰店平时都要300多，今天在我直播间直接给你打下来。";
    // 300 后面是「多」，不是可识别单位 → 不报
    expect(compareTextAgainstFacts(text, facts)).toHaveLength(0);
  });

  it("真实口播「坚持用7天」与框架「坚持使用14天」冲突可检出", () => {
    const facts = parseFactAssertions("坚持使用14天");
    const text = "坚持用7天，你就能看到肤色明显提亮。";
    const c = compareTextAgainstFacts(text, facts);
    expect(c).toHaveLength(1);
    expect(c[0].spokenValue).toBe(7);
    expect(c[0].fact.value).toBe(14);
  });

  it("真实口播「7天无理由退换货」属服务条款 → 不报（即使框架有时长事实）", () => {
    const facts = parseFactAssertions("坚持使用14天");
    const text = "我们现在做的是7天无理由退换货，而且赠送运费险。";
    expect(compareTextAgainstFacts(text, facts)).toHaveLength(0);
  });

  it("真实口播「3天内也能到」属物流时效 → 不报", () => {
    const facts = parseFactAssertions("坚持使用14天");
    const text = "拍下默认发顺丰空运江浙沪次日达，偏远地区3天内也能到。";
    expect(compareTextAgainstFacts(text, facts)).toHaveLength(0);
  });

  it("真实口播「连敷3天」是用法时长，与「坚持使用14天」冲突 → 报", () => {
    const facts = parseFactAssertions("坚持使用14天");
    const text = "这款面膜做完项目之后连敷3天，退红速度肉眼可见。";
    const c = compareTextAgainstFacts(text, facts);
    expect(c).toHaveLength(1);
    expect(c[0].spokenValue).toBe(3);
  });
});
