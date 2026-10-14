import { app, BrowserWindow, ipcMain, desktopCapturer, screen } from "electron";
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
  // Electron does not provide Chrome's display picker on Windows. Only the
  // app's own top-level frame may request the screen + system loopback stream.
  //
  // 默认要求 request.userGesture：防止子页面或脚本在用户不知情时启动系统录音。
  //
  // 已知限制（2026-10-14 实测）：Chromium 的 user activation 只由真实用户输入产生。
  // CDP 的 Input.dispatchMouseEvent 是合成输入，Win32 mouse_event 是硬件级但同样
  // 不产生 activation——两者都无法驱动 getDisplayMedia 通过手势校验。
  // 因此本地自动化验收无法只靠模拟点击完成系统声验收。
  // 下面这个环境旁路默认关闭，仅用于持凭证的本地验收实例，交付/生产行为不变。
  const allowGesturelessCapture = process.env.AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE === "1";
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const owner = mainWindow;
    const gestureOk = request.userGesture || allowGesturelessCapture;
    if (process.platform !== "win32" || !owner || owner.isDestroyed() ||
        request.frame !== owner.webContents.mainFrame || !gestureOk ||
        !request.audioRequested || !request.videoRequested) {
      callback({});
      return;
    }
    void desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    }).then((sources) => {
      if (owner.isDestroyed() || request.frame !== owner.webContents.mainFrame) {
        callback({});
        return;
      }
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primaryId) ?? sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: "loopback" });
    }).catch(() => {
      callback({});
      reportErrorToWindow(owner, {
        code: "CAPTURE_SOURCE_FAILED",
        message: "无法取得系统声音采集源，请检查显示器和系统录音权限。",
        retryable: true,
      });
    });
  });
  orchestrator.setWindow(mainWindow);
  mainWindow.loadFile(
    path.join(__dirname, "../../renderer/index.html"),
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
  // macOS can reopen the existing application via activate; keep its Store alive.
  void (async () => {
    if (orchestrator?.sessionIsActive) await orchestrator.stop();
    if (process.platform !== "darwin") {
      store?.close();
      app.quit();
    }
  })().catch(() => {
    // Exiting must not surface provider credentials or leave a headless process.
    console.error("[shutdown] 会话收尾失败，请检查本地数据记录。");
    app.exit(1);
  });
});
