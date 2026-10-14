import WebSocket from "ws";
import type {
  AsrAdapter,
  AsrEvent,
  AsrHandler,
  AsrPartialPayload,
  AsrFinalPayload,
  AsrErrorPayload,
  Unsubscribe,
} from "./types";
import { AsrConfigSchema, type AsrConfig } from "../../shared/schemas";
import type { AppError } from "../../shared/contracts";
import { makeError } from "../security/errorFactory";
import { buildTencentAsrUrl } from "./tencentSign";
import crypto from "node:crypto";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Parses Tencent realtime ASR WebSocket JSON messages into normalized events.
 * Exported for fixture testing.
 */
export function parseTencentMessage(raw: string): {
  type: "partial" | "final" | "error" | "ignore";
  seq?: number;
  text?: string;
  startMs?: number;
  endMs?: number;
  voiceId?: string;
  code?: number;
  message?: string;
  sliceType?: number;
  offsetStartMs?: number;
  offsetEndMs?: number;
} {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { type: "ignore" };
  }
  if (typeof msg !== "object" || msg === null) return { type: "ignore" };
  const m = msg as Record<string, unknown>;
  const code = typeof m.code === "number" ? m.code : 0;
  if (code !== 0) {
    return {
      type: "error",
      code,
      message: typeof m.message === "string" ? m.message : "asr error",
    };
  }
  const result = m.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") return { type: "ignore" };

  const voiceId = typeof m.voice_id === "string" ? m.voice_id : "";
  const seq = typeof result.index === "number" ? result.index : 0;
  const text = typeof result.voice_text_str === "string" ? result.voice_text_str : "";
  const sliceType = typeof result.slice_type === "number" ? result.slice_type : 0;
  // 腾讯云文档：start_time/end_time 是"当前一段话结果在整个音频流中的起止时间"，
  // 即该连接内已送入音频的相对时间。audio_duration 是服务端累计收到的音频时长，
  // 只用于判断连接是否还有新音频，不能用来反推片段起止——反推会把
  // "上一句的结束时间"错当成"本句起点"，长时间直播下时间戳整体漂移。
  // 2026-10-14 联调结论：最终结果直接透传 start_time/end_time。
  const startMs = typeof result.start_time === "number" ? result.start_time : 0;
  const endMs = typeof result.end_time === "number" ? result.end_time : 0;

  return {
    type: sliceType === 2 ? "final" : "partial",
    seq,
    text,
    startMs,
    endMs,
    voiceId,
    sliceType,
    offsetStartMs: startMs,
    offsetEndMs: endMs,
  };
}

export class TencentAsrAdapter implements AsrAdapter {
  private ws: WebSocket | null = null;
  private config: AsrConfig | null = null;
  private connectionId: string | null = null;
  private voiceId: string | null = null;
  private handlers = new Map<AsrEvent, Set<AsrHandler>>();
  private reconnectAttempt = 0;
  private shouldRun = false;
  private url: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeqSeen = -1;
  private lastFinalSeq = -1;
  private lastPartialKey: string | null = null;

  getConnectionId(): string | null {
    return this.connectionId;
  }

  async connect(config: AsrConfig): Promise<void> {
    const parsed = AsrConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw makeError("ASR_CONFIG_INVALID", "ASR 配置校验失败", false);
    }
    // Explicitly replacing a connection must retire its socket and retry timer.
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const previous = this.ws;
    this.ws = null;
    previous?.terminate();
    this.config = parsed.data;
    this.shouldRun = true;
    this.reconnectAttempt = 0;
    await this.openNewConnection();
  }

  /**
   * 连接探测（「测试连接」专用）。与 connect 的关键区别：WebSocket open 之后不立即
   * 宣布成功——实测服务端鉴权失败是在 open 之后以错误帧到达的（假密钥下 open 后
   * 约 2ms 收到 code 4002「鉴权失败」，随后关闭）。只等 open 会把错误密钥误报为
   * “连接成功”。open 后进入 settleMs 裁决窗口：窗口内出现服务端错误帧或关闭即失败，
   * 静默则视为通过。探测期间禁止重连（服务端关闭就是结论）。
   */
  async probe(config: AsrConfig, settleMs = 1500): Promise<{ ok: boolean; error: AppError | null }> {
    let verdict: AppError | null = null;
    const offError = this.on("error", (p) => {
      if (!verdict) verdict = (p as { error: AppError }).error;
    });
    const offStatus = this.on("status", (s) => {
      if ((s as { state?: string }).state === "closed" && !verdict) {
        verdict = makeError("ASR_WS_CLOSED", "连接已被服务端关闭（鉴权失败或服务不可用）", true);
      }
    });
    try {
      await this.connect(config);
      this.shouldRun = false; // 探测不等重连；关闭即最终结论
      await new Promise((r) => setTimeout(r, settleMs));
      return verdict ? { ok: false, error: verdict } : { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err as AppError };
    } finally {
      offError();
      offStatus();
    }
  }

  private emit(event: AsrEvent, payload: unknown) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  private async openNewConnection(): Promise<void> {
    if (!this.config) return;
    this.voiceId = crypto.randomUUID();
    this.connectionId = crypto.randomUUID();
    this.lastSeqSeen = -1;
    this.lastFinalSeq = -1;
    this.lastPartialKey = null;

    const { url } = buildTencentAsrUrl({
      appId: this.config.appId,
      secretId: this.config.secretId,
      secretKey: this.config.secretKey,
      engineModelType: this.config.engineModelType,
      voiceId: this.voiceId,
      sampleRate: this.config.sampleRate,
      audioFormat: this.config.audioFormat,
      wordInfoEnabled: this.config.wordInfoEnabled,
      needvad: this.config.needvad,
      hotwordId: this.config.hotwordId,
    });
    // strip secrets from stored url for debug safety
    this.url = url.replace(/secretid=[^&]*/g, "secretid=***");
    void this.url;

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, { handshakeTimeout: 10000 });
      this.ws = ws;
      this.emit("status", { state: "connecting", connectionId: this.connectionId });

      ws.on("open", () => {
        if (this.ws !== ws || !this.shouldRun) {
          ws.terminate();
          return;
        }
        this.reconnectAttempt = 0;
        this.emit("status", { state: "connected", connectionId: this.connectionId, reconnectAttempt: 0, lastError: null });
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data) => {
        if (this.ws !== ws) return;
        this.handleMessage(String(data));
      });

      ws.on("error", (err) => {
        if (this.ws !== ws) return;
        const error = makeError(
          "ASR_WS_ERROR",
          `ASR WebSocket 错误: ${err.message}`,
          true,
        );
        if (this.shouldRun) this.emit("error", { error } satisfies AsrErrorPayload);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      ws.on("close", () => {
        if (!settled) {
          settled = true;
          reject(makeError("ASR_WS_CLOSED", "ASR 连接被关闭", true));
        }
        if (this.ws !== ws) return;
        this.ws = null;
        // 主动断开/掉线：标记转写缺口。orchestrator 会把这个标记透传给 UI 与
        // SessionSummary.hasGap，让用户知道这段时间没有转写，而不是让旧字幕
        // 冒充最新结果。方案第 16 节验收标准第 6 条要求断线有明确状态。
        this.emit("status", {
          state: this.shouldRun ? "reconnecting" : "closed",
          gapDetected: true,
        });
        if (this.shouldRun) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.emit("status", {
      state: "reconnecting",
      reconnectAttempt: this.reconnectAttempt,
      gapDetected: true,
    });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldRun) return;
      try {
        await this.openNewConnection();
      } catch {
        // openNewConnection already emits error + close triggers next retry
      }
    }, delay);
  }

  private handleMessage(raw: string) {
    const parsed = parseTencentMessage(raw);
    if (!this.connectionId) return;
    if (parsed.type === "error") {
      this.emit("error", {
        error: makeError(
          `ASR_REMOTE_${parsed.code}`,
          parsed.message ?? "ASR 返回错误",
          false,
        ),
      } satisfies AsrErrorPayload);
      return;
    }
    if (parsed.type === "ignore") return;
    // Tencent's index identifies a sentence, not a message: multiple partials
    // and the final all share it. Ignore stale/finalized sentences and exact
    // partial repeats, while allowing revisions and partial -> final promotion.
    if (!parsed.text?.trim()) return;
    const seq = parsed.seq ?? 0;
    if (seq < this.lastSeqSeen || seq <= this.lastFinalSeq) return;
    this.lastSeqSeen = seq;

    if (parsed.type === "final") {
      this.lastFinalSeq = seq;
      this.lastPartialKey = null;
      this.emit("final", {
        connectionId: this.connectionId,
        sourceSeq: seq,
        text: parsed.text ?? "",
        startMs: parsed.startMs ?? 0,
        endMs: parsed.endMs ?? 0,
        voiceId: parsed.voiceId ?? "",
      } satisfies AsrFinalPayload);
    } else {
      const key = JSON.stringify([seq, parsed.text, parsed.startMs, parsed.endMs]);
      if (key === this.lastPartialKey) return;
      this.lastPartialKey = key;
      this.emit("partial", {
        connectionId: this.connectionId,
        sourceSeq: seq,
        text: parsed.text ?? "",
        startMs: parsed.startMs ?? 0,
        endMs: parsed.endMs ?? 0,
      } satisfies AsrPartialPayload);
    }
  }

  async sendPcm(chunk: ArrayBuffer): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw makeError("ASR_NOT_CONNECTED", "ASR 未连接，无法发送音频", true);
    }
    return new Promise((resolve, reject) => {
      this.ws!.send(Buffer.from(chunk), (err) => {
        if (err) {
          reject(makeError("ASR_SEND_FAILED", err.message, true));
        } else {
          resolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* best effort */ }
        finish();
      }, 2000);
      const finish = () => {
        clearTimeout(timer);
        ws.removeListener("close", finish);
        if (this.ws === ws) this.ws = null;
        resolve();
      };
      ws.once("close", finish);
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        } else {
          // A handshake has no audio to finalize; terminate it immediately.
          ws.terminate();
        }
      } catch {
        try { ws.terminate(); } catch { /* best effort */ }
        finish();
      }
    });
  }

  on(event: AsrEvent, handler: AsrHandler): Unsubscribe {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}
