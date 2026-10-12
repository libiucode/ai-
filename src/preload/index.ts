import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvents,
  EventListener,
  StartSessionResult,
  WindowApi,
} from "../shared/api";
import type {
  AudioDevice,
  Framework,
  ReportFormat,
  Settings,
  StartSessionConfig,
} from "../shared/contracts";

const api: WindowApi = {
  startSession: (config: StartSessionConfig) =>
    ipcRenderer.invoke("session.start", config) as Promise<StartSessionResult>,
  pauseSession: () => ipcRenderer.invoke("session.pause"),
  stopSession: () => ipcRenderer.invoke("session.stop"),
  listAudioDevices: async (): Promise<AudioDevice[]> => {
    // enumerate via standard browser API (validated main-side)
    const devices = await navigator.mediaDevices.enumerateDevices();
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
    ipcRenderer.invoke("capture.selectDevice", id) as Promise<boolean>,
  subscribeEvents: <K extends keyof AppEvents>(
    event: K,
    listener: EventListener<K>,
  ) => {
    const channel = {
      "transcript.partial": "transcript.partial",
      "transcript.final": "transcript.final",
      "capture.status": "capture.status",
      "asr.status": "asr.status",
      "analysis.status": "analysis.status",
      "analysis.issues": "analysis.issues",
      "app.error": "app.error",
    }[event];
    const handler = (_e: unknown, payload: AppEvents[K]) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  listFrameworks: () => ipcRenderer.invoke("framework.list") as Promise<Framework[]>,
  saveFramework: (framework: Framework) =>
    ipcRenderer.invoke("framework.save", framework) as Promise<boolean>,
  getSettings: () => ipcRenderer.invoke("settings.get") as Promise<Settings>,
  saveSettings: (settings: Settings) =>
    ipcRenderer.invoke("settings.save", settings) as Promise<boolean>,
  exportReport: (sessionId: string, format: ReportFormat) =>
    ipcRenderer.invoke("report.export", sessionId, format) as Promise<string>,
};

// expose raw audio ingest hook used by capture pipeline
contextBridge.exposeInMainWorld("appApi", {
  ...api,
  sendAudioChunk: (float32: Float32Array, sourceRate: number) => {
    ipcRenderer.send("capture.audioChunk", float32, sourceRate);
  },
});
