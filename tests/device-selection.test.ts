import { describe, it, expect } from "vitest";
import { normalizeDeviceId, resolveStoredDevice, toStoredDeviceId } from "../src/renderer/pages/deviceSelection";
import type { AudioDevice } from "../src/shared/contracts";

/**
 * 设备选择持久化判据（保存 / 读回 / 失效回落 / 清除）。
 *
 * 直接调生产模块，不复刻判据——复刻就是假安全。
 *
 * 背景：captureSelectDevice 曾是空实现（只校验类型不落库），
 * 设备选择只活在 React state 里，重启即丢。现在随 app_settings 落库，
 * 但「存的 id 已不存在」这条新路径必须显式处理。
 */

function dev(id: string, label = id): AudioDevice {
  return { id, label, kind: "microphone", isDefault: false };
}

describe("归一化", () => {
  it("null / undefined / 空串 / 纯空白 → null（都表示「用默认」）", () => {
    expect(normalizeDeviceId(null)).toBeNull();
    expect(normalizeDeviceId(undefined)).toBeNull();
    expect(normalizeDeviceId("")).toBeNull();
    expect(normalizeDeviceId("   ")).toBeNull();
  });

  it("有效 id 原样保留（去首尾空白）", () => {
    expect(normalizeDeviceId("mic-1")).toBe("mic-1");
    expect(normalizeDeviceId("  mic-1  ")).toBe("mic-1");
  });

  it("toStoredDeviceId：选默认写 null，用于清除已存值", () => {
    expect(toStoredDeviceId("")).toBeNull();
    expect(toStoredDeviceId("mic-2")).toBe("mic-2");
  });
});

describe("读回：库里存的 id 与当前设备列表核对", () => {
  const devices = [dev("mic-1"), dev("mic-2")];

  it("存的 id 仍存在 → 用它，不回落", () => {
    const r = resolveStoredDevice("mic-2", devices);
    expect(r.deviceId).toBe("mic-2");
    expect(r.fellBack).toBe(false);
    expect(r.fallbackReason).toBeNull();
  });

  it("🔴 存的 id 已消失 → 回落 + 明确告知（不能静默采错）", () => {
    const r = resolveStoredDevice("mic-99", devices);
    expect(r.deviceId).toBeNull();
    expect(r.fellBack).toBe(true);
    expect(r.fallbackReason).toContain("已不可用");
    // 原因必须可操作：告诉用户该重选，而不是只说"出错了"
    expect(r.fallbackReason).toContain("重新选择");
  });

  it("存的 id 为空/null → 用默认，且不算回落（用户就是这么选的）", () => {
    for (const v of [null, undefined, ""]) {
      const r = resolveStoredDevice(v, devices);
      expect(r.deviceId).toBeNull();
      expect(r.fellBack).toBe(false);
      expect(r.fallbackReason).toBeNull();
    }
  });

  it("设备列表为空 → 保守用默认且不报回落（避免误报）", () => {
    // 还没授权麦克风、或 enumerateDevices 失败时列表为空，
    // 此时无法判断 id 是否失效，报了就是误报。
    const r = resolveStoredDevice("mic-99", []);
    expect(r.deviceId).toBeNull();
    expect(r.fellBack).toBe(false);
    expect(r.fallbackReason).toBeNull();
  });

  it("存了 id 但设备列表里只有默认设备 → 回落", () => {
    const r = resolveStoredDevice("mic-99", [dev("default")]);
    expect(r.fellBack).toBe(true);
    expect(r.deviceId).toBeNull();
  });

  it("id 匹配要精确（不能前缀/子串误判为存在）", () => {
    const r = resolveStoredDevice("mic-2-extra", [dev("mic-2")]);
    expect(r.fellBack).toBe(true);
  });
});

describe("清除语义", () => {
  it("选默认麦克风 → 存 null，不留失效旧 id", () => {
    // 这是「清理语义」要求：不能留一个以后会误导的旧 id
    expect(toStoredDeviceId(null)).toBeNull();
    expect(toStoredDeviceId("")).toBeNull();
  });

  it("存 null 后读回 → 用默认，不报回落", () => {
    const r = resolveStoredDevice(null, [dev("mic-1")]);
    expect(r.fellBack).toBe(false);
    expect(r.deviceId).toBeNull();
  });
});
