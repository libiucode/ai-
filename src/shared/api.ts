import type {
  AppError,
  AsrStatus,
  AudioDevice,
  AudioStatus,
  Framework,
  Issue,
  ReportFormat,
  ReportSummary,
  Settings,
  Session,
  SessionSummary,
  ScheduleStatus,
  ScriptStatus,
  StartSessionConfig,
  TranscriptSegment,
} from "./contracts";

export interface AnalysisStatusLike {
  running: boolean;
  queued: boolean;
  lastRunId: string | null;
  lastRunStatus: string | null;
}

export interface StartSessionResult {
  sessionId: string;
  error: AppError | null;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  error: AppError | null;
}

export interface SessionDetailResult {
  session: Session | null;
  segments: TranscriptSegment[];
  issues: Issue[];
  error: AppError | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  error: AppError | null;
}

export interface AppEvents {
  "transcript.partial": TranscriptSegment;
  "transcript.final": TranscriptSegment;
  "capture.status": AudioStatus;
  "asr.status": AsrStatus;
  "analysis.status": AnalysisStatusLike;
  "analysis.issues": Issue[];
  "script.status": ScriptStatus;
  "schedule.status": ScheduleStatus;
  "app.error": AppError;
}

export type EventListener<K extends keyof AppEvents> = (
  payload: AppEvents[K],
) => void;

export interface WindowApi {
  startSession(config: StartSessionConfig): Promise<StartSessionResult>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  stopSession(): Promise<void>;
  listAudioDevices(): Promise<AudioDevice[]>;
  // 原先有 selectAudioDevice(id) —— 转发到主进程 captureSelectDevice 空实现。
  // 设备选择持久化走 settingsSave（audioDeviceId 字段），三层已移除。
  subscribeEvents<K extends keyof AppEvents>(
    event: K,
    listener: EventListener<K>,
  ): () => void;
  listFrameworks(): Promise<Framework[]>;
  saveFramework(framework: Framework): Promise<boolean>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<boolean>;
  exportReport(sessionId: string, format: ReportFormat): Promise<string>;
  listSessions(): Promise<SessionListResult>;
  getSessionDetail(sessionId: string): Promise<SessionDetailResult>;
  deleteSession(sessionId: string): Promise<boolean>;
  testAsrConnection(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  testLlmConnection(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  generateReport(sessionId: string, format: ReportFormat): Promise<ReportSummary>;
  getAsrStatus(): Promise<AsrStatusInfo>;
  getLlmStatus(): Promise<LlmStatusInfo>;
}

/**
 * 配置来源。'environment' 表示凭证由进程环境变量提供（不入库、不可在界面修改）；
 * 'storage' 表示来自本地数据库。密钥一律不回传给渲染层，这里只标来源。
 */
export type ConfigSource = "environment" | "storage";

export interface AsrStatusInfo {
  configured: boolean;
  appId?: string;
  source?: ConfigSource;
  /** 环境变量里的密钥是否存在。 */
  credentialPresent?: boolean;
  /** 可直接展示给用户的缺失原因说明。 */
  message?: string;
}

export interface LlmStatusInfo {
  configured: boolean;
  baseUrl?: string;
  model?: string;
  source?: ConfigSource;
  /** 界面可填写的公开配置（Base URL + 模型名）是否齐全。 */
  publicConfigPresent?: boolean;
  /** 环境变量里的密钥是否存在。 */
  credentialPresent?: boolean;
  /** 可直接展示给用户的缺失原因说明。 */
  message?: string;
}

/** Runtime shape of window.appApi including the raw audio ingest hook. */
export interface RendererAppApi extends WindowApi {
  sendAudioChunk(float32: Float32Array, sourceRate: number): void;
}
