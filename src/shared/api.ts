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
  selectAudioDevice(id: string): Promise<boolean>;
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

export interface AsrStatusInfo {
  configured: boolean;
  appId?: string;
  secretIdTail?: string;
}

export interface LlmStatusInfo {
  configured: boolean;
  baseUrl?: string;
  model?: string;
  keyTail?: string;
}

/** Runtime shape of window.appApi including the raw audio ingest hook. */
export interface RendererAppApi extends WindowApi {
  sendAudioChunk(float32: Float32Array, sourceRate: number): void;
}
