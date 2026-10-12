import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { Store } from "./storage/store";
import { SessionOrchestrator } from "./analysis/orchestrator";
import { registerIpc } from "./ipc";
import { setLogger, reportErrorToWindow } from "./security/errors";

let store: Store;
let orchestrator: SessionOrchestrator;
let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  orchestrator.setWindow(mainWindow);
  mainWindow.loadFile(
    path.join(__dirname, "../renderer/index.html"),
  );
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath("userData"), "live-monitor.db");
  store = new Store(dbPath);
  orchestrator = new SessionOrchestrator(store);

  setLogger((msg, details) => {
    console.error(`[error] ${msg}`, details ?? "");
  });

  registerIpc(store, orchestrator);

  // audio stream from renderer
  ipcMain.on("capture.audioChunk", (_e, data: Float32Array, sourceRate: number) => {
    orchestrator.ingestAudio(data, sourceRate);
  });

  process.on("uncaughtException", (err) => {
    reportErrorToWindow(mainWindow, {
      code: "UNCAUGHT",
      message: err.message,
      retryable: false,
    });
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (orchestrator?.sessionIsActive) {
    void orchestrator.stop();
  }
  store?.close();
  if (process.platform !== "darwin") app.quit();
});
