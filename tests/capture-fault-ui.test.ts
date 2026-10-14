import { describe, it, expect } from "vitest";
import { shouldWarnSilence } from "../src/renderer/pages/captureFault";

/**
 * 设备故障 ↔ 无声告警 的互斥关系（UI 分流契约）。
 *
 * 测试直接调生产代码 shouldWarnSilence()，不抄判据——
 * 否则改坏 MonitorPage 里的真实逻辑，测试仍会通过，等于假安全。
 *
 * 背景：两种状态都表现为"没声音"，但用户该做的事完全不同——
 *   设备故障 → 换设备 / 重选音源
 *   内容静音 → 暂时没人说话，什么都不用做
 * 同屏会让人按错误提示去查音量；无人值守下等于整场没录到被当成正常静音忽略。
 */

describe("UI 分流：设备故障优先于无声告警", () => {
  it("设备正常 + 静音超 5 秒 → 报警", () => {
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 6000, deviceFault: false })).toBe(true);
  });

  it("设备故障 + 同样静音超 5 秒 → 不报警（关键回归点）", () => {
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 6000, deviceFault: true })).toBe(false);
  });

  it("设备故障 + 静音很久 → 仍不报警（不随时间推移漏出）", () => {
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 600_000, deviceFault: true })).toBe(false);
  });

  it("未在监听态 → 不报警（paused/idle 时无声是预期）", () => {
    for (const st of ["paused", "idle", "starting", "stopping", "completed", "error"]) {
      expect(shouldWarnSilence({ sessionState: st, quietForMs: 60_000, deviceFault: false }), st).toBe(false);
    }
  });

  it("监听态三种都算（capturing / reconnecting / analyzing）", () => {
    for (const st of ["capturing", "reconnecting", "analyzing"]) {
      expect(shouldWarnSilence({ sessionState: st, quietForMs: 6000, deviceFault: false }), st).toBe(true);
    }
  });

  it("静音未满 5 秒不报警，满 5 秒报警（边界）", () => {
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 4999, deviceFault: false })).toBe(false);
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 5000, deviceFault: false })).toBe(true);
  });

  it("设备故障解除后无声告警可重新出现（不是永久静音）", () => {
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 6000, deviceFault: true })).toBe(false);
    expect(shouldWarnSilence({ sessionState: "capturing", quietForMs: 6000, deviceFault: false })).toBe(true);
  });
});
