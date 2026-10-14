/**
 * Renderer-side audio capture. Feeds Float32 frames to the main process via
 * window.appApi.sendAudioChunk; the main pipeline resamples/slices/queues.
 *
 * Microphone: getUserMedia with an explicit deviceId.
 * System loopback: getDisplayMedia({audio:true}) — Chromium exposes loopback
 * audio for a shared screen/window on Windows ("标签页/屏幕" share with audio).
 */

export interface CaptureHandle {
  stop(): void;
  sourceLabel: string;
}

/**
 * 采集健康判据。**同一套判据同时服务两处**（避免两处判定标准漂移）：
 *   - 启动自检：`startSession` 前调一次，确认设备存在、默认输出合理
 *   - 运行期健康检查：`wireStream` 内每 2 秒调一次
 *
 * 四级判据（从强到弱），只有前三级才判「设备故障」：
 *   L1 轨道 readyState === "ended"       → 轨道已死
 *   L2 轨道 muted 持续超过阈值            → 被系统静音（被独占/被切走）
 *   L3 目标设备从设备列表消失             → 设备被拔出/禁用
 *   L4 仅电平为 0（L1–L3 均正常）         → 判定为「内容静音」，不是故障
 *
 * 分流的理由：现有 5 秒无声告警把「设备坏了」和「没人说话」合并成一条信息，
 * 用户会去查音量，而真正该做的是换设备。设备已判故障时不应再弹无声告警。
 */
export type CaptureHealthState = "ok" | "deviceLost" | "muted" | "ended" | "stalled" | "silent";

export interface CaptureHealthInput {
  /** 当前音轨（麦克风或 loopback 都适用） */
  track: MediaStreamTrack | null;
  /** enumerateDevices() 的结果；为 null 表示本次未取到，跳过 L3 */
  devices: MediaDeviceInfo[] | null;
  /** 采集源类型，决定 L3 的比对语义 */
  source: "microphone" | "systemLoopback";
  /** 为麦克风源做 L3 比对用的 deviceId */
  deviceId: string | null;
  /** 当前电平 */
  level: number;
  /** muted 状态已持续的毫秒数 */
  mutedForMs: number;
  /** 电平持续为 0 多久才判「内容静音」 */
  silentForMs: number;
  /**
   * AudioContext 的真实状态（"running" / "suspended" / "interrupted" / "closed"）。
   * 这是音频图的真实状态，比「回调间隔」可靠——回调变慢只说明「没有音频要处理」，
   * 不等于链路故障。undefined 表示本次不判该级。
   */
  ctxState?: string;
}

export interface CaptureHealthResult {
  state: CaptureHealthState;
  /** 面向用户的原因说明（仅在故障态有意义） */
  reason: string | null;
}

/** 与 MonitorPage 的 SILENCE_LEVEL_THRESHOLD 保持一致 */
export const HEALTH_SILENCE_LEVEL = 0.005;
/** muted 持续多久才判故障。给系统切换设备留出恢复窗口。 */
export const HEALTH_MUTED_MS = 6000;
/** 电平持续为 0 多久才判「内容静音」 */
export const HEALTH_SILENT_MS = 5000;
/**
 * 距上次音频回调多久判「链路停摆」。
 *
 * ⚠️ 2026-10-15 复盘：这一级**不再使用回调计时作为判据**。
 * 原实现用「onaudioprocess 停更 ≥ 3 秒」，但回调变慢只说明「没有音频要处理」，
 * 在长静默段落（如纪录片无对白段）会正常发生——它和「内容静音」在语义上不可区分。
 * 现改为读 AudioContext 的真实状态（见 evaluateCaptureHealth 的 L4）。
 */
export const HEALTH_STALLED_MS = 3000;

/**
 * 纯函数判据：无副作用、不读全局，便于单测。
 */
export function evaluateCaptureHealth(input: CaptureHealthInput): CaptureHealthResult {
  const { track, devices, source, deviceId, level, mutedForMs, silentForMs, ctxState } = input;

  // L1：轨道已死
  if (!track || track.readyState === "ended") {
    return { state: "ended", reason: "音频采集轨道已结束。" };
  }

  // L2：被系统静音并持续超过阈值
  if (track.muted && mutedForMs >= HEALTH_MUTED_MS) {
    return {
      state: "muted",
      reason:
        source === "systemLoopback"
          ? "系统声音采集已被静音，可能默认输出设备被切换或被其他程序独占。"
          : "音频输入设备已被静音，可能被其他程序独占或设备已失效。",
    };
  }

  // L3：设备从列表消失
  if (devices && devices.length > 0) {
    if (source === "microphone" && deviceId) {
      const stillThere = devices.some((d) => d.kind === "audioinput" && d.deviceId === deviceId);
      if (!stillThere) {
        return { state: "deviceLost", reason: "所选音频输入设备已消失（被拔出或被禁用），请重新选择设备。" };
      }
    } else if (source === "systemLoopback") {
      // loopback 采的是「系统默认渲染设备的混音」，所以比对的是默认输出是否存在，
      // 而不是某个具体 deviceId。（本条为设计推导；loopback 轨道在切换默认输出时的
      // 确切行为尚未实测——见 docs/capture-device-health-design.md §6）
      const hasDefaultOutput = devices.some((d) => d.kind === "audiooutput");
      if (!hasDefaultOutput) {
        return { state: "deviceLost", reason: "系统已无可用音频输出设备，无法采集系统声音。" };
      }
    }
  }

  // L4：音频图停摆——读 AudioContext 的真实状态，而不是「回调间隔」。
  // 必须排在「内容静音」之前：音频图挂了时 level 也是 0，不能判成"没人说话"。
  // "suspended" / "interrupted" 是浏览器明确告知的音频图停止状态，
  // 正常静默下 ctx.state 仍是 "running"，因此这一级不会在静默时误报。
  if (ctxState === "suspended" || ctxState === "interrupted") {
    return {
      state: "stalled",
      reason: "音频采集引擎已停止（AudioContext 处于 " + ctxState + "），请重新开始监听。",
    };
  }

  // L5：只有电平为 0 → 内容静音，交给现有 5 秒无声告警，不判故障
  if (level < HEALTH_SILENCE_LEVEL && silentForMs >= HEALTH_SILENT_MS) {
    return { state: "silent", reason: null };
  }

  return { state: "ok", reason: null };
}


export interface CaptureStartResult {
  ok: true;
  handle: CaptureHandle;
}

export type CaptureStartError =
  | { code: "PERMISSION_DENIED"; message: string }
  | { code: "NO_DEVICE"; message: string }
  | { code: "NOT_SUPPORTED"; message: string }
  | { code: "START_FAILED"; message: string };

export async function startMicCapture(
  deviceId: string | null,
  onLevel: (level: number) => void,
  onEnded: () => void,
  onDeviceLost?: (reason: string) => void,
): Promise<CaptureStartResult | { ok: false; error: CaptureStartError }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
    });
    // 实际生效的 deviceId：显式指定时用指定的，否则回落到轨道真实绑定的设备。
    const actualId = deviceId ?? stream.getAudioTracks()[0]?.getSettings().deviceId ?? null;
    return {
      ok: true,
      handle: wireStream(stream, "麦克风", onLevel, onEnded, {
        source: "microphone",
        deviceId: actualId,
        onDeviceLost,
      }),
    };
  } catch (err) {
    const e = err as DOMException;
    if (e.name === "NotAllowedError") {
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "麦克风权限被拒绝。请在系统设置中允许本应用访问麦克风后重试。" } };
    }
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
      return { ok: false, error: { code: "NO_DEVICE", message: "未找到可用的音频输入设备。请插入麦克风或在设置中选择其他设备。" } };
    }
    return { ok: false, error: { code: "START_FAILED", message: `麦克风启动失败: ${e.message}` } };
  }
}

export async function startLoopbackCapture(
  onLevel: (level: number) => void,
  onEnded: () => void,
  onDeviceLost?: (reason: string) => void,
): Promise<CaptureStartResult | { ok: false; error: CaptureStartError }> {
  let stream: MediaStream;
  try {
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c: unknown) => Promise<MediaStream>;
    };
    if (!md.getDisplayMedia) {
      return { ok: false, error: { code: "NO_DEVICE", message: "当前环境不支持系统声音采集（需要屏幕共享能力）。" } };
    }
    stream = await md.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints,
    });
  } catch (err) {
    const e = err as DOMException;
    if (e.name === "NotAllowedError") {
      // Electron 下不存在 Chrome 的 share picker，也没有「勾选分享音频」这个选项——
      // 采集源由 main 的 setDisplayMediaRequestHandler 直接给出。所以不要再让用户去
      // 找那个不存在的勾选框，只如实说明可能的原因。
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "系统声音采集被拒绝或取消。请检查系统录音/屏幕录制权限是否已授予本应用，然后重试。" } };
    }
    if (e.name === "NotSupportedError") {
      // 2026-10-14 实测（Electron 33.4.11 / Chrome 130 / Win10）：main 进程未注册
      // setDisplayMediaRequestHandler 时，getDisplayMedia 直接抛 NotSupportedError。
      // 早先的注释把它归因为「系统版本/驱动/策略限制、不是应用故障」，这是误判——
      // 实测证明它同样是应用侧原因，且是当前最可能的原因。不要再向用户断言
      // 「与 app 无关」，也不要引导用户去装驱动或换机器；只说明需要排查采集源、
      // 权限与系统支持这三类原因。（Electron 的桌面选择器不是 Chrome 的 share picker，
      // 不存在「标签页共享/tabAudio」这个可勾选项，文档里不要这样写。）
      return {
        ok: false,
        error: {
          code: "NOT_SUPPORTED",
          message:
            "系统声音采集不可用：当前环境未能提供系统声音采集源（NotSupportedError）。" +
            "可能原因：应用未注册系统声音采集授权、屏幕录制权限未开启、或当前系统不支持回环采集。" +
            "请检查应用与系统的音频采集权限设置，或改用「开始麦克风监听」。",
        },
      };
    }
    return { ok: false, error: { code: "START_FAILED", message: `系统声音启动失败: ${e.message}` } };
  }
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    return {
      ok: false,
      error: {
        code: "NO_DEVICE",
        // 同 NotAllowedError：Electron 下没有「勾选分享音频」这一步，别指向不存在的 UI。
        message: "采集源没有提供音频轨道。请确认系统正在输出声音、输出设备未被静音，然后重试。",
      },
    };
  }
  // video track is unused; stop it to save resources but keep audio alive
  stream.getVideoTracks().forEach((t) => t.stop());
  return {
    ok: true,
    handle: wireStream(new MediaStream(audioTracks), "系统声音", onLevel, onEnded, {
      source: "systemLoopback",
      deviceId: null,
      onDeviceLost,
    }),
  };
}

function wireStream(
  stream: MediaStream,
  sourceLabel: string,
  onLevel: (level: number) => void,
  onEnded: () => void,
  opts: {
    source: "microphone" | "systemLoopback";
    deviceId: string | null;
    onDeviceLost?: (reason: string) => void;
  } = { source: "microphone", deviceId: null },
): CaptureHandle {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor keeps a stable, dependency-free tap on the raw samples.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // never play captured audio back to the user

  const stopped = { value: false };
  // 健康检查用的计时状态（不走 React state，避免每帧重渲染）
  const health = {
    lastLevel: 1,
    silentSince: 0,
    mutedSince: 0,
    deviceLostReported: false,
    lastChunkAt: Date.now(),
  };

  /**
   * 故障上报的可观测痕迹。
   *
   * 2026-10-15 复盘：此前判定故障后**不留任何痕迹**，导致事后无法归因是哪一级触发、
   * 是设备故障还是内容静音——那次只能靠数据库 status 旁证反推。故障路径必须留痕。
   *
   * 只写 console，不落盘、不改契约（契约由负责人维护）。
   */
  const reportFault = (level: string, reason: string, h: { lastLevel: number }) => {
    const line =
      `[capture-health] device-fault level=${level} reason="${reason}" ` +
      `level=${h.lastLevel.toFixed(6)} at=${new Date().toISOString()} ` +
      `source=${opts.source} deviceId=${opts.deviceId ?? "-"}`;
    // eslint-disable-next-line no-console
    console.warn(line);
  };

  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
    const level = sum / data.length;
    health.lastLevel = level;
    // 链路停摆判据（L4）依赖这个时间戳：回调不再触发时它不会更新。
    health.lastChunkAt = Date.now();
    onLevel(level);
    window.appApi.sendAudioChunk(new Float32Array(data), ctx.sampleRate);
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  stream.getAudioTracks().forEach((t) => {
    t.addEventListener("ended", () => {
      if (!stopped.value) onEnded();
    });
  });

  // 运行期健康检查：2 秒一次，独立于音频回调（enumerateDevices 是异步且相对重，
  // 挂在 onaudioprocess 上会拖累音频线程）。
  // 判据与启动自检共用 evaluateCaptureHealth()，避免两处标准漂移。
  const HEALTH_INTERVAL_MS = 2000;
  const healthTimer = window.setInterval(() => {
    if (stopped.value) return;
    const now = Date.now();
    if (health.lastLevel < HEALTH_SILENCE_LEVEL) {
      if (!health.silentSince) health.silentSince = now;
    } else {
      health.silentSince = 0;
    }

    const track = stream.getAudioTracks()[0] ?? null;
    if (track?.muted) {
      if (!health.mutedSince) health.mutedSince = now;
    } else {
      health.mutedSince = 0;
    }

    const buildInput = (devices: MediaDeviceInfo[] | null) =>
      evaluateCaptureHealth({
        track,
        devices,
        source: opts.source,
        deviceId: opts.deviceId,
        level: health.lastLevel,
        mutedForMs: health.mutedSince ? now - health.mutedSince : 0,
        silentForMs: health.silentSince ? now - health.silentSince : 0,
        ctxState: ctx.state,
      });

    // 快速路径：只处理**不依赖 enumerateDevices 且不会在静默时误报**的级别。
    // ⚠️ 2026-10-15 修复：早先这里用 `state !== "ok" && state !== "silent"` 兜住所有
    // 非 ok 状态，把基于「回调计时」的 stalled 也带了进来，而它在长静默段落会误报。
    // 现在显式白名单，只放 ended / muted 两个语义确定的级别。
    const fast = buildInput(null);
    if (fast.state === "ended" || fast.state === "muted") {
      if (!health.deviceLostReported) {
        health.deviceLostReported = true;
        reportFault("fast:" + fast.state, fast.reason ?? "音频采集设备异常。", health);
        opts.onDeviceLost?.(fast.reason ?? "音频采集设备异常。");
      }
      return;
    }

    // L3/L4 需要设备列表或等一个 tick，异步判
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (stopped.value) return;
        const full = buildInput(devices);
        if (
          (full.state === "deviceLost" || full.state === "ended" || full.state === "stalled") &&
          !health.deviceLostReported
        ) {
          health.deviceLostReported = true;
          reportFault("async:" + full.state, full.reason ?? "音频采集设备已失效。", health);
          opts.onDeviceLost?.(full.reason ?? "音频采集设备已失效。");
        }
      })
      .catch(() => {
        /* 枚举失败不视为故障，避免误报 */
      });
  }, HEALTH_INTERVAL_MS);

  return {
    sourceLabel,
    stop() {
      if (stopped.value) return;
      stopped.value = true;
      window.clearInterval(healthTimer);
      proc.onaudioprocess = null;
      try {
        proc.disconnect();
        src.disconnect();
        mute.disconnect();
      } catch {
        /* ignore */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
