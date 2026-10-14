import { describe, it, expect } from "vitest";
import {
  CAPTURING_STATES,
  isAutoEndedError,
  nextStateOnAutoEnded,
  nextStateOnCaptureIdle,
  shouldStopCapture,
  type UiSessionState,
} from "../src/renderer/hooks/sessionEnd";

/**
 * 会话结束收敛判据（复核发现真缺陷后的回归网）。
 *
 * 缺陷原貌：排期到点自动结束时，主进程真 stop() 了（断 ASR、落库 stopped、
 * 发 app.error + capture.status(idle)），但渲染层没有任何订阅改状态机——
 * setUiState("completed") 只在手点结束的路径里。结果：会话已停、
 * 界面仍显示「监听中」、采集句柄继续喂音频。界面与实际状态脱节。
 *
 * 这些测试守住"收到结束信号必须收敛"这条不变式。
 */

const ALL: UiSessionState[] = [
  "idle", "starting", "capturing", "paused",
  "reconnecting", "analyzing", "stopping", "completed", "error",
];

describe("自动结束：状态机必须收敛", () => {
  it("任何非 completed 状态收到自动结束 → 一律落 completed", () => {
    for (const st of ALL) {
      expect(nextStateOnAutoEnded(st), st).toBe("completed");
    }
  });

  it("已在 completed 时保持不变（幂等，不重复触发渲染）", () => {
    expect(nextStateOnAutoEnded("completed")).toBe("completed");
  });

  it("与手点结束收敛到同一终态（两条路径必须一致）", () => {
    // 手点结束走 stopSession → completed；自动结束必须也是 completed
    expect(nextStateOnAutoEnded("capturing")).toBe("completed");
    expect(nextStateOnAutoEnded("analyzing")).toBe("completed");
  });
});

describe("采集回到 idle：界面必须落地", () => {
  it("正在跑的四种状态收到 idle → completed", () => {
    for (const st of CAPTURING_STATES) {
      expect(nextStateOnCaptureIdle(st), st).toBe("completed");
    }
  });

  it("paused 收到 idle → 保持 paused（暂停时采集本应已停，不收此信号）", () => {
    // 设计取舍：暂停态下会话仍活着（主进程 sessionIsActive 含 paused），
    // 主进程不会在暂停时 stop()。若此时收到 idle，属于异常时序——
    // 保守保留 paused，让用户还能「继续」，而不是把会话误判为已终结。
    // （doPause 已先停采集，正常流程下暂停期间不会再有采集事件。）
    expect(nextStateOnCaptureIdle("paused")).toBe("paused");
  });

  it("idle → idle、completed → completed（不做无意义跳转）", () => {
    expect(nextStateOnCaptureIdle("idle")).toBe("idle");
    expect(nextStateOnCaptureIdle("completed")).toBe("completed");
  });

  it("error 态不被 idle 信号覆盖（保留错误可见性）", () => {
    expect(nextStateOnCaptureIdle("error")).toBe("error");
  });
});

describe("该不该停采集句柄", () => {
  it("completed / idle 必须停", () => {
    expect(shouldStopCapture("completed")).toBe(true);
    expect(shouldStopCapture("idle")).toBe(true);
  });

  it("进行中/暂停时不该停（暂停要能恢复，进行中要能继续采）", () => {
    for (const st of ["starting", "capturing", "analyzing", "reconnecting", "paused"] as UiSessionState[]) {
      expect(shouldStopCapture(st), st).toBe(false);
    }
  });
});

describe("自动结束错误码识别", () => {
  it("SESSION_AUTO_ENDED 被识别", () => {
    expect(isAutoEndedError("SESSION_AUTO_ENDED")).toBe(true);
  });

  it("其他错误码不被误判（否则普通错误会误关会话）", () => {
    for (const code of ["ANALYSIS_LLM_FAILED", "ASR_CONNECT_FAILED", "CAPTURE_DEVICE_LOST", ""]) {
      expect(isAutoEndedError(code), code).toBe(false);
    }
  });
});
