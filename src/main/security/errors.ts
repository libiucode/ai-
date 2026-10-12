import { app, BrowserWindow } from "electron";

let logger: ((msg: string, details?: Record<string, unknown>) => void) | null =
  null;

export function setLogger(
  fn: (msg: string, details?: Record<string, unknown>) => void,
) {
  logger = fn;
}

export function logError(msg: string, details?: Record<string, unknown>) {
  if (logger) {
    logger(msg, details);
    return;
  }
  console.error(`[app-error] ${msg}`, details ?? "");
}

export function reportErrorToWindow(
  win: BrowserWindow | null,
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> },
) {
  const safe = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: error.details ?? {},
  };
  if (win && !win.isDestroyed()) {
    win.webContents.send("app.error", safe);
  }
  logError(error.message, { code: error.code });
}

export function dataDir(): string {
  return app.getPath("userData");
}
