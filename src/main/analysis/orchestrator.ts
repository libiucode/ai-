import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import { Store } from "../storage/store";
import { TencentAsrAdapter } from "../asr/tencentAdapter";
import type { AsrFinalPayload, AsrPartialPayload } from "../asr/types";
import { WindowScheduler, segmentsInWindow } from "./windowScheduler";
import { computeMetrics } from "./metrics";
import { matchRules, ScriptLoopState } from "./ruleEngine";
import { LlmClient } from "./llmClient";
import { PcmResamplerSlicer, PACKET_MS, type AudioPacket } from "../capture/pcm";
import type {
  AppError,
  AsrStatus,
  AudioStatus,
  Issue,
} from "../../shared/contracts";
import type { Settings, StartSessionConfig } from "../../shared/schemas";
import { makeError } from "../security/errorFactory";

export class SessionOrchestrator {
  private store: Store;
  private win: BrowserWindow | null = null;
  private sessionId: string | null = null;
  private sessionStartEpoch = 0;
  private status: "idle" | "active" | "paused" | "stopped" = "idle";
  private asr = new TencentAsrAdapter();
  private llm = new LlmClient();
  private scheduler: WindowScheduler | null = null;
  private scriptState = new ScriptLoopState();
  private slicer = new PcmResamplerSlicer();
  private tickTimer: NodeJS.Timeout | null = null;
  private pendingPackets: AudioPacket[] = [];
  private finalCount = 0;
  private previousSummary = "";
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
  private analysisQueued = false;

  constructor(store: Store) {
    this.store = store;
    this.asr.on("partial", (p) => this.handlePartial(p as AsrPartialPayload));
    this.asr.on("final", (p) => this.handleFinal(p as AsrFinalPayload));
    this.asr.on("status", (s) => {
      const st = s as Partial<AsrStatus>;
      this.asrStatus = { ...this.asrStatus, ...st };
      this.emit("asr.status", this.asrStatus);
    });
    this.asr.on("error", (e) => {
      const err = (e as { error: AppError }).error;
      this.asrStatus = { ...this.asrStatus, lastError: err, state: "error" };
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
    return this.status === "active" || this.status === "paused";
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
    this.previousSummary = "";
    this.scriptState.reset(0);
    this.slicer = new PcmResamplerSlicer();
    this.pendingPackets = [];

    this.store.createSession({
      id: sessionId,
      startedAtIso: new Date().toISOString(),
      audioSource: config.audioSource,
      deviceId: config.deviceId ?? null,
    });

    const settingsRaw = this.store.getSetting("app_settings");
    const settings: Settings = settingsRaw ? JSON.parse(settingsRaw) : {};
    const asrRaw = this.store.getSetting("asr_config");
    if (asrRaw) {
      try {
        await this.asr.connect(JSON.parse(asrRaw));
      } catch (err) {
        this.emit("app.error", makeError(
          "ASR_CONNECT_FAILED",
          `ASR 连接失败: ${err instanceof Error ? err.message : "unknown"}`,
          true,
        ));
      }
    } else {
      this.emit("app.error", makeError(
        "ASR_NOT_CONFIGURED",
        "尚未配置 ASR 密钥，音频将只做本地采集与指标",
        false,
      ));
    }
    if (settings.llm?.base_url && settings.llm?.model) {
      try {
        this.llm.configure(settings.llm);
      } catch {
        /* llm misconfigured: analysis disabled */
      }
    }

    const intervalMs = (config.windowIntervalSec ?? settings.windowIntervalSec ?? 60) * 1000;
    const windowMs = (config.windowSizeSec ?? settings.windowSizeSec ?? 300) * 1000;
    try {
      this.scheduler = new WindowScheduler(intervalMs, windowMs, {
        getNow: () => this.nowMs(),
        getWindow: (s, e) => this.runAnalysis(s, e),
        onSkipped: (reason) => {
          this.analysisQueued = true;
          this.emit("analysis.status", this.analysisStatusSnapshot("skipped:" + reason));
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
      if (this.status === "active") this.scheduler?.tick(this.nowMs());
    }, 1000);

    return { sessionId, error: null };
  }

  async pause() {
    if (this.status !== "active") return;
    this.status = "paused";
    this.store.updateSessionStatus(this.sessionId!, "paused");
    this.audioStatus = { ...this.audioStatus, state: "paused" };
    this.emit("capture.status", this.audioStatus);
  }

  async stop() {
    if (!this.sessionIsActive) return;
    this.status = "stopped";
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.scheduler?.dispose();
    try {
      await this.asr.stop();
    } catch {
      /* best effort */
    }
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
    for (const p of packets) this.pendingPackets.push(p);
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
      void this.asr.sendPcm(p.pcm).catch(() => {
        /* adapter handles reconnection; drop packet */
      });
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
      startMs: p.startMs,
      endMs: p.endMs,
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
      startMs: p.startMs,
      endMs: p.endMs,
      text: p.text,
      isFinal: true,
      createdAt: new Date().toISOString(),
    };
    const inserted = this.store.insertSegment(seg);
    if (!inserted) return;
    this.finalCount++;
    this.store.insertSpeechInterval({
      id: crypto.randomUUID(),
      sessionId: this.sessionId,
      startMs: seg.startMs,
      endMs: seg.endMs,
    });
    const newPhase = this.scriptState.feed(seg.text, seg.endMs);
    if (newPhase) {
      this.emit("analysis.status", this.analysisStatusSnapshot(`phase:${newPhase}`));
    }
    this.emit("transcript.final", seg);
  }

  private analysisStatusSnapshot(note?: string) {
    return {
      running: this.analysisRunning,
      queued: this.analysisQueued,
      lastRunId: null,
      lastRunStatus: note ?? null,
    };
  }

  private async runAnalysis(startMs: number, endMs: number) {
    if (!this.sessionId) return;
    this.analysisRunning = true;
    this.analysisQueued = false;
    const runId = crypto.randomUUID();
    this.store.insertAnalysisRun({
      id: runId,
      sessionId: this.sessionId,
      windowId: crypto.randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
    });
    this.emit("analysis.status", { running: true, queued: false, lastRunId: runId, lastRunStatus: "running" });

    try {
      const segments = segmentsInWindow(
        this.store.querySegments({ sessionId: this.sessionId, finalOnly: true }),
        startMs,
        endMs,
      );
      const intervals = this.store.querySpeechIntervals(this.sessionId, startMs, endMs);
      const metrics = computeMetrics(segments, intervals, startMs, endMs);

      const frameworkList = this.store.listFrameworks();
      const framework = frameworkList[0] ?? null;
      const issues: Issue[] = [];
      for (const seg of segments) {
        const hits = matchRules(seg.text, {
          framework,
          productFacts: framework?.productFacts ?? "",
        });
        for (const hit of hits) {
          issues.push({
            id: crypto.randomUUID(),
            sessionId: this.sessionId,
            analysisRunId: runId,
            type: hit.ruleType === "hotWord" ? "other" : (hit.ruleType as Issue["type"]),
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
      if (metrics.longestSilenceMs > 30000) {
        issues.push({
          id: crypto.randomUUID(),
          sessionId: this.sessionId,
          analysisRunId: runId,
          type: "silence",
          severity: "info",
          startMs,
          endMs,
          segmentIds: [],
          quote: "",
          basis: `最长连续静音 ${Math.round(metrics.longestSilenceMs / 1000)} 秒`,
          recommendation: "可通过互动话题或福利预告填补静音",
          suggestedScript: null,
          confidence: 1,
          needsReview: false,
          status: "open",
        });
      }

      const persisted: Issue[] = [];
      for (const issue of issues) {
        const dedupeKey = `${issue.type}|${issue.segmentIds.slice().sort().join(",")}|${issue.quote}`;
        const outcome = this.store.upsertIssue(issue, dedupeKey);
        if (outcome === "created") persisted.push(issue);
      }

      if (segments.length > 0) {
        try {
          const llmResult = await this.llm.analyze({
            windowStartMs: startMs,
            windowEndMs: endMs,
            segments,
            rulesSummary: framework
              ? framework.rules.map((r) => `${r.ruleType}:${r.pattern}`).join(";")
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
              sessionId: this.sessionId,
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
            const dedupeKey = `${issue.type}|${issue.segmentIds.slice().sort().join(",")}|${issue.quote}`;
            const outcome = this.store.upsertIssue(issue, dedupeKey);
            if (outcome === "created") persisted.push(issue);
          }
          this.previousSummary = llmResult.frameworkStateSummary ?? this.previousSummary;
          this.store.finishAnalysisRun(runId, "success", new Date().toISOString(), null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          this.store.finishAnalysisRun(runId, "failed", new Date().toISOString(), msg);
          this.emit("app.error", makeError("ANALYSIS_LLM_FAILED", `LLM 分析失败: ${msg}`, true));
        }
      } else {
        this.store.finishAnalysisRun(runId, "success", new Date().toISOString(), null);
      }

      if (persisted.length > 0) {
        this.emit("analysis.issues", persisted);
      }
      this.emit("analysis.status", { running: false, queued: false, lastRunId: runId, lastRunStatus: "success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.store.finishAnalysisRun(runId, "failed", new Date().toISOString(), msg);
      this.emit("analysis.status", { running: false, queued: false, lastRunId: runId, lastRunStatus: "failed" });
    } finally {
      this.analysisRunning = false;
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
