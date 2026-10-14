import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvents,
  EventListener,
  StartSessionResult,
  SessionListResult,
  SessionDetailResult,
  ConnectionTestResult,
  AsrStatusInfo,
  LlmStatusInfo,
} from "../shared/api";
import type {
  AudioDevice,
  Framework,
  ReportFormat,
  ReportSummary,
  Settings,
  StartSessionConfig,
} from "../shared/contracts";
import { IpcChannels } from "../shared/schemas";

const EVENT_CHANNELS: Record<keyof AppEvents, string> = {
  "transcript.partial": IpcChannels.transcriptPartial,
  "transcript.final": IpcChannels.transcriptFinal,
  "capture.status": IpcChannels.captureStatus,
  "asr.status": IpcChannels.asrStatus,
  "analysis.status": IpcChannels.analysisStatus,
  "analysis.issues": IpcChannels.analysisIssues,
  "script.status": IpcChannels.scriptStatus,
  "schedule.status": IpcChannels.scheduleStatus,
  "app.error": IpcChannels.appError,
};

const api = {
  startSession: (config: StartSessionConfig) =>
    ipcRenderer.invoke(IpcChannels.sessionStart, config) as Promise<StartSessionResult>,
  pauseSession: () => ipcRenderer.invoke(IpcChannels.sessionPause),
  resumeSession: () => ipcRenderer.invoke(IpcChannels.sessionResume),
  stopSession: () => ipcRenderer.invoke(IpcChannels.sessionStop),
  listAudioDevices: async (): Promise<AudioDevice[]> => {
    // enumerate via standard browser API (validated main-side)
    // preload 运行在渲染进程世界，但按 main tsconfig（无 DOM lib）编译，
    // 因此对 navigator.mediaDevices 使用结构化类型访问
    const mediaDevices = (globalThis as unknown as {
      navigator?: {
        mediaDevices?: {
          enumerateDevices: () => Promise<Array<{ deviceId: string; label: string; kind: string }>>;
        };
      };
    }).navigator?.mediaDevices;
    const devices = mediaDevices ? await mediaDevices.enumerateDevices() : [];
    const mics = devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({
        id: d.deviceId,
        label: d.label || `麦克风 ${i + 1}`,
        kind: "microphone" as const,
        isDefault: d.deviceId === "default" || i === 0,
      }));
    return mics;
  },
  selectAudioDevice: (id: string) =>
    ipcRenderer.invoke(IpcChannels.captureSelectDevice, id) as Promise<boolean>,
  subscribeEvents: <K extends keyof AppEvents>(
    event: K,
    listener: EventListener<K>,
  ) => {
    const channel = EVENT_CHANNELS[event];
    const handler = (_e: unknown, payload: AppEvents[K]) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  listFrameworks: () =>
    ipcRenderer.invoke(IpcChannels.frameworkList) as Promise<Framework[]>,
  saveFramework: (framework: Framework) =>
    ipcRenderer.invoke(IpcChannels.frameworkSave, framework) as Promise<boolean>,
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet) as Promise<Settings>,
  saveSettings: (settings: Settings) =>
    ipcRenderer.invoke(IpcChannels.settingsSave, settings) as Promise<boolean>,
  exportReport: (sessionId: string, format: ReportFormat) =>
    ipcRenderer.invoke(IpcChannels.reportExport, sessionId, format) as Promise<string>,
  listSessions: () =>
    ipcRenderer.invoke("session.list") as Promise<SessionListResult>,
  getSessionDetail: (sessionId: string) =>
    ipcRenderer.invoke("session.detail", sessionId) as Promise<SessionDetailResult>,
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke("session.delete", sessionId) as Promise<boolean>,
  testAsrConnection: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("asr.testConnection", config) as Promise<ConnectionTestResult>,
  testLlmConnection: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("llm.testConnection", config) as Promise<ConnectionTestResult>,
  generateReport: (sessionId: string, format: ReportFormat) =>
    ipcRenderer.invoke("report.generate", sessionId, format) as Promise<ReportSummary>,
  getAsrStatus: () =>
    ipcRenderer.invoke("settings.getAsrStatus") as Promise<AsrStatusInfo>,
  getLlmStatus: () =>
    ipcRenderer.invoke("settings.getLlmStatus") as Promise<LlmStatusInfo>,
};

// expose raw audio ingest hook used by capture pipeline
contextBridge.exposeInMainWorld("appApi", {
  ...api,
  sendAudioChunk: (float32: Float32Array, sourceRate: number) => {
    ipcRenderer.send(IpcChannels.captureAudioChunk, float32, sourceRate);
  },
});
