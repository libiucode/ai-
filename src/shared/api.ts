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
  /** 凭证：界面填写，加密存本机。环境变量优先级更高。 */
  setCredential(key: CredentialKey, value: string): Promise<CredentialSetResult>;
  credentialStatus(): Promise<CredentialStatusResult>;
  clearCredentials(): Promise<CredentialSetResult>;
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
 * 'storage' 表示来自本地数据库（密钥经系统钥匙串加密）。
 * 密钥一律不回传给渲染层，这里只标来源。
 */
export type ConfigSource = "environment" | "storage";

/** 凭证键：界面可写这三个，主进程读取时环境变量优先。 */
export type CredentialKey =
  | "TENCENT_ASR_SECRET_ID"
  | "TENCENT_ASR_SECRET_KEY"
  | "LLM_API_KEY";

export interface CredentialSetResult {
  ok: boolean;
  message: string;
  /** 本次写入后的实际存储形态（加密 / 明文降级）。 */
  mode?: CredentialStorageMode;
}

/**
 * 凭证存储形态。
 *
 * - `encrypted`：系统加密可用（Windows DPAPI / macOS Keychain / Linux 密钥环），
 *   库里存的是密文。
 * - `plaintext`：系统加密**不可用**，库里存的是明文（带 `plain:` 前缀）。
 *   功能不受影响，但界面必须如实告知用户——这是 2026-10-16 的策略变更：
 *   原先「加密不可用就拒绝落盘、禁用输入框」在客户现场（服务器 / 远程桌面 /
 *   受限账户）会让用户完全无法配置密钥，故改为降级存明文 + 显著警告。
 */
export type CredentialStorageMode = "encrypted" | "plaintext" | "none";

export interface CredentialStatusResult {
  /**
   * 是否**可写**凭证。恒为 true——降级明文通道保证了这一点。
   *
   * 注意语义已收窄：它**不再**表示「系统是否支持加密存储」。
   * 需要判断加密与否请用 `mode`。字段保留是为了兼容既有调用方。
   */
  available: boolean;
  /** 当前实际的存储形态。界面据此决定是否显示「明文存储」警告。 */
  mode: CredentialStorageMode;
  /** 哪些键是以明文形态存放的（界面可据此逐项提示）。 */
  plaintextKeys?: Record<CredentialKey, boolean>;
  /** 本机是否已存该凭证（不回显明文）。 */
  configured: Record<CredentialKey, boolean>;
  /** 环境变量里是否提供了该凭证。 */
  fromEnv: Record<CredentialKey, boolean>;
}

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
