export interface Session {
  id: string;
  startedAtIso: string;
  endedAtIso: string | null;
  audioSource: "microphone" | "systemLoopback";
  deviceId: string | null;
  status: "active" | "paused" | "stopped";
  /** 本场使用的话术框架 id。历史报告导出据此还原当时用的框架（内存态重启即失）。 */
  frameworkId?: string | null;
  /** 主播稳定标识；聚合对比用，改名不影响统计。 */
  speakerId?: string | null;
  /** 主播当次显示名快照；历史报告保留当时的名字（有意的可追溯性）。 */
  speakerName?: string | null;
  /**
   * 会话结束原因。三种自动结束（排期窗口到点 / 长时间无音频 / 残留收尾）
   * 都写 status='stopped' + ended_at，不写原因就无法事后区分它们与用户手点结束。
   */
  endReason?: SessionEndReason | null;
}

/**
 * 会话结束原因。
 * - `user`：用户手动点「结束」。
 * - `schedule-window-end`：到了排期配置的结束时刻，自动结束。
 * - `process-restart`：上次进程被强杀/崩溃，启动时收尾的历史残留。
 * - `no-audio-timeout`：长时间无音频自动结束（尚未实施，预留）。
 */
export type SessionEndReason =
  | "user"
  | "schedule-window-end"
  | "process-restart"
  | "no-audio-timeout";

export interface TranscriptSegment {
  id: string;
  sessionId: string;
  connectionId: string;
  sourceSeq: number;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
  createdAt: string;
}

export interface SpeechInterval {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
}

export type AnalysisRunStatus =
  | "success"
  | "timeout"
  | "cancelled"
  | "failed"
  | "skipped";

export interface AnalysisRun {
  id: string;
  sessionId: string;
  windowId: string;
  status: AnalysisRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export type IssueType =
  | "bannedWord"
  | "absolutization"
  | "unverifiedClaim"
  | "repetition"
  | "pace"
  | "silence"
  | "frameworkStep"
  /**
   * 与话术框架声明的商品事实冲突（框架写「保温12小时」，主播说「保温24小时」）。
   *
   * 与 `unverifiedClaim` 的区别：后者是「这句话本身有风险」，
   * 前者是「这句话与已核实事实不符」——性质不同，前者需要框架里有对应事实才会产生。
   * 由 `analysis/factCheck.ts` 本地确定性判定，不依赖 LLM。
   */
  | "frameworkConflict"
  | "other";

export type IssueSeverity = "info" | "warning" | "critical";

export interface Issue {
  id: string;
  sessionId: string;
  analysisRunId: string;
  type: IssueType;
  severity: IssueSeverity;
  startMs: number;
  endMs: number;
  segmentIds: string[];
  quote: string;
  basis: string;
  recommendation: string;
  suggestedScript: string | null;
  confidence: number;
  needsReview: boolean;
  status: "open" | "acknowledged" | "dismissed";
  occurrenceCount?: number;
  firstSeenMs?: number;
  lastSeenMs?: number;
}

export interface IssueEvidence {
  id: string;
  issueId: string;
  segmentId: string;
  quote: string;
  startMs: number;
  endMs: number;
}

export interface FrameworkStep {
  id: string;
  frameworkId: string;
  name: string;
  priority: number;
  maxWaitMs: number;
}

export interface FrameworkRule {
  id: string;
  frameworkId: string;
  stepId: string | null;
  ruleType: "bannedWord" | "absolutization" | "unverifiedClaim" | "repetition" | "hotWord";
  pattern: string;
  enabled: boolean;
}

export interface Framework {
  id: string;
  name: string;
  steps: FrameworkStep[];
  rules: FrameworkRule[];
  productFacts: string;
  updatedAt: string;
}

/** 话术阶段状态机的阶段名（与 ruleEngine.ScriptLoopState 一致）。 */
export type ScriptPhaseName = "idle" | "opening" | "productIntro" | "interaction" | "cta";

export const PHASE_LABEL: Record<ScriptPhaseName, string> = {
  idle: "未识别",
  opening: "开场",
  productIntro: "产品介绍",
  interaction: "互动",
  cta: "成交引导",
};

/** 单个步骤的实时状态（话术步骤覆盖面板）。 */
export interface ScriptStepStatus {
  id: string;
  name: string;
  priority: number;
  maxWaitMs: number;
  /** 当前阶段停留时间已超过该步骤的最长等待时间 */
  overdue: boolean;
}

/** 会话进行中推送给渲染层的话术阶段状态。 */
export interface ScriptStatus {
  phase: ScriptPhaseName;
  /** 当前阶段已停留时长（会话相对毫秒；idle 时为 0） */
  phaseElapsedMs: number;
  steps: ScriptStepStatus[];
  frameworkName: string | null;
}

/** 报告用：重放转写得到的一个阶段区间。 */
export interface ScriptPhaseInterval {
  phase: ScriptPhaseName;
  startMs: number;
  endMs: number;
}

/** 报告用：单步骤覆盖统计。 */
export interface ScriptStepReport {
  name: string;
  priority: number;
  maxWaitMs: number;
  /** 所有已识别阶段中最长的一次停留 */
  maxStayMs: number;
  overdue: boolean;
}

/** 报告用：话术步骤覆盖汇总。未配置话术框架时为 null。 */
export interface ScriptReport {
  frameworkName: string;
  /**
   * 这份覆盖统计用的是哪个框架、来源是否可靠。
   * - `session-bound`：取自本会话记录的 framework_id，准确
   * - `fallback-unrecorded`：老会话没有 framework_id，回退到默认框架（历史单框架场景大概率正确，但不保证）
   * - `fallback-deleted`：framework_id 指向的框架已被删除，回退到默认框架（**结论可能完全不对**）
   */
  frameworkSource: "session-bound" | "fallback-unrecorded" | "fallback-deleted";
  /** 降级时的人类可读原因；session-bound 时为 null */
  frameworkFallbackReason: string | null;
  phases: ScriptPhaseInterval[];
  steps: ScriptStepReport[];
}

export interface AudioStatus {
  state: "idle" | "capturing" | "paused" | "error";
  source: "microphone" | "systemLoopback" | null;
  deviceId: string | null;
  level: number;
  queueOverflowCount: number;
  lastError: AppError | null;
}

export type AsrConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface AsrStatus {
  state: AsrConnectionState;
  connectionId: string | null;
  reconnectAttempt: number;
  lastPartialMs: number;
  gapDetected: boolean;
  lastError: AppError | null;
  /**
   * WebSocket 关闭码（1000 正常 / 1006 异常断开无关闭帧）。
   * 2026-10-15 加：排查断线事故时发现适配器丢弃了 code/reason，
   * 只能靠数据库侧会话状态反推根因，绕了一大圈。
   */
  closeCode?: number;
  /** WebSocket 关闭原因（服务端可能给出说明文本）。 */
  closeReason?: string;
  /** 关闭前最近一次服务端业务错误码（如 4008 空闲超时）。 */
  lastServerErrorCode?: number;
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface AnalysisStatus {
  running: boolean;
  queued: boolean;
  lastRunId: string | null;
  lastRunStatus: AnalysisRunStatus | null;
  /** LLM 配置态：未配置时本地规则照常运行，不把配置态当运行故障刷屏。 */
  llm?: "configured" | "not_configured" | "budget_exceeded";
  /** 同一错误码在会话内只提示一次；UI 据此去重，不再重复弹 callout。 */
  lastErrorCode?: string | null;
}

export interface WindowMetrics {
  totalMs: number;
  speechMs: number;
  silenceMs: number;
  chineseChars: number;
  englishWords: number;
  charsPerSpeechMinute: number;
  charsPerTotalMinute: number;
  paceChanges: Array<{ fromMs: number; toMs: number; delta: number }>;
  longestSilenceMs: number;
  maxRepeatSimilarity: number;
  repeatCandidate: { text: string; count: number } | null;
}

/** 报告导出格式。html 产出 HTML 文件，json 产出 JSON。改名兼容说明见 ReportFormatSchema。 */
export type ReportFormat = "html" | "json";

export interface AudioDevice {
  id: string;
  label: string;
  kind: "microphone" | "systemLoopback";
  isDefault: boolean;
}

/** Summary row for the session history list. */
export interface SessionSummary {
  id: string;
  startedAtIso: string;
  endedAtIso: string | null;
  audioSource: "microphone" | "systemLoopback";
  status: string;
  finalSegmentCount: number;
  issueCount: number;
  /**
   * 本场是否有过 ASR 断线缺口。让用户复盘时能区分
   * 「主播那几分钟没说话」和「ASR 断了、那几分钟根本没录上」。
   * 由 store.listSessionSummaries 从 sessions.gap_count 读出，不再硬编码。
   */
  hasGap: boolean;
  /**
   * 断线缺口次数。以「连接」为单位：一次断线（旧连接死 + 新连接建）计 1 次，
   * 用户主动结束不计。老库迁移后为 0。
   * 与 connectionCount/disconnectCount 不同——这两个仍未持久化（null），
   * gapCount 是实测值，0 表示「确实没断过」。
   */
  gapCount: number;
  /** 本场使用的话术框架 id（老记录为 null）。 */
  frameworkId?: string | null;
  /** 主播稳定标识与当次名字快照。 */
  speakerId?: string | null;
  speakerName?: string | null;
  /** 结束原因（老记录为 null，表示无法追溯）。 */
  endReason?: SessionEndReason | null;
}

/** Aggregated report data built from the real database. */
export interface ReportSummary {
  session: {
    id: string;
    startedAtIso: string;
    endedAtIso: string | null;
    audioSource: string;
    listenedMs: number;
    /** 结束原因。报告要能说明「这场为什么停了」，尤其是自动结束的场次。 */
    endReason: SessionEndReason | null;
  };
  asr: {
    connectionCount: number | null;
    disconnectCount: number | null;
    /**
     * 断线缺口次数。v5 起落库，是实测值：0 表示「本场确实没断过」。
     * 与上面两个字段不同——那两个仍是 null（未持久化）。
     */
    gapCount: number;
  };
  issues: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    confirmed: number;
    needsReview: number;
  };
  issueTimeline: Array<{
    issueId: string;
    type: string;
    severity: string;
    firstSeenMs: number;
    quote: string;
    segmentIds: string[];
    basis: string;
    recommendation: string;
  }>;
  metrics: {
    speechMs: number;
    silenceMs: number;
    chineseChars: number;
    englishWords: number;
    charsPerSpeechMinute: number;
    charsPerTotalMinute: number;
    longestSilenceMs: number;
  };
  llm: {
    requestCount: number | null;
    failedCount: number | null;
    estimatedTokens: number;
  };
  analysisRuns: {
    total: number;
    success: number;
    failed: number;
  };
  /** 话术步骤覆盖（未配置话术框架时为 null） */
  script: ScriptReport | null;
  generatedAtIso: string;
}

/**
 * 定时监听配置（模块 A「自播质检」用）。
 *
 * ⚠️ 本轮只落数据结构与界面，**尚未接通调度**。
 * 原因见 docs/unattended-capture-research.md：采集入口受 Chromium user activation 约束，
 * 程序自身（定时器/启动回调）无法触发 `getDisplayMedia`，所以"到点自动开录"必须先解决
 * 一次性授权复用（路线 A）或原生采集（路线 C），那是后续工作。
 */
export interface ScheduleConfig {
  enabled: boolean;
  /** 开始时间，"HH:mm"（本地时间） */
  startTime: string;
  /** 结束时间，"HH:mm"（本地时间）。小于等于 startTime 时表示跨天，次日结束。 */
  endTime: string;
  /** 生效的星期，0=周日 … 6=周六。空数组等价于每天。 */
  weekdays: number[];
  /** 自动开始时使用的音源 */
  audioSource: "microphone" | "systemLoopback";
  /** 自动开始时使用的话术框架 id；null 表示用列表里的第一个 */
  frameworkId: string | null;
}

/**
 * 排期运行态（主进程 → 渲染层）。
 *
 * 「到点自动开始」与「到点自动结束」是两件独立的事，能力边界完全不同：
 * - 自动开始：受 Chromium user activation 硬约束，**本期未接通**。
 * - 自动结束：不依赖任何用户手势，**本期已接通**。
 * 所以这里只报结束时刻，不谎报开始能力。
 */
export interface ScheduleStatus {
  /** 本场会话绑定的排期结束时刻；null 表示本场不按排期结束。 */
  scheduledEndAtIso: string | null;
}

export interface Settings {
  llm?: {
    base_url?: string;
    model?: string;
    api_key?: string;
    request_timeout_ms?: number;
    max_retries?: number;
    budget_limit?: number;
  };
  asr?: {
    provider: "tencent";
    secretId: string;
    secretKey: string;
    appId: string;
    engineModelType?: string;
    hotwordId?: string;
  };
  windowIntervalSec: 30 | 60 | 120;
  windowSizeSec: 180 | 300 | 600;
  paceThreshold?: number;
  silenceThresholdMs?: number;
  schedule?: ScheduleConfig;
  /**
   * 上次选择的麦克风 deviceId（公开配置，随 app_settings 落库）。
   *
   * 为什么需要：设备选择原本只活在渲染进程的 React state 里，刷新/重启即丢，
   * 用户每次开播都要重选一次；无人值守场景下更可能采错设备
   * （选中 VB-CABLE 却回到 Razer 麦克风）。
   *
   * 语义：`null` = 用系统默认设备（用户选了「默认麦克风」）。
   * **不允许空串**：空串在 select 里同样表示"默认"，两种写法并存会让
   * 「清除已存值」的判断分不清是用户选的默认，还是没选过。
   */
  audioDeviceId?: string | null;
}

export interface StartSessionConfig {
  audioSource: "microphone" | "systemLoopback";
  deviceId?: string | null;
  windowIntervalSec?: number;
  windowSizeSec?: number;
  /** 本场会话使用的话术框架 id。缺省或匹配不到时回退到第一个框架。 */
  frameworkId?: string | null;
}
