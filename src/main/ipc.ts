import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { Store } from "./storage/store";
import { SessionOrchestrator } from "./analysis/orchestrator";
import { StartSessionConfigSchema, SettingsSchema, ReportFormatSchema } from "../shared/schemas";
import fs from "node:fs";
import path from "node:path";

export function registerIpc(store: Store, orchestrator: SessionOrchestrator) {
  const active = () => orchestrator.sessionIsActive;

  ipcMain.handle("session.start", async (_e, rawConfig: unknown) => {
    const parsed = StartSessionConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return { sessionId: "", error: { code: "IPC_VALIDATION", message: "参数校验失败", retryable: false } };
    }
    return orchestrator.start(parsed.data);
  });

  ipcMain.handle("session.pause", async () => {
    if (active()) await orchestrator.pause();
  });

  ipcMain.handle("session.stop", async () => {
    if (active()) await orchestrator.stop();
  });

  ipcMain.handle("capture.selectDevice", async (_e, deviceId: unknown) => {
    return typeof deviceId === "string";
  });

  ipcMain.handle("framework.list", async () => store.listFrameworks());

  ipcMain.handle("framework.save", async (_e, framework: unknown) => {
    if (typeof framework !== "object" || framework === null) return false;
    const fw = framework as { id?: string; name?: string };
    if (typeof fw.id !== "string" || typeof fw.name !== "string") return false;
    store.saveFramework(framework as Parameters<Store["saveFramework"]>[0]);
    return true;
  });

  ipcMain.handle("settings.get", async () => {
    const raw = store.getSetting("app_settings");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });

  ipcMain.handle("settings.save", async (_e, rawSettings: unknown) => {
    const parsed = SettingsSchema.safeParse(rawSettings);
    if (!parsed.success) return false;
    const clone = JSON.parse(JSON.stringify(parsed.data));
    if (clone.llm?.api_key) {
      store.setSetting("llm_api_key", clone.llm.api_key);
      delete clone.llm.api_key;
    }
    store.setSetting("app_settings", JSON.stringify(clone));
    return true;
  });

  ipcMain.handle("report.export", async (_e, sessionId: unknown, format: unknown) => {
    if (typeof sessionId !== "string") return "";
    const fmtParsed = ReportFormatSchema.safeParse(format);
    if (!fmtParsed.success) return "";
    const issues = store.listIssues(sessionId);
    const segments = store.querySegments({ sessionId, finalOnly: true });
    let content: string;
    if (fmtParsed.data === "json") {
      content = JSON.stringify({ sessionId, issues, segments }, null, 2);
    } else {
      content = `# 盯播报告 ${sessionId}\n\n## 问题\n`;
      for (const i of issues) {
        content += `- [${i.severity}] ${i.type}: ${i.quote} — ${i.recommendation}\n`;
      }
      content += "\n## 转写\n";
      for (const s of segments) {
        content += `- [${s.startMs}ms] ${s.text}\n`;
      }
    }
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(win ? app.getPath("documents") : ".", `report-${sessionId}.${fmtParsed.data === "json" ? "json" : "md"}`),
    });
    if (result.canceled || !result.filePath) return "";
    fs.writeFileSync(result.filePath, content, "utf8");
    return result.filePath;
  });
}
