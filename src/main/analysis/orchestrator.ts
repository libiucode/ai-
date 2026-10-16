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
import { parseFactAssertions, compareSegmentsAgainstFacts } from "./factCheck";
import { LlmClient, type VerifiedAnalysisResult } from "./llmClient";
import { PcmResamplerSlicer, PACKET_MS, type AudioPacket } from "../capture/pcm";
import type {
  AppError,
  AsrStatus,
  AudioStatus,
  Framework,
  Issue,
  ScheduleStatus,
  ScriptStatus,
  SessionEndReason,
} from "../../shared/contracts";
import type { Settings, StartSessionConfig } from "../../shared/schemas";
import { makeError } from "../security/errorFactory";
import { scheduledEndAt } from "../../shared/schedule";

const PRE_START_BUFFER_MS = 3000;

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
  /** 会话使用的话术框架（启动时缓存，每个分析窗口复用） */
  private framework: Framework | null = null;
  /** 会话绑定的框架 ID，供报告和切换使用 */
  private frameworkId: string | null = null;
  private slicer = new PcmResamplerSlicer();
  private tickTimer: NodeJS.Timeout | null = null;
  private pendingPackets: AudioPacket[] = [];
  /** 会话已建立但尚未 active 期间缓冲的原始音频（有界，见 PRE_START_BUFFER_MS）。 */
  private preStartSamples: number[] = [];
  private preStartSampleRate = 16000;
  private preStartDroppedSamples = 0;
  /** 本段就绪缓冲的起始墙钟时间：用于判定缓冲是否已过期（不能灌入后续会话）。 */
  private preStartBufferedAt = 0;
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
  /**
   * 高频错误的节流与累计：这类错误按音频帧触发（约 85ms 一次），
   * 完全去重会让用户不知道溢出了多少次，完全不去重又会刷屏淹没关键提示。
   * 因此首次立即报、之后按间隔节流，并把累计次数放到状态里供 UI 读取。
   */
  private errorThrottle = new Map<string, { count: number; lastEmittedAt: number }>();
  /** 高频错误节流间隔（毫秒）：首次立即报，之后每 60 秒最多再报一次。 */
  private static readonly ERROR_THROTTLE_MS = 60000;
  /** 本次会话的排期结束时刻（epoch ms）。null 表示不按排期结束。 */
  private scheduledEndAtMs: number | null = null;
  /** 最近一次结束的原因，供快照与测试读取。 */
  private lastEndReason: SessionEndReason | null = null;
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
  /**
   * 上次因断线记过缺口的 connectionId。
   * 一次断线会被 emit 两次（ws close 一次 + scheduleReconnect 一次），
   * 两次都带同一个 connectionId；用这个字段去重，让一次断线只累加一次。
   */
  private lastGapConnectionId: string | null = null;

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
      this.recordAsrGap(st);
      this.emit("asr.status", this.asrStatus);
    });
    this.asr.on("error", (e) => {
      const err = (e as { error: AppError }).error;
      this.asrStatus = { ...this.asrStatus, lastError: err, state: "error" };
      this.emit("asr.status", this.asrStatus);
      this.emit("app.error", err);
    });
  }

  /**
   * 把 ASR 断线缺口落到会话记录上。
   *
   * 计数口径（2026-10-15 与负责人确认）：
   * - **以连接为单位，不以 emit 次数为单位**。用户关心「没录上」发生几次，
   *   不是底层 emit 了几次。
   * - 只有 `state === "reconnecting"` 才算：这是「连接死了、正在重连」的状态；
   *   `state === "closed"` 是用户主动停止/会话结束，**不是故障**，
   *   否则每场正常结束的会话都会记一次缺口。
   * - 去重靠 connectionId：一次断线的两次 emit（close + scheduleReconnect）
   *   共享同一个 connectionId，只记第一次；下一次断线 openNewConnection()
   *   会换新 UUID，所以两次独立断线会记 2 次。
   *
   * 幂等由 SQL 的 `gap_count = gap_count + 1` 保证，这里只负责「该不该加」。
   */
  private recordAsrGap(st: Partial<AsrStatus>): void {
    if (st.state !== "reconnecting") return;
    const connId = st.connectionId ?? null;
    // 2026-10-16 修正：上面这段注释原来是错的。它断言「adapter 两处 reconnecting emit
    // 都带 connectionId，所以 connId 为 null 实际不可达」——实测两处**都不带**，
    // connId 恒为 null，去重分支从不生效，导致每次断线被计 **2 次**
    // （close 分支 emit 一次 + scheduleReconnect 再 emit 一次），
    // sessions.gap_count 与报告「转写缺口」翻倍。
    // 已修：adapter 两处 emit 补上 connectionId（同一断线带同一个，去重生效）。
    // 保留这个 null 分支仍是防御性的：万一将来 adapter 又漏了，行为仍偏向多计
    // （漏计让用户低估断线频率，比多计更危险）。
    if (connId && connId === this.lastGapConnectionId) return;
    // 只在有 connectionId 时记录锚点：null 不是有效的去重锚点，
    // 若两次独立断线都缺 connectionId，用 null 当锚点会把第二次误去重成漏计。
    if (connId) this.lastGapConnectionId = connId;
    if (!this.sessionId) return;   // 会话还没建（音频先到、会话后建）时不落库
    try {
      this.store.incrementSessionGap(this.sessionId);
    } catch {
      // 落库失败不影响采集与转写；缺口计数是复盘辅助，不是关键路径。
    }
  }

  /**
   * 选定会话使用的话术框架。
   * 指定 frameworkId：精确匹配；找不到时回退第一个并保留原因，避免会话直接不可用。
   * 未指定：第一个框架（兼容既有单框架行为）。
   */
  private resolveFramework(config: StartSessionConfig): Framework | null {
    const all = this.store.listFrameworks();
    // frameworkId 已进 shared 契约（StartSessionConfig），不再需要运行时强转兼容。
    const frameworkId = typeof config.frameworkId === "string" && config.frameworkId ? config.frameworkId : null;
    if (frameworkId) {
      const found = all.find((f) => f.id === frameworkId);
      if (found) return found;
      this.emit("app.error", makeError(
        "FRAMEWORK_NOT_FOUND",
        `指定话术框架不存在（${frameworkId}），已回退到「${all[0]?.name ?? "无"}」`,
        false,
      ));
      return all[0] ?? null;
    }
    return all[0] ?? null;
  }

  /** 当前会话生效的话术框架（多商品自播可在会话中切换）。 */
  get activeFramework(): Framework | null {
    return this.framework;
  }

  get activeFrameworkId(): string | null {
    return this.frameworkId;
  }

  /**
   * 会话中切换话术框架（自播一天播多个商品）。
   * 切换后下一分析窗口生效；同时重置话术阶段状态，避免用旧框架的阶段判断新商品。
   * 找到返回 true，找不到返回 false 且不改动当前框架。
   */
  switchFramework(frameworkId: string): boolean {
    const found = this.store.listFrameworks().find((f) => f.id === frameworkId);
    if (!found) return false;
    this.framework = found;
    this.frameworkId = found.id;
    this.scriptState.reset(this.nowMs());
    this.previousFrameworkState = undefined;
    // 落库：历史会话导出时 activeFramework 已不存在，必须靠会话记录追溯当时用的框架。
    // 落库失败不影响本次切换在内存中生效，但要如实提示，不能静默失追溯。
    if (this.sessionId) {
      try {
        const ok = this.store.updateSessionFramework(this.sessionId, found.id);
        if (!ok) {
          this.emit("app.error", makeError(
            "FRAMEWORK_PERSIST_FAILED",
            `话术框架已切换为「${found.name}」，但会话记录未能更新，历史报告可能显示旧框架`,
            false,
          ));
        }
      } catch {
        this.emit("app.error", makeError(
          "FRAMEWORK_PERSIST_FAILED",
          `话术框架已切换为「${found.name}」，但会话记录写入失败，历史报告可能显示旧框架`,
          true,
        ));
      }
    }
    this.emitScriptStatus();
    return true;
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

  /**
   * 到点结束检查（每秒由 tickTimer 调用）。
   *
   * 为什么不用 setTimeout：会话可能被暂停/恢复，绝对时刻的定时器在暂停期间
   * 仍然会到点——那会在用户手动暂停后突然把它结束掉。用轮询 + 状态判断，
   * 只在 active 时生效，语义与「排期窗口结束了」一致。
   */
  private checkScheduledEnd(): void {
    if (this.scheduledEndAtMs === null) return;
    if (Date.now() < this.scheduledEndAtMs) return;
    // 先清空再 stop：stop() 是异步的，不清空的话下一次 tick 会重复触发。
    this.scheduledEndAtMs = null;
    void this.stop("schedule-window-end").catch(() => {
      /* stop 内部已尽力收尾 */
    });
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
    // 多话术框架：会话开始时按 config.frameworkId 选定一次并固定；
    // 未指定时回退到第一个框架，保持既有单框架行为。
    this.framework = this.resolveFramework(config);
    this.frameworkId = this.framework?.id ?? null;
    this.slicer = new PcmResamplerSlicer();
    this.pendingPackets = [];
    // 就绪门：不能无条件清空缓冲——那正好会把「音频先到、会话后建」这段
    // 缓冲抹掉，start() 末尾的 flushPreStartBuffer() 就永远拿不到东西。
    // 只丢弃「陈旧」缓冲（对应会话真的没建的时段），新鲜缓冲留给补发。
    if (this.preStartSamples.length && Date.now() - this.preStartBufferedAt >= PRE_START_BUFFER_MS) {
      this.preStartSamples = [];
      this.preStartDroppedSamples = 0;
    }
    this.asrAudioStartMs = 0;
    this.asrAudioStarted = false;
    this.asrStatus = { state: "idle", connectionId: null, reconnectAttempt: 0, lastPartialMs: 0, gapDetected: false, lastError: null };
    // 缺口去重状态跟着会话走：上一场的 connectionId 不能影响下一场。
    this.lastGapConnectionId = null;
    this.audioStatus = { ...this.audioStatus, queueOverflowCount: 0 };

    this.store.createSession({
      id: sessionId,
      startedAtIso: new Date().toISOString(),
      audioSource: config.audioSource,
      deviceId: config.deviceId ?? null,
      // 框架与主播在创建时就落库：历史导出时内存态已不存在，只能靠会话记录追溯。
      frameworkId: this.framework?.id ?? null,
      speakerId: config.speakerId ?? null,
      speakerName: config.speakerName ?? null,
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
    this.errorThrottle = new Map();
    if (llmCfg) this.llm.configure(llmCfg);

    const intervalMs = (config.windowIntervalSec ?? settings.windowIntervalSec ?? 60) * 1000;
    const windowMs = (config.windowSizeSec ?? settings.windowSizeSec ?? 300) * 1000;

    // 排期窗口结束：只在**会话在窗口内启动**时才绑定结束时刻。
    // 这样用户临时开的（窗口外）监听不会被预约结束掐断——只有明确按排期跑的会话才受约束。
    // 注意这与「到点自动开始」是两件事：自动开始受 user activation 硬约束未接通，
    // 但「到点自动结束」不依赖任何用户手势，可以独立成立。
    const endAt = scheduledEndAt(settings.schedule ?? null, new Date());
    this.scheduledEndAtMs = endAt ? endAt.getTime() : null;
    if (this.scheduledEndAtMs !== null) {
      this.emit("schedule.status", {
        scheduledEndAtIso: endAt!.toISOString(),
      } satisfies ScheduleStatus);
    }
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
        this.checkScheduledEnd();
      }
    }, 1000);

    this.emitScriptStatus();

    // 就绪门：若调用方先开了采集再建会话，这里把就绪窗口内缓冲的音频按序补发。
    this.flushPreStartBuffer();

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
    this.flushPreStartBuffer();
    const asrCfg = readRuntimeAsrConfig(this.store);
    if (!asrCfg) return;
    void this.asr.connect(asrCfg).catch(() => {
      this.emit("app.error", makeError("ASR_CONNECT_FAILED", "ASR 连接失败", true));
    });
  }

  async stop(endReason: SessionEndReason = "user") {
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
    this.store.updateSessionStatus(this.sessionId!, "stopped", new Date().toISOString(), endReason);
    this.audioStatus = { ...this.audioStatus, state: "idle" };
    this.emit("capture.status", this.audioStatus);
    this.asrStatus = { ...this.asrStatus, state: "closed" };
    this.emit("asr.status", this.asrStatus);
    this.lastEndReason = endReason;
    // 会话结束必须显式广播「本场已无排期结束时刻」。
    // 不能让前端靠猜——历史缺陷：前端只在 startSession 里清 scheduleStatus，
    // 会话自然结束不经过那条路径，于是 chip 会拿上一个会话的旧值显示一个假的结束时刻。
    // 显式发 null 让「已无排期结束」成为事实，而不是残留值。
    this.scheduledEndAtMs = null;
    this.emit("schedule.status", { scheduledEndAtIso: null } satisfies ScheduleStatus);
    // 自动结束必须让用户看见原因：否则他只看到一场「正常结束」的空会话，
    // 无法区分是排期到点、软件故障还是自己忘关（历史事故的成因之一）。
    if (endReason !== "user") {
      this.emit("app.error", makeError(
        "SESSION_AUTO_ENDED",
        endReason === "schedule-window-end"
          ? "已到排期结束时刻，本场监听已自动结束"
          : `本场监听已自动结束（${endReason}）`,
        false,
      ));
    }
  }

  /**
   * Feeds raw audio from renderer (already mono Float32 at some rate).
   *
   * 时序就绪门：调用方可能「定时器先建会话、隔一会儿再开采集」，也可能反过来
   * 「先开采集、再建会话」。后者在过去会直接丢音——正是第①级诊断踩过的
   * 「电平完美 + 0 字幕」。这里对「会话已建立、但尚未 active」的短暂窗口做
   * 有界缓冲（上限 3 秒，与音频队列 10 秒上限同思路），转 active 后按序补发。
   *
   * 注意语义边界：会话真的没建（status 为 idle/stopped 且无 sessionId）时仍然丢弃，
   * 不能把「没开始监听」的音频无限缓冲起来。
   */
  ingestAudio(float32: Float32Array, sourceRate: number): void {
    if (!this.canAcceptAudio()) {
      this.bufferPreStartAudio(float32, sourceRate);
      return;
    }
    const packets = this.slicer.push(float32, sourceRate, this.nowMs());
    for (const p of packets) {
      for (const iv of detectSpeechIntervals([p])) {
        this.store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: this.sessionId!, ...iv });
      }
      this.pendingPackets.push(p);
    }
    this.drainPendingPackets();
  }

  /** 音频可被正式接收：会话已建立且处于 active。 */
  private canAcceptAudio(): boolean {
    return this.status === "active" && !!this.sessionId;
  }

  /**
   * 音频尚未能被正式接收时，缓冲「临近启动窗口」内的原始音频（有界）。
   *
   * 关键语义边界：
   * - 音频先到、会话尚未建立（sessionId 为空）时要缓冲，否则无人值守下会真实丢音；
   * - 但缓冲只覆盖最近 PRE_START_BUFFER_MS 的墙钟时间。超过这个窗口的音频视为
   *   「会话真的没建」，直接丢弃且绝不补发——否则会在几分钟后启动会话时把一段
   *   陈旧音频灌进新会话，比丢帧更糟。
   */
  private bufferPreStartAudio(float32: Float32Array, sourceRate: number): void {
    if (this.status === "paused" || this.status === "stopping") return;
    if (float32.length === 0) return;
    const nowWall = Date.now();
    // 陈旧缓冲：距首次缓冲已超过窗口，说明这不是一次启动过渡，整段作废。
    if (this.preStartSamples.length && nowWall - this.preStartBufferedAt >= PRE_START_BUFFER_MS) {
      this.preStartSamples = [];
      this.preStartDroppedSamples = 0;
    }
    if (this.preStartSamples.length === 0) this.preStartBufferedAt = nowWall;
    const maxBufferedSamples = Math.ceil(sourceRate * PRE_START_BUFFER_MS / 1000);
    for (let i = 0; i < float32.length; i++) this.preStartSamples.push(float32[i]);
    if (this.preStartSamples.length > maxBufferedSamples) {
      const dropped = this.preStartSamples.length - maxBufferedSamples;
      this.preStartSamples.splice(0, dropped);
      this.preStartDroppedSamples += dropped;
      this.emitThrottledError(makeError(
        "PRE_START_BUFFER_OVERFLOW",
        "会话启动前音频缓冲已满，丢弃最早样本",
        true,
      ));
    }
    this.preStartSampleRate = sourceRate;
  }

  /** 会话转 active 后把就绪窗口内缓冲的音频按序补发；过期缓冲直接丢弃。 */
  private flushPreStartBuffer(): void {
    if (!this.preStartSamples.length) return;
    if (!this.canAcceptAudio()) return;
    const age = Date.now() - this.preStartBufferedAt;
    if (age >= PRE_START_BUFFER_MS) {
      // 缓冲已过期，对应「会话真的没建」的时段，不补发也不残留。
      this.preStartSamples = [];
      this.preStartDroppedSamples = 0;
      return;
    }
    const rate = this.preStartSampleRate || 16000;
    const samples = new Float32Array(this.preStartSamples);
    this.preStartSamples = [];
    const dropped = this.preStartDroppedSamples;
    this.preStartDroppedSamples = 0;
    const packets = this.slicer.push(samples, rate, this.nowMs());
    for (const p of packets) {
      for (const iv of detectSpeechIntervals([p])) {
        this.store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: this.sessionId!, ...iv });
      }
      this.pendingPackets.push(p);
    }
    this.drainPendingPackets();
    if (dropped > 0) {
      this.emitThrottledError(makeError(
        "PRE_START_BUFFER_PARTIAL",
        `就绪窗口缓冲超出上限，已丢弃最早 ${dropped} 个采样`,
        true,
      ));
    }
  }

  /** 有界补发：把已到发送时点的包按序发出。 */
  private drainPendingPackets(): void {
    // bounded queue ~10s
    const maxPackets = Math.floor(10000 / PACKET_MS);
    if (this.pendingPackets.length > maxPackets) {
      this.pendingPackets = this.pendingPackets.slice(-maxPackets);
      this.audioStatus = {
        ...this.audioStatus,
        queueOverflowCount: this.audioStatus.queueOverflowCount + 1,
      };
      this.emit("capture.status", this.audioStatus);
      this.emitThrottledError(makeError("CAPTURE_QUEUE_OVERFLOW", "音频队列已满，丢弃旧包", true));
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

  /**
   * 高频错误（按音频帧触发）的节流提示。
   *
   * 语义与 emitAnalysisError 不同：溢出是可累积的，用户需要知道**发生了多少次**，
   * 于是不能只报一次；但每次都报会在几秒内刷满 UI 错误列表，把关键提示挤掉。
   * 折中：首次立即报，之后按 ERROR_THROTTLE_MS 节流；累计次数写入状态供 UI 读取。
   *
   * 返回本次是否真的 emit（供调用方与测试判断）。
   */
  private emitThrottledError(error: AppError): boolean {
    const now = Date.now();
    const entry = this.errorThrottle.get(error.code);
    if (!entry) {
      this.errorThrottle.set(error.code, { count: 1, lastEmittedAt: now });
      this.lastErrorCode = error.code;
      this.emit("app.error", error);
      return true;
    }
    entry.count += 1;
    if (now - entry.lastEmittedAt < SessionOrchestrator.ERROR_THROTTLE_MS) return false;
    entry.lastEmittedAt = now;
    this.lastErrorCode = error.code;
    this.emit("app.error", makeError(error.code, `${error.message}（已发生 ${entry.count} 次）`, Boolean(error.retryable)));
    return true;
  }

  /** 高频错误的累计次数；UI 用它显示「已发生 N 次」，避免信息丢失。 */
  getErrorCount(code: string): number {
    return this.errorThrottle.get(code)?.count ?? 0;
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
    let runStatus: "success" | "failed" | "timeout" | "skipped" = "success";
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

      // 复用会话绑定的框架：不再每个窗口重读 listFrameworks()[0]，
      // 否则多框架会话会被静默切回第一个框架。
      const framework = this.framework;
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

      // ---- 框架「一致性比对」通道 A：数值断言核对（本地，确定性） ----
      //
      // 与上面的规则命中是**不同性质**的问题：
      //   规则命中 = 「这句话里有风险表述」（绝对化、未核实宣称）
      //   事实冲突 = 「这句话与框架声明的事实不符」（框架写12小时、主播说24小时）
      // 后者是领导原话「和给定的话术框架进行比对，找出问题」的直接落点，
      // 且可确定性判定（12 ≠ 24），不依赖 LLM。
      //
      // 处置纪律：本通道默认不报，只有「同量纲 + 数值不同 + 非对比语境 + 非服务条款」
      // 才产出冲突。反例见 tests/fact-check.test.ts。
      const factAssertions = framework ? parseFactAssertions(framework.productFacts) : [];
      if (factAssertions.length) {
        for (const conflict of compareSegmentsAgainstFacts(
          segments.map((s) => ({ id: s.id, text: s.text })),
          factAssertions,
        )) {
          const seg = segments.find((s) => s.id === conflict.segmentId);
          if (!seg) continue;
          const id = crypto.randomUUID();
          issueSteps.set(id, null);
          issues.push({
            id,
            sessionId,
            analysisRunId: runId,
            type: "frameworkConflict",
            // 与框架不符 ≠ 违规。定级 warning，把「是否严重」留给用户判断。
            severity: "warning",
            startMs: seg.startMs,
            endMs: seg.endMs,
            segmentIds: [seg.id],
            // quote 逐字来自原文（factCheck 保证），走既有证据门禁
            quote: conflict.quote,
            basis:
              `与话术框架声明的商品事实不符：框架写「${conflict.fact.raw}」，` +
              `主播口播「${conflict.quote}」。`,
            recommendation: "请核对该参数的准确数值，按已核实事实修正口播表述。",
            suggestedScript: null,
            // 数值冲突本身可确定，但「框架那条事实是否写对」无从判断，故标需人工核查。
            confidence: 0.9,
            needsReview: true,
            status: "open",
          });
        }
      }

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
        // LLM 未配置：只跑了本地规则，没有做语义分析。
        // 记 skipped 而不是 success——「没做」不能伪装成「做成功了」。
        this.store.finishAnalysisRun(runId, "skipped", new Date().toISOString(), "llm-not-configured: 未配置LLM，仅执行本地规则");
        runStatus = "skipped";
      } else {
        // 窗口内没有任何稳态片段：连本地规则都没跑（循环体不执行）。
        this.store.finishAnalysisRun(runId, "skipped", new Date().toISOString(), "empty-window: 窗口内无稳态转写片段");
        runStatus = "skipped";
      }

      if (persisted.length > 0) {
        emit("analysis.issues", persisted);
      }
      if (this.activeAnalysisRunId === runId) {
        this.analysisRunning = false;
        this.activeAnalysisRunId = null;
      }
      emit("analysis.status", this.analysisStatusSnapshot(runStatus));
    } catch (err) {
      const appError = err as Partial<AppError> | null;
      const msg = appError?.code && appError.message ? `${appError.code}: ${appError.message}` : err instanceof Error ? err.message : "unknown";
      this.store.finishAnalysisRun(runId, "failed", new Date().toISOString(), msg);
      if (this.activeAnalysisRunId === runId) {
        this.analysisRunning = false;
        this.activeAnalysisRunId = null;
      }
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
      /** 会话绑定的排期结束时刻（epoch ms），null 表示不按排期结束。 */
      scheduledEndAtMs: this.scheduledEndAtMs,
      lastEndReason: this.lastEndReason,
    };
  }
}
