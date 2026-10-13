export interface Session {
  id: string;
  startedAtIso: string;
  endedAtIso: string | null;
  audioSource: "microphone" | "systemLoopback";
  deviceId: string | null;
  status: "active" | "paused" | "stopped";
}

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

export interface AnalysisWindow {
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

export type ReportFormat = "markdown" | "json";

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
  hasGap: boolean;
}

/** Aggregated report data built from the real database. */
export interface ReportSummary {
  session: {
    id: string;
    startedAtIso: string;
    endedAtIso: string | null;
    audioSource: string;
    listenedMs: number;
  };
  asr: {
    connectionCount: number;
    disconnectCount: number;
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
    requestCount: number;
    failedCount: number;
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
}

export interface StartSessionConfig {
  audioSource: "microphone" | "systemLoopback";
  deviceId?: string | null;
  windowIntervalSec?: number;
  windowSizeSec?: number;
}
