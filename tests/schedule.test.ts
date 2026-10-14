import { describe, it, expect } from "vitest";
import {
  nextScheduledStart,
  isWithinScheduleWindow,
  formatCountdown,
  scheduledEndAt,
} from "../src/shared/schedule";
import type { ScheduleConfig } from "../src/shared/contracts";

function cfg(patch: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    enabled: true,
    startTime: "20:00",
    endTime: "23:00",
    weekdays: [],
    audioSource: "systemLoopback",
    frameworkId: null,
    ...patch,
  };
}

// 2026-10-14 是周三（getDay() === 3）
const WED_1900 = new Date(2026, 9, 14, 19, 0, 0);
const WED_2100 = new Date(2026, 9, 14, 21, 0, 0);

describe("排期：下一次开始时间", () => {
  it("未启用时返回 null", () => {
    expect(nextScheduledStart(cfg({ enabled: false }), WED_1900)).toBeNull();
    expect(nextScheduledStart(undefined, WED_1900)).toBeNull();
  });

  it("当天还没到点 → 返回今天该时刻", () => {
    const next = nextScheduledStart(cfg(), WED_1900)!;
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(20);
    expect(next.getMinutes()).toBe(0);
  });

  it("当天已过点 → 顺延到明天", () => {
    const next = nextScheduledStart(cfg(), WED_2100)!;
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(20);
  });

  it("空 weekdays 等价于每天", () => {
    const next = nextScheduledStart(cfg({ weekdays: [] }), WED_2100)!;
    expect(next.getDate()).toBe(15);
  });

  it("只在指定星期触发（周三已过点、只配周五 → 跳到周五）", () => {
    const next = nextScheduledStart(cfg({ weekdays: [5] }), WED_2100)!;
    expect(next.getDay()).toBe(5); // 周五
    expect(next.getDate()).toBe(16);
  });

  it("时刻正好等于现在 → 不算已到，顺延到下一次（避免死循环）", () => {
    const exact = new Date(2026, 9, 14, 20, 0, 0);
    const next = nextScheduledStart(cfg(), exact)!;
    expect(next.getTime()).toBeGreaterThan(exact.getTime());
  });

  it("时间格式非法时返回 null（不抛异常）", () => {
    expect(nextScheduledStart(cfg({ startTime: "25:99" }), WED_1900)).toBeNull();
    expect(nextScheduledStart(cfg({ startTime: "" }), WED_1900)).toBeNull();
  });
});

describe("排期：是否在监听窗口内", () => {
  it("同日窗口内为 true，窗口外为 false", () => {
    expect(isWithinScheduleWindow(cfg(), WED_2100)).toBe(true);
    expect(isWithinScheduleWindow(cfg(), WED_1900)).toBe(false);
    expect(isWithinScheduleWindow(cfg(), new Date(2026, 9, 14, 23, 30))).toBe(false);
  });

  it("跨天窗口：20:00→02:00，凌晨 1 点仍算在窗口内", () => {
    const c = cfg({ startTime: "20:00", endTime: "02:00" });
    // 周三 21:00 → 在窗口内
    expect(isWithinScheduleWindow(c, WED_2100)).toBe(true);
    // 周四 01:00 → 仍属于周三排期的跨天窗口
    expect(isWithinScheduleWindow(c, new Date(2026, 9, 15, 1, 0))).toBe(true);
    // 周四 03:00 → 已出窗
    expect(isWithinScheduleWindow(c, new Date(2026, 9, 15, 3, 0))).toBe(false);
  });

  it("跨天窗口 + 限定星期：只配周三时，周四凌晨仍算（因为周三排的）", () => {
    const c = cfg({ startTime: "20:00", endTime: "02:00", weekdays: [3] });
    expect(isWithinScheduleWindow(c, new Date(2026, 9, 15, 1, 0))).toBe(true);
    // 周四凌晨那种"周五排期延续"则不成立
    expect(isWithinScheduleWindow(c, new Date(2026, 9, 16, 1, 0))).toBe(false);
  });

  it("未启用时永远 false", () => {
    expect(isWithinScheduleWindow(cfg({ enabled: false }), WED_2100)).toBe(false);
  });
});

describe("排期：窗口结束时刻", () => {
  it("同日窗口：窗口内返回当天的 endTime", () => {
    const end = scheduledEndAt(cfg(), WED_2100)!;
    expect(end.getDate()).toBe(14);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(0);
  });

  it("窗口外返回 null（窗口外手动开的会话不该被预约结束掐断）", () => {
    expect(scheduledEndAt(cfg(), WED_1900)).toBeNull();
    expect(scheduledEndAt(cfg(), new Date(2026, 9, 14, 23, 30))).toBeNull();
    expect(scheduledEndAt(cfg({ enabled: false }), WED_2100)).toBeNull();
    expect(scheduledEndAt(undefined, WED_2100)).toBeNull();
  });

  it("跨天窗口：当天 21:00 时结束在次日 02:00", () => {
    const c = cfg({ startTime: "20:00", endTime: "02:00" });
    const end = scheduledEndAt(c, WED_2100)!;
    expect(end.getDate()).toBe(15); // 次日
    expect(end.getHours()).toBe(2);
  });

  it("跨天窗口：次日凌晨 1:00 时结束在当天 02:00（不是再顺延一天）", () => {
    const c = cfg({ startTime: "20:00", endTime: "02:00" });
    const end = scheduledEndAt(c, new Date(2026, 9, 15, 1, 0))!;
    expect(end.getDate()).toBe(15);
    expect(end.getHours()).toBe(2);
  });

  it("结束时刻必定晚于 now，且不晚于 24 小时", () => {
    for (const at of [WED_2100, new Date(2026, 9, 15, 1, 0), WED_1900]) {
      const end = scheduledEndAt(cfg({ startTime: "20:00", endTime: "02:00" }), at);
      if (!end) continue;
      const delta = end.getTime() - at.getTime();
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(24 * 3600 * 1000);
    }
  });
});

describe("排期：倒计时文案", () => {
  it("小时级 / 分钟级 / 天级", () => {
    expect(formatCountdown(new Date(2026, 9, 14, 21, 0), new Date(2026, 9, 14, 19, 0))).toBe("2 小时 0 分后");
    expect(formatCountdown(new Date(2026, 9, 14, 19, 30), new Date(2026, 9, 14, 19, 0))).toBe("30 分钟后");
    expect(formatCountdown(new Date(2026, 9, 15, 22, 0), new Date(2026, 9, 14, 19, 0))).toBe("1 天 3 小时后");
  });

  it("已到点显示即将开始", () => {
    expect(formatCountdown(new Date(2026, 9, 14, 19, 0), new Date(2026, 9, 14, 19, 0))).toBe("即将开始");
  });
});
