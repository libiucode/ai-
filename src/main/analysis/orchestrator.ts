import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import { Store } from "../storage/store";
import { TencentAsrAdapter } from "../asr/tencentAdapter";
import type { AsrFinalPayload, AsrPartialPayload } from "../asr/types";
import { WindowScheduler, segmentsInWindow } from "./windowScheduler";
import { computeMetrics, detectSpeechIntervals } from "./metrics";
import { issueDedupeKey } from "./deduplicate";
import { readRuntimeAsrConfig, readRuntimeLlmConfig } from "../security/runtimeConfig";
import { matchRules, ScriptLoopState } from "./ruleEngine";
import { LlmClient, type VerifiedAnalysisResult } from "./llmClient";
import { PcmResamplerSlicer, PACKET_MS, type AudioPacket } from "../capture/pcm";
import type {
  AppError,
  AsrStatus,
  AudioStatus,
  Framework,
  Issue,
  ScriptStatus,
} from "../../shared/contracts";
import type { Settings, StartSessionConfig } from "../../shared/schemas";
import { makeError } from "../security/errorFactory";

export class SessionOrchestrator {
  private store: Store;
  private win: BrowserWindow | null = null;
  private sessionId: string | null = null;
  private sessionStartEpoch = 0;
  private status: "idle" | "active" | "paused" | "stopping" | "stopped" = "idle";
  private asr = new TencentAsrAdapter();
  private llm = new LlmClient();
  private scheduler: WindowScheduler | null = null;
  private scriptState = new ScriptLoopState();
  /** 会话使用的话术框架（启动时缓存，每个分析窗口刷新，保存后下一窗生效） */
  private framework: Framework | null = null;
  private slicer = new PcmResamplerSlicer();
  private tickTimer: NodeJS.Timeout | null = null;
  private pendingPackets: AudioPacket[] = [];
  private asrAudioStartMs = 0;
  private asrAudioStarted = false;
  private finalCount = 0;
  private previousSummary = "";
  private previousFrameworkState: VerifiedAnalysisResult["frameworkState"] = undefined;
  /** LLM 配置态：会话开始判定一次，未配置时跳过语义分析但本地规则照常。 */
  private llmState: "configured" | "not_configured" | "budget_exceeded" = "not_configured";
  /** 同一错误码在会话内只提示一次，避免重复 callout 刷屏。 */
  private notifiedErrorCodes = new Set<string>();
  private lastErrorCode: string | null = null;
  private audioStatus: AudioStatus = {
    state: "idle",
    source: null,
    deviceId: null,
    level: 0,
    queueOverflowCount: 0,
    lastError: null,
  };
  private asrStatus: AsrStatus = {
    state: "idle",
    connectionId: null,
    reconnectAttempt: 0,
    lastPartialMs: 0,
    gapDetected: false,
    lastError: null,
  };
  private analysisRunning = false;
  private activeAnalysisRunId: string | null = null;
  private analysisQueued = false;

  constructor(store: Store) {
    this.store = store;
    this.asr.on("partial", (p) => this.handlePartial(p as AsrPartialPayload));
    this.asr.on("final", (p) => this.handleFinal(p as AsrFinalPayload));
    this.asr.on("status", (s) => {
      const st = s as Partial<AsrStatus>;
      if (st.state === "connected") {
        this.asrAudioStartMs = this.nowMs();
        this.asrAudioStarted = false;
        st.lastError = null;
      }
      this.asrStatus = { ...this.asrStatus, ...st };
      this.emit("asr.status", this.asrStatus);
    });
    this.asr.on("error", (e) => {
      const err = (e as { error: AppError }).error;
      this.asrStatus = { ...this.asrStatus, lastError: err, state: "error" };
      this.emit("asr.status", this.asrStatus);
      this.emit("app.error", err);
    });
  }

  setWindow(win: BrowserWindow | null) {
    this.win = win;
  }

  private nowMs(): number {
    return Date.now() - this.sessionStartEpoch;
  }

  private emit(event: string, payload: unknown) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(event, payload);
    }
  }

  get sessionIsActive(): boolean {
    return this.status === "active" || this.status === "paused" || this.status === "stopping";
  }

  async start(config: StartSessionConfig): Promise<{ sessionId: string; error: AppError | null }> {
    if (this.sessionIsActive) {
      return {
        sessionId: this.sessionId ?? "",
        error: makeError("SESSION_ALREADY_ACTIVE", "会话已在进行中", false),
      };
    }
    const sessionId = crypto.randomUUID();
    this.sessionId = sessionId;
    this.sessionStartEpoch = Date.now();
    this.status = "active";
    this.finalCount = 0;
    this.analysisRunning = false;
    this.analysisQueued = false;
    this.activeAnalysisRunId = null;
    this.previousSummary = "";
    this.previousFrameworkState = undefined;
    this.llm = new LlmClient();
    this.scriptState.reset(0);
    this.framework = this.store.listFrameworks()[0] ?? null;
    this.slicer = new PcmResamplerSlicer();
    this.pendingPackets = [];
    this.asrAudioStartMs = 0;
    this.asrAudioStarted = false;
    this.asrStatus = { state: "idle", connectionId: null, reconnectAttempt: 0, lastPartialMs: 0, gapDetected: false, lastError: null };
    this.audioStatus = { ...this.audioStatus, queueOverflowCount: 0 };

    this.store.createSession({
      id: sessionId,
      startedAtIso: new Date().toISOString(),
      audioSource: config.audioSource,
      deviceId: config.deviceId ?? null,
    });

    const settingsRaw = this.store.getSetting("app_settings");
    const settings: Settings = settingsRaw ? JSON.parse(settingsRaw) : {};
    const asrCfg = readRuntimeAsrConfig(this.store);
    if (asrCfg) {
      void this.asr.connect(asrCfg).catch(() => {
        this.emit("app.error", makeError("ASR_CONNECT_FAILED", "ASR 连接失败", true));
      });
    } else {
      this.emit("app.error", makeError("ASR_NOT_CONFIGURED", "尚未配置 ASR 环境密钥，音频将只做本地采集与指标", false));
    }
    const llmCfg = readRuntimeLlmConfig(this.store);
    // LLM 配置态在会话开始时判定一次：未配置就跳过语义分析，本地规则照常跑。
    // 不把配置态当运行故障，避免每个窗口重复抛同一条错误刷屏。
    this.llmState = llmCfg ? "configured" : "not_configured";
    this.notifiedErrorCodes = new Set();
    if (llmCfg) this.llm.configure(llmCfg);

    const intervalMs = (config.windowIntervalSec ?? settings.windowIntervalSec ?? 60) * 1000;
    const windowMs = (config.windowSizeSec ?? settings.windowSizeSec ?? 300) * 1000;
    try {
      this.scheduler = new WindowScheduler(intervalMs, windowMs, {
        getNow: () => this.nowMs(),
        getWindow: (s, e) => this.runAnalysis(s, e),
        onSkipped: (reason) => {
          this.analysisQueued = true;
          this.emit("analysis.status", this.analysisStatusSnapshot(`skipped:${reason};count=${this.scheduler?.skippedCount ?? 0}`));
        },
      });
      this.scheduler.start(0);
    } catch {
      this.scheduler = null;
    }

    this.audioStatus = {
      ...this.audioStatus,
      state: "capturing",
      source: config.audioSource,
      deviceId: config.deviceId ?? null,
      lastError: null,
    };
    this.emit("capture.status", this.audioStatus);

    this.tickTimer = setInterval(() => {
      if (this.status === "active") {
        this.scheduler?.tick(this.nowMs());
        // 话术步骤面板需要秒级刷新：阶段停留时长与超时状态
        this.emitScriptStatus();
      }
    }, 1000);

    this.emitScriptStatus();

    return { sessionId, error: null };
  }

  async pause() {
    if (this.status !== "active") return;
    this.status = "paused";
    this.store.updateSessionStatus(this.sessionId!, "paused");
    this.audioStatus = { ...this.audioStatus, state: "paused" };
    this.emit("capture.status", this.audioStatus);
    // 同步断开 ASR：否则服务端 15 秒收不到音频会主动掐连接（4008），
    // 适配器还会自动重连再被饿死，循环浪费连接与配额。恢复时重连。
    // 2026-10-14 用户实测：暂停 2 分钟收到 4008 + 满屏断线重连警告。
    try {
      await this.flushAudio();
      await this.asr.stop();
    } catch { /* best effort */ }
    this.asrStatus = { ...this.asrStatus, state: "closed" };
    this.emit("asr.status", this.asrStatus);
  }

  /**
   * 恢复监听。渲染层负责重启采集；主进程重新激活并重连 ASR
   * （暂停时已断开）。历史上没有 resume 通道，「继续」按钮只改 UI 状态，
   * 主进程永远停在 paused——字幕再也不来，只能结束会话重开。
   */
  async resume() {
    if (this.status !== "paused") return;
    this.pendingPackets = [];
    this.slicer.reset(this.nowMs());
    this.status = "active";
    this.store.updateSessionStatus(this.sessionId!, "active");
    this.audioStatus = { ...this.audioStatus, state: "capturing" };
    this.emit("capture.status", this.audioStatus);
    const asrCfg = readRuntimeAsrConfig(this.store);
    if (!asrCfg) return;
    void this.asr.connect(asrCfg).catch(() => {
      this.emit("app.error", makeError("ASR_CONNECT_FAILED", "ASR 连接失败", true));
    });
  }

  async stop() {
    if (!this.sessionIsActive || this.status === "stopping") return;
    this.status = "stopping";
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.scheduler?.dispose();
    try {
      await this.flushAudio();
      await this.asr.stop();
    } catch {
      /* best effort */
    }
    this.status = "stopped";
    this.store.updateSessionStatus(this.sessionId!, "stopped", new Date().toISOString());
    this.audioStatus = { ...this.audioStatus, state: "idle" };
    this.emit("capture.status", this.audioStatus);
    this.asrStatus = { ...this.asrStatus, state: "closed" };
    this.emit("asr.status", this.asrStatus);
  }

  /** Feeds raw audio from renderer (already mono Float32 at some rate). */
  ingestAudio(float32: Float32Array, sourceRate: number): void {
    if (this.status !== "active" || !this.sessionId) return;
    const packets = this.slicer.push(float32, sourceRate, this.nowMs());
    for (const p of packets) {
      for (const iv of detectSpeechIntervals([p])) {
        this.store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: this.sessionId, ...iv });
      }
      this.pendingPackets.push(p);
    }
    // bounded queue ~10s
    const maxPackets = Math.floor(10000 / PACKET_MS);
    if (this.pendingPackets.length > maxPackets) {
      this.pendingPackets = this.pendingPackets.slice(-maxPackets);
      this.audioStatus = {
        ...this.audioStatus,
        queueOverflowCount: this.audioStatus.queueOverflowCount + 1,
      };
      this.emit("capture.status", this.audioStatus);
      this.emit("app.error", makeError("CAPTURE_QUEUE_OVERFLOW", "音频队列已满，丢弃旧包", true));
    }
    // real-time pace: send packets older than now-500ms
    const sendUntil = this.nowMs() - 500;
    while (this.pendingPackets.length && this.pendingPackets[0].startMs < sendUntil) {
      const p = this.pendingPackets.shift()!;
      void this.sendPacket(p).catch(() => {
        /* adapter handles reconnection; drop packet */
      });
    }
  }

  private sendPacket(packet: AudioPacket): Promise<void> {
    if (this.asrStatus.state === "connected" && !this.asrAudioStarted) {
      // Tencent timestamps start at zero for each connection. Anchor them to
      // the first audio packet actually sent on that connection.
      this.asrAudioStartMs = packet.startMs;
      this.asrAudioStarted = true;
    }
    return this.asr.sendPcm(packet.pcm);
  }

  private async flushAudio(): Promise<void> {
    const tail = this.slicer.flush();
    const packets = this.pendingPackets.splice(0);
    if (tail) {
      if (this.sessionId) {
        for (const iv of detectSpeechIntervals([tail])) {
          this.store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: this.sessionId, ...iv });
        }
      }
      packets.push(tail);
    }
    if (this.asrStatus.state !== "connected") return;
    for (const packet of packets) {
      try { await this.sendPacket(packet); } catch { break; }
      // Keep the service's 1:1 real-time rate while sending the buffered tail.
      await new Promise((resolve) => setTimeout(resolve, packet.durationMs));
    }
  }

  private handlePartial(p: AsrPartialPayload) {
    if (!this.sessionId) return;
    this.asrStatus = { ...this.asrStatus, lastPartialMs: Date.now(), state: "connected" };
    this.emit("transcript.partial", {
      id: `partial:${p.connectionId}:${p.sourceSeq}`,
      sessionId: this.sessionId,
      connectionId: p.connectionId,
      sourceSeq: p.sourceSeq,
      startMs: this.asrAudioStartMs + p.startMs,
      endMs: this.asrAudioStartMs + p.endMs,
      text: p.text,
      isFinal: false,
      createdAt: new Date().toISOString(),
    });
  }

  private handleFinal(p: AsrFinalPayload) {
    if (!this.sessionId) return;
    const seg = {
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      connectionId: p.connectionId,
      sourceSeq: p.sourceSeq,
      startMs: this.asrAudioStartMs + p.startMs,
      endMs: this.asrAudioStartMs + p.endMs,
      text: p.text,
      isFinal: true,
      createdAt: new Date().toISOString(),
    };
    const inserted = this.store.insertSegment(seg);
    if (!inserted) return;
    this.finalCount++;
    // Speech duration comes from PCM VAD, independently of ASR segment length.
    const newPhase = this.scriptState.feed(seg.text, seg.endMs);
    if (newPhase) {
      // 阶段切换：推送结构化 script.status（替代以前塞进 analysis.status 的 phase:xxx 文本）
      this.emitScriptStatus();
    }
    this.emit("transcript.final", seg);
  }

  private analysisStatusSnapshot(note?: string) {
    return {
      running: this.analysisRunning,
      queued: this.analysisQueued,
      lastRunId: null,
      lastRunStatus: note ?? null,
      llm: this.llmState,
      lastErrorCode: this.lastErrorCode,
    };
  }

  /** 同一错误码会话内只 emit 一次 app.error，其余只在状态里体现。 */
  private emitAnalysisError(error: AppError) {
    if (this.notifiedErrorCodes.has(error.code)) return;
    this.notifiedErrorCodes.add(error.code);
    this.lastErrorCode = error.code;
    this.emit("app.error", error);
  }

  /** 推送话术阶段状态：阶段切换即时发，活跃期每秒随 tick 发（刷新停留时长与超时）。 */
  private emitScriptStatus() {
    const overdueNames = new Set(this.scriptState.overdueSteps(this.framework, this.nowMs()));
    const payload: ScriptStatus = {
      phase: this.scriptState.current,
      phaseElapsedMs: this.scriptState.elapsedMs(this.nowMs()),
      frameworkName: this.framework?.name ?? null,
      steps: (this.framework?.steps ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        priority: s.priority,
        maxWaitMs: s.maxWaitMs,
        overdue: overdueNames.has(s.name),
      })),
    };
    this.emit("script.status", payload);
  }

  private async runAnalysis(startMs: number, endMs: number) {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    const llm = this.llm;
    const emit = (event: string, payload: unknown) => {
      if (this.sessionId === sessionId) this.emit(event, payload);
    };
    this.analysisRunning = true;
    this.analysisQueued = false;
    const runId = crypto.randomUUID();
    this.activeAnalysisRunId = runId;
    let runStatus: "success" | "failed" | "timeout" = "success";
    this.store.insertAnalysisRun({
      id: runId,
      sessionId,
      windowId: crypto.randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
    });
    emit("analysis.status", { running: true, queued: false, lastRunId: runId, lastRunStatus: "running", llm: this.llmState, lastErrorCode: this.lastErrorCode });

    try {
      const segments = segmentsInWindow(
        this.store.querySegments({ sessionId, finalOnly: true, startMs, endMs }),
        startMs,
        endMs,
      );
      const intervals = this.store.querySpeechIntervals(sessionId, startMs, endMs);
      const metrics = computeMetrics(segments, intervals, startMs, endMs);

      const frameworkList = this.store.listFrameworks();
      const framework = frameworkList[0] ?? null;
      this.framework = framework;
      const issues: Issue[] = [];
      const issueSteps = new Map<string, string | null>();
      for (const seg of segments) {
        const hits = matchRules(seg.text, {
          framework,
          productFacts: framework?.productFacts ?? "",
        });
        for (const hit of hits) {
          if (hit.ruleType === "hotWord") continue;
          const id = crypto.randomUUID();
          issueSteps.set(id, hit.stepId ?? null);
          issues.push({
            id,
            sessionId,
            analysisRunId: runId,
            type: hit.ruleType as Issue["type"],
            severity: hit.ruleType === "bannedWord" ? "critical" : "warning",
            startMs: seg.startMs,
            endMs: seg.endMs,
            segmentIds: [seg.id],
            quote: hit.matchedText,
            basis: `命中规则 ${hit.ruleType}: ${hit.pattern}`,
            recommendation: "主播应立即调整表达，替换为合规说法",
            suggestedScript: null,
            confidence: 0.95,
            needsReview: hit.ruleType === "unverifiedClaim",
            status: "open",
          });
        }
      }
      // Silence remains an objective VAD metric; do not fabricate quotation evidence.

      const persisted: Issue[] = [];
      for (const issue of issues) {
        const dedupeKey = issueDedupeKey(issue, issueSteps.get(issue.id) ?? null);
        const outcome = this.store.upsertIssue(issue, dedupeKey);
        if (outcome === "created") persisted.push(issue);
      }

      if (segments.length > 0 && this.llmState !== "not_configured") {
        try {
          const llmResult = await llm.analyze({
            sessionId,
            framework,
            previousFrameworkState: this.previousFrameworkState,
            scriptPhase: { phase: this.scriptState.current, elapsedMs: Math.max(0, this.scriptState.elapsedMs(endMs)) },
            windowStartMs: startMs,
            windowEndMs: endMs,
            segments,
            rulesSummary: framework
              ? framework.rules.filter((r) => r.enabled).map((r) => `${r.ruleType}:${r.pattern}`).join(";")
              : "默认绝对化用语/未核实宣称规则",
            productFacts: framework?.productFacts ?? "",
            previousSummary: this.previousSummary,
            metrics,
          });
          for (const li of llmResult.issues) {
            const segsForIssue = li.segmentIds
              .map((id) => segments.find((s) => s.id === id))
              .filter((s): s is (typeof segments)[number] => !!s);
            if (!segsForIssue.length) continue;
            const issue: Issue = {
              id: crypto.randomUUID(),
              sessionId,
              analysisRunId: runId,
              type: li.type,
              severity: li.severity,
              startMs: Math.min(...segsForIssue.map((s) => s.startMs)),
              endMs: Math.max(...segsForIssue.map((s) => s.endMs)),
              segmentIds: li.segmentIds,
              quote: li.quote,
              basis: li.basis,
              recommendation: li.recommendation,
              suggestedScript: li.suggestedScript ?? null,
              confidence: li.confidence,
              needsReview: li.needsReview,
              status: "open",
            };
            issueSteps.set(issue.id, li.stepId ?? null);
            const dedupeKey = issueDedupeKey(issue, issueSteps.get(issue.id) ?? null);
            const outcome = this.store.upsertIssue(issue, dedupeKey);
            if (outcome === "created") persisted.push(issue);
          }
          if (this.sessionId === sessionId) {
            this.previousSummary = llmResult.frameworkStateSummary ?? this.previousSummary;
            this.previousFrameworkState = llmResult.frameworkState ?? this.previousFrameworkState;
          }
          this.store.finishAnalysisRun(runId, "success", new Date().toISOString(), null);
        } catch (err) {
          const appError = err as Partial<AppError> | null;
          runStatus = appError?.code === "LLM_TIMEOUT" ? "timeout" : "failed";
          if (appError?.code === "LLM_BUDGET_EXCEEDED") this.llmState = "budget_exceeded";
          const msg = appError?.code && appError.message ? `${appError.code}: ${appError.message}` : err instanceof Error ? err.message : "unknown";
          this.store.finishAnalysisRun(runId, runStatus, new Date().toISOString(), msg);
          this.emitAnalysisError(makeError(appError?.code ?? "ANALYSIS_LLM_FAILED", `LLM 分析失败: ${msg}`, true));
        }
      } else if (segments.length > 0) {
        // LLM 未配置：跳过语义分析，本地规则问题照常展示（上方已落库）。
        this.store.finishAnalysisRun(runId, "success", new Date().toISOString(), null);
      } else {
        this.store.finishAnalysisRun(runId, "success", new Date().toISOString(), null);
      }

      if (persisted.length > 0) {
        emit("analysis.issues", persisted);
      }
      emit("analysis.status", this.analysisStatusSnapshot(runStatus));
    } catch (err) {
      const appError = err as Partial<AppError> | null;
      const msg = appError?.code && appError.message ? `${appError.code}: ${appError.message}` : err instanceof Error ? err.message : "unknown";
      this.store.finishAnalysisRun(runId, "failed", new Date().toISOString(), msg);
      emit("analysis.status", this.analysisStatusSnapshot("failed"));
    } finally {
      if (this.activeAnalysisRunId === runId) {
        this.analysisRunning = false;
        this.activeAnalysisRunId = null;
      }
    }
  }

  getSnapshot() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      finalCount: this.finalCount,
      audio: this.audioStatus,
      asr: this.asrStatus,
    };
  }
}
