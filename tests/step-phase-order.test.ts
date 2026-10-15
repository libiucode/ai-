import { describe, it, expect } from "vitest";
import { inferStepPhase } from "../src/main/analysis/ruleEngine";
import type { FrameworkStep } from "../src/shared/contracts";

/**
 * 步骤名 → 阶段的推断顺序（2026-10-15 二轮）。
 *
 * 为什么专门测它：`STEP_PHASE_KEYWORDS` 是**顺序依赖**的——命中即返回，
 * 排在前面的先赢。话术分析在审计中提过：价格/售后/促单类步骤名常同时含
 * 「介绍」等词，若 `cta` 不排第一就会被误归到 `productIntro`。
 *
 * 这种顺序依赖在重构时很容易被无意破坏（有人觉得「按字母排更整齐」），
 * 所以必须用测试锁住，而不是靠注释提醒。
 *
 * 零额度：纯函数，构造步骤名即可。
 */

function step(name: string): FrameworkStep {
  return { id: "s1", frameworkId: "f1", name, priority: 1, maxWaitMs: 0 };
}

describe("步骤阶段推断：cta 必须优先于 productIntro", () => {
  it("同时含「介绍」与「下单」的步骤名 → 判 cta，不是 productIntro", () => {
    // 这是顺序依赖的核心用例：两个规则都会命中，必须 cta 赢。
    expect(inferStepPhase(step("介绍这款产品并引导下单"))).toBe("cta");
  });

  it("价格与售后类步骤名含「介绍」→ 仍判 cta", () => {
    expect(inferStepPhase(step("介绍价格与售后"))).toBe("cta");
    expect(inferStepPhase(step("介绍优惠与折扣"))).toBe("cta");
  });

  it("纯产品介绍（无促单词）→ 判 productIntro", () => {
    expect(inferStepPhase(step("介绍产品卖点与成分"))).toBe("productIntro");
  });

  it("互动类 → 判 interaction", () => {
    expect(inferStepPhase(step("读评论互动答疑"))).toBe("interaction");
  });

  it("开场类 → 判 opening", () => {
    expect(inferStepPhase(step("开场欢迎新来的朋友"))).toBe("opening");
  });

  it("STEP_PHASE_KEYWORDS 的第一项就是 cta（顺序锁）", () => {
    // 直接钉住顺序本身：将来有人重排数组，这条会红，
    // 比「某个用例判错」更快定位到根因。
    const first = inferStepPhase(step("下单"));
    expect(first).toBe("cta");
  });

  it("推断不出时返回 null，不猜测", () => {
    expect(inferStepPhase(step("随便什么名字"))).toBeNull();
  });
});
