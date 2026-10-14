import { describe, it, expect } from "vitest";
import { END_REASON_LABEL, formatEndReason } from "../src/renderer/pages/endReason";
import type { SessionEndReason } from "../src/shared/contracts";

/**
 * 结束原因文案的完整性（历史页「会话信息 → 结束方式」用）。
 *
 * 直接调生产模块 formatEndReason / END_REASON_LABEL，不复刻文案表——
 * 复刻的话改坏真代码测试照样通过，等于假安全。
 *
 * 防的是两件事：
 *   1. 契约新增取值、界面忘了加文案 → 界面露出英文原样（如 "no-audio-timeout"）
 *   2. 老记录（end_reason 为 null）被瞎猜成某个原因
 */

const CONTRACT_REASONS: SessionEndReason[] = [
  "user",
  "schedule-window-end",
  "process-restart",
  "no-audio-timeout",
];

describe("结束原因文案", () => {
  it("契约里每个取值都有中文文案（否则界面会露出英文原样）", () => {
    for (const r of CONTRACT_REASONS) {
      const label = formatEndReason(r);
      expect(label, `缺少 ${r} 的文案`).toBeTruthy();
      expect(label).not.toBe(r);
      expect(/[\u4e00-\u9fff]/.test(label), `${r} 的文案应为中文，实际「${label}」`).toBe(true);
    }
  });

  it("null / undefined 显示「未记录」，不瞎猜原因", () => {
    expect(formatEndReason(null)).toContain("未记录");
    expect(formatEndReason(undefined)).toContain("未记录");
  });

  it("空串也显示「未记录」（?? 兜不住空串，会露出空白）", () => {
    // 回归点：曾用 `reason ?? "unknown"`，空串漏过去 → 界面显示「结束方式：」后面空白，
    // 看起来像界面坏了。改用 `||` 后由 unknown 兜底。
    expect(formatEndReason("" as unknown as SessionEndReason)).toContain("未记录");
  });

  it("未知取值不露出英文原样，兜到「未记录」", () => {
    expect(formatEndReason("some-future-reason" as unknown as SessionEndReason)).toContain("未记录");
  });

  it("手动结束与排期自动结束文案可区分", () => {
    expect(formatEndReason("user")).toContain("手动");
    expect(formatEndReason("schedule-window-end")).toContain("自动");
    expect(formatEndReason("user")).not.toBe(formatEndReason("schedule-window-end"));
  });

  it("进程异常退出如实说明异常，不弱化成普通结束", () => {
    expect(formatEndReason("process-restart")).toMatch(/异常|退出/);
  });

  it("无音频超时的文案说明是「自动结束」", () => {
    expect(formatEndReason("no-audio-timeout")).toContain("自动");
  });

  it("文案表覆盖 unknown 兜底键（formatEndReason 依赖它）", () => {
    expect(END_REASON_LABEL.unknown).toBeTruthy();
  });
});
