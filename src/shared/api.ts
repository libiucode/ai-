import type {
  AppError,
  AsrStatus,
  AudioDevice,
  AudioStatus,
  Framework,
  Issue,
  Settings,
  StartSessionConfig,
  TranscriptSegment,
} from "./contracts";
import type { ReportFormat } from "./schemas";

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

export interface AppEvents {
  "transcript.partial": TranscriptSegment;
  "transcript.final": TranscriptSegment;
  "capture.status": AudioStatus;
  "asr.status": AsrStatus;
  "analysis.status": AnalysisStatusLike;
  "analysis.issues": Issue[];
  "app.error": AppError;
}

export type EventListener<K extends keyof AppEvents> = (
  payload: AppEvents[K],
) => void;

export interface WindowApi {
  startSession(config: StartSessionConfig): Promise<StartSessionResult>;
  pauseSession(): Promise<void>;
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
}
