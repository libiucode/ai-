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
  const seq = typeof result.slice_seq === "number" ? result.slice_seq : 0;
  const text = typeof result.result_text === "string" ? result.result_text : "";
  const sliceType = typeof result.slice_type === "number" ? result.slice_type : 0;
  const startMs = typeof result.start_time === "number" ? result.start_time : 0;
  const endMs = typeof result.end_time === "number" ? result.end_time : 0;
  const audioDuration =
    typeof m.audio_duration === "number" ? m.audio_duration : 0;

  return {
    type: sliceType === 2 ? "final" : "partial",
    seq,
    text,
    startMs: audioDuration > 0 ? Math.max(0, audioDuration - (endMs - startMs)) : startMs,
    endMs: audioDuration > 0 ? audioDuration : endMs,
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

  getConnectionId(): string | null {
    return this.connectionId;
  }

  async connect(config: AsrConfig): Promise<void> {
    const parsed = AsrConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw makeError("ASR_CONFIG_INVALID", "ASR 配置校验失败", false);
    }
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
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on("open", () => {
        this.reconnectAttempt = 0;
        this.emit("status", { state: "connected", connectionId: this.connectionId });
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data) => {
        this.handleMessage(String(data));
      });

      ws.on("error", (err) => {
        const error = makeError(
          "ASR_WS_ERROR",
          `ASR WebSocket 错误: ${err.message}`,
          true,
        );
        this.emit("error", { error } satisfies AsrErrorPayload);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      ws.on("close", () => {
        this.ws = null;
        this.emit("status", { state: this.shouldRun ? "reconnecting" : "closed" });
        if (!settled) {
          settled = true;
          reject(makeError("ASR_WS_CLOSED", "ASR 连接被关闭", true));
          return;
        }
        if (this.shouldRun) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.emit("status", { state: "reconnecting", reconnectAttempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(async () => {
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
    const seq = parsed.seq ?? 0;
    if (seq <= this.lastSeqSeen) return; // dedupe repeats
    this.lastSeqSeen = seq;

    if (parsed.type === "final") {
      this.emit("final", {
        connectionId: this.connectionId,
        sourceSeq: seq,
        text: parsed.text ?? "",
        startMs: parsed.startMs ?? 0,
        endMs: parsed.endMs ?? 0,
        voiceId: parsed.voiceId ?? "",
      } satisfies AsrFinalPayload);
    } else {
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
    if (!ws) return;
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      try {
        ws.send(JSON.stringify({ type: "end" }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve();
      }, 2000);
    });
  }

  on(event: AsrEvent, handler: AsrHandler): Unsubscribe {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}
