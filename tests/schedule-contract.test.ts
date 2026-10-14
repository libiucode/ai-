import { describe, it, expect } from "vitest";
import { SettingsSchema } from "../src/shared/schemas";

const BASE = { windowIntervalSec: 60 as const, windowSizeSec: 300 as const };

describe("Settings.schedule 契约", () => {
  it("无 schedule 时向后兼容（老数据仍可解析）", () => {
    const r = SettingsSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    expect(r.success && r.data.schedule).toBeUndefined();
  });

  it("完整 schedule 可解析并保留字段", () => {
    const r = SettingsSchema.safeParse({
      ...BASE,
      schedule: {
        enabled: true,
        startTime: "20:30",
        endTime: "23:00",
        weekdays: [1, 3, 5],
        audioSource: "systemLoopback",
        frameworkId: "fw-1",
      },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.schedule) {
      expect(r.data.schedule.startTime).toBe("20:30");
      expect(r.data.schedule.weekdays).toEqual([1, 3, 5]);
      expect(r.data.schedule.frameworkId).toBe("fw-1");
    }
  });

  it("空 weekdays 表示每天", () => {
    const r = SettingsSchema.safeParse({
      ...BASE,
      schedule: { enabled: true, startTime: "20:00", endTime: "23:00", weekdays: [] },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.schedule?.weekdays).toEqual([]);
  });

  it("非法时间格式被拒（这是保护，不是缺陷）", () => {
    for (const bad of ["25:00", "20:60", "8:00", "abc", ""]) {
      const r = SettingsSchema.safeParse({
        ...BASE,
        schedule: { enabled: true, startTime: bad, endTime: "23:00", weekdays: [] },
      });
      expect(r.success, `startTime=${JSON.stringify(bad)} 应被拒`).toBe(false);
    }
  });

  it("星期越界被拒", () => {
    const r = SettingsSchema.safeParse({
      ...BASE,
      schedule: { enabled: true, startTime: "20:00", endTime: "23:00", weekdays: [7] },
    });
    expect(r.success).toBe(false);
  });

  it("schedule 缺失时 audioSource 有默认值（界面可依赖）", () => {
    const r = SettingsSchema.safeParse({
      ...BASE,
      schedule: { startTime: "20:00", endTime: "23:00" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.schedule) {
      expect(r.data.schedule.enabled).toBe(false);
      expect(r.data.schedule.audioSource).toBe("systemLoopback");
      expect(r.data.schedule.weekdays).toEqual([]);
    }
  });
});
