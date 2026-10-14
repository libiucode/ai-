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
): Promise<CaptureStartResult | { ok: false; error: CaptureStartError }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
    });
    return { ok: true, handle: wireStream(stream, "麦克风", onLevel, onEnded) };
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
      return { ok: false, error: { code: "PERMISSION_DENIED", message: "屏幕共享被取消。系统声音采集需要选择一个共享目标并勾选“分享音频”。" } };
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
        message: "共享目标没有提供音频。Windows 下请重新选择共享对象并勾选“分享音频”；播放系统声音的标签页/屏幕才有声音轨道。",
      },
    };
  }
  // video track is unused; stop it to save resources but keep audio alive
  stream.getVideoTracks().forEach((t) => t.stop());
  return { ok: true, handle: wireStream(new MediaStream(audioTracks), "系统声音", onLevel, onEnded) };
}

function wireStream(
  stream: MediaStream,
  sourceLabel: string,
  onLevel: (level: number) => void,
  onEnded: () => void,
): CaptureHandle {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor keeps a stable, dependency-free tap on the raw samples.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // never play captured audio back to the user
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
    onLevel(sum / data.length);
    window.appApi.sendAudioChunk(new Float32Array(data), ctx.sampleRate);
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  const stopped = { value: false };
  // 设备失效监听：被拔出/被独占/音频服务重启（设备哈希变化）时，已拿到的轨道会
  // 静默 ended——没有这个监听，应用会一直显示"采集中"却永远收不到音频。
  // 2026-10-14 实测：VB-CABLE 哈希变化后旧轨道死亡，用户看到"都正常但零字幕"。
  stream.getAudioTracks().forEach((t) => {
    t.addEventListener("ended", () => {
      if (!stopped.value) onEnded();
    });
  });
  return {
    sourceLabel,
    stop() {
      if (stopped.value) return;
      stopped.value = true;
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
