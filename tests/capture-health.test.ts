import { describe, it, expect } from "vitest";
import {
  evaluateCaptureHealth,
  HEALTH_MUTED_MS,
  HEALTH_SILENT_MS,
  HEALTH_SILENCE_LEVEL,
  type CaptureHealthInput,
} from "../src/renderer/capture/audioCapture";

/**
 * 采集健康判据单测。纯函数、无副作用，不触碰任何真实音频设备。
 *
 * 判据分工是这套实现的核心：
 *   L1 ended / L2 muted / L3 设备消失 / L4 音频图停摆 → 设备故障
 *   L5 仅电平为 0                                    → 内容静音（交给现有无声告警）
 * 关键回归点：设备故障时不能判成「内容静音」，否则用户会去查音量而不知道要换设备。
 */

function fakeTrack(over: Partial<{ readyState: string; muted: boolean }> = {}) {
  return {
    readyState: over.readyState ?? "live",
    muted: over.muted ?? false,
  } as unknown as MediaStreamTrack;
}

function fakeDevice(kind: string, deviceId: string) {
  return { kind, deviceId } as unknown as MediaDeviceInfo;
}

const base: CaptureHealthInput = {
  track: fakeTrack(),
  devices: [],
  source: "systemLoopback",
  deviceId: null,
  level: 0.5,
  mutedForMs: 0,
  silentForMs: 0,
};

describe("evaluateCaptureHealth", () => {
  it("一切正常 → ok", () => {
    expect(evaluateCaptureHealth({ ...base }).state).toBe("ok");
  });

  it("L1 轨道 ended → ended（即使电平看起来正常）", () => {
    const r = evaluateCaptureHealth({ ...base, track: fakeTrack({ readyState: "ended" }), level: 0.5 });
    expect(r.state).toBe("ended");
    expect(r.reason).toBeTruthy();
  });

  it("L1 轨道为 null → ended", () => {
    expect(evaluateCaptureHealth({ ...base, track: null }).state).toBe("ended");
  });

  // readyState 三态的显式覆盖（无人值守依赖「轨道真的活着」）
  it("L1 readyState='live' → 不判故障", () => {
    expect(evaluateCaptureHealth({ ...base, track: fakeTrack({ readyState: "live" }) }).state).toBe("ok");
  });

  it("L1 readyState='ended' → ended", () => {
    expect(evaluateCaptureHealth({ ...base, track: fakeTrack({ readyState: "ended" }) }).state).toBe("ended");
  });

  it("L1 readyState 为未知值（既非 live 也非 ended）→ 不误判故障", () => {
    // 只有明确的 "ended" 才判故障；未来 Chromium 新增状态不应导致误报。
    const r = evaluateCaptureHealth({ ...base, track: fakeTrack({ readyState: "unknown-future-state" }) });
    expect(r.state).toBe("ok");
  });

  it("L2 muted 未到阈值 → 不判故障（留出切换设备的恢复窗口）", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ muted: true }),
      mutedForMs: HEALTH_MUTED_MS - 1,
    });
    expect(r.state).toBe("ok");
  });

  it("L2 muted 达到阈值 → muted", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ muted: true }),
      mutedForMs: HEALTH_MUTED_MS,
    });
    expect(r.state).toBe("muted");
    expect(r.reason).toContain("静音");
  });

  it("L3 麦克风设备消失 → deviceLost", () => {
    const r = evaluateCaptureHealth({
      ...base,
      source: "microphone",
      deviceId: "dev-1",
      devices: [fakeDevice("audioinput", "dev-2")],
    });
    expect(r.state).toBe("deviceLost");
    expect(r.reason).toContain("重新选择设备");
  });

  it("L3 麦克风设备仍在 → ok", () => {
    const r = evaluateCaptureHealth({
      ...base,
      source: "microphone",
      deviceId: "dev-1",
      devices: [fakeDevice("audioinput", "dev-1")],
    });
    expect(r.state).toBe("ok");
  });

  it("L3 loopback 且系统无任何输出设备 → deviceLost", () => {
    const r = evaluateCaptureHealth({
      ...base,
      source: "systemLoopback",
      devices: [fakeDevice("audioinput", "mic-1")], // 只有输入，没有 audiooutput
    });
    expect(r.state).toBe("deviceLost");
  });

  it("L3 loopback 存在默认输出 → ok（哪怕电平为 0 且静音够久）", () => {
    const r = evaluateCaptureHealth({
      ...base,
      source: "systemLoopback",
      devices: [fakeDevice("audiooutput", "spk-1")],
      level: 0,
      silentForMs: HEALTH_SILENT_MS + 1000,
    });
    expect(r.state).toBe("silent");
  });

  it("devices 为 null（枚举失败）→ 跳过 L3，不误报", () => {
    const r = evaluateCaptureHealth({
      ...base,
      source: "microphone",
      deviceId: "dev-1",
      devices: null,
    });
    expect(r.state).toBe("ok");
  });

  it("L5 仅电平为 0 且够久 → silent（不是故障，reason 为 null）", () => {
    const r = evaluateCaptureHealth({
      ...base,
      level: HEALTH_SILENCE_LEVEL - 0.0001,
      silentForMs: HEALTH_SILENT_MS,
    });
    expect(r.state).toBe("silent");
    // 内容静音不给"故障原因"，由现有 5 秒无声告警负责提示
    expect(r.reason).toBeNull();
  });

  it("L5 电平为 0 但未够久 → ok", () => {
    const r = evaluateCaptureHealth({ ...base, level: 0, silentForMs: HEALTH_SILENT_MS - 1 });
    expect(r.state).toBe("ok");
  });

  it("设备故障优先于内容静音：muted 同时电平为 0 → muted 而非 silent", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ muted: true }),
      mutedForMs: HEALTH_MUTED_MS,
      level: 0,
      silentForMs: HEALTH_SILENT_MS + 5000,
    });
    expect(r.state).toBe("muted");
  });

  it("ended 优先于一切", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ readyState: "ended", muted: true }),
      mutedForMs: 99999,
      level: 0,
      silentForMs: 99999,
    });
    expect(r.state).toBe("ended");
  });
});

/**
 * L4「链路停摆」——2026-10-15 判据重做：
 * 原实现用「onaudioprocess 停更 ≥ 3 秒」，但**回调变慢只说明「没有音频要处理」**，
 * 在长静默段落（纪录片无对白段）会正常发生——它和「内容静音」语义不可区分，
 * 是「误判导致真实中断」的隐患。
 *
 * 现改为读 AudioContext 的真实状态。这一组的核心是最后两条：
 * **正常静默时绝不能判 stalled**。
 */
describe("L4 链路停摆（基于 AudioContext.state）", () => {
  it("ctxState='suspended' → stalled", () => {
    const r = evaluateCaptureHealth({ ...base, ctxState: "suspended" });
    expect(r.state).toBe("stalled");
    expect(r.reason).toContain("suspended");
  });

  it("ctxState='interrupted' → stalled", () => {
    expect(evaluateCaptureHealth({ ...base, ctxState: "interrupted" }).state).toBe("stalled");
  });

  it("ctxState='running' → 不判故障（这是正常态）", () => {
    expect(evaluateCaptureHealth({ ...base, ctxState: "running" }).state).toBe("ok");
  });

  it("未提供 ctxState → 不判该级（向后兼容）", () => {
    expect(evaluateCaptureHealth({ ...base }).state).toBe("ok");
  });

  // ★ 这两条是本次修复的核心回归：长静默不能触发 stalled
  it("★ 长静默 + ctxState 正常 → 判 silent 而非 stalled（修复前会误判）", () => {
    const r = evaluateCaptureHealth({
      ...base,
      level: 0,
      silentForMs: HEALTH_SILENT_MS + 60000, // 静默远超旧的 3 秒阈值
      ctxState: "running",
    });
    expect(r.state).toBe("silent");
    expect(r.state).not.toBe("stalled");
  });

  it("★ 静默 60 秒 + 轨道 live + ctx 正常 → 仍是 silent（不误报设备故障）", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ readyState: "live", muted: false }),
      level: 0,
      silentForMs: 60000,
      ctxState: "running",
      devices: [fakeDevice("audiooutput", "spk-1")],
    });
    expect(r.state).toBe("silent");
  });

  it("stalled 优先于 silent：音频图挂了且电平为 0 → stalled", () => {
    const r = evaluateCaptureHealth({
      ...base,
      level: 0,
      silentForMs: HEALTH_SILENT_MS + 9999,
      ctxState: "suspended",
    });
    expect(r.state).toBe("stalled");
  });

  it("设备故障优先于 stalled", () => {
    const r = evaluateCaptureHealth({
      ...base,
      track: fakeTrack({ muted: true }),
      mutedForMs: HEALTH_MUTED_MS,
      ctxState: "suspended",
    });
    expect(r.state).toBe("muted");
  });
});
