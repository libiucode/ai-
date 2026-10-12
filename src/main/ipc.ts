import { ipcMain, BrowserWindow, dialog, app } from "electron";
import { Store } from "./storage/store";
import { SessionOrchestrator } from "./analysis/orchestrator";
import {
  StartSessionConfigSchema,
  SettingsSchema,
  ReportFormatSchema,
  FrameworkSchema,
  AsrConfigSchema,
  LlmConfigSchema,
  IpcChannels,
} from "../shared/schemas";
import { TencentAsrAdapter } from "./asr/tencentAdapter";
import { buildReportSummary, buildHtmlReport } from "./report/reportBuilder";
import fs from "node:fs";
import path from "node:path";

/** Session-scoped test adapter so connect tests never touch the live orchestrator ASR. */
let testAsr: TencentAsrAdapter | null = null;

/**
 * Redacts anything resembling a key/signature from provider error text before
 * it reaches the UI, logs, or exports.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/(secretid|secret_key|secretkey|api[_-]?key|authorization|token|signature)=?[^\s,&"']*/gi, "$1=***")
    .replace(/AKID[A-Za-z0-9]{10,}/g, "AKID***")
    .replace(/sk-[A-Za-z0-9-]{8,}/g, "sk-***");
}

function safeError(err: unknown, fallbackCode: string): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const raw = err instanceof Error ? err.message : "unknown error";
  return {
    code: fallbackCode,
    message: redactSecrets(raw),
    retryable: false,
  };
}

export function registerIpc(store: Store, orchestrator: SessionOrchestrator) {
  const active = () => orchestrator.sessionIsActive;

  ipcMain.handle(IpcChannels.sessionStart, async (_e, rawConfig: unknown) => {
    const parsed = StartSessionConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return { sessionId: "", error: { code: "IPC_VALIDATION", message: "参数校验失败", retryable: false } };
    }
    return orchestrator.start(parsed.data);
  });

  ipcMain.handle(IpcChannels.sessionPause, async () => {
    if (active()) await orchestrator.pause();
  });

  ipcMain.handle(IpcChannels.sessionStop, async () => {
    if (active()) await orchestrator.stop();
  });

  ipcMain.handle(IpcChannels.sessionList, async () => {
    try {
      return { sessions: store.listSessionSummaries(), error: null };
    } catch (err) {
      return { sessions: [], error: safeError(err, "DB_READ_FAILED") };
    }
  });

  ipcMain.handle(IpcChannels.sessionDetail, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string") {
      return { session: null, segments: [], issues: [], error: { code: "IPC_VALIDATION", message: "参数错误", retryable: false } };
    }
    try {
      const row = store.getSession(sessionId);
      if (!row) {
        return { session: null, segments: [], issues: [], error: { code: "SESSION_NOT_FOUND", message: "会话不存在", retryable: false } };
      }
      const issues = store.listIssues(sessionId).map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        analysisRunId: r.analysis_run_id as string,
        type: r.type as never,
        severity: r.severity as never,
        startMs: r.start_ms as number,
        endMs: r.end_ms as number,
        segmentIds: JSON.parse((r.segment_ids as string) ?? "[]") as string[],
        quote: r.quote as string,
        basis: r.basis as string,
        recommendation: r.recommendation as string,
        suggestedScript: (r.suggested_script as string) ?? null,
        confidence: r.confidence as number,
        needsReview: (r.needs_review as number) === 1,
        status: r.status as never,
        occurrenceCount: r.occurrence_count as number,
        firstSeenMs: r.first_seen_ms as number,
        lastSeenMs: r.last_seen_ms as number,
      }));
      return {
        session: {
          id: row.id,
          startedAtIso: row.started_at_iso,
          endedAtIso: row.ended_at_iso,
          audioSource: row.audio_source,
          deviceId: row.device_id,
          status: row.status,
        },
        segments: store.querySegments({ sessionId, finalOnly: true }),
        issues,
        error: null,
      };
    } catch (err) {
      return { session: null, segments: [], issues: [], error: safeError(err, "DB_READ_FAILED") };
    }
  });

  ipcMain.handle(IpcChannels.sessionDelete, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string") return false;
    if (orchestrator.getSnapshot().sessionId === sessionId && active()) return false;
    try {
      return store.deleteSession(sessionId);
    } catch {
      return false;
    }
  });

  ipcMain.handle(IpcChannels.captureSelectDevice, async (_e, deviceId: unknown) => {
    return typeof deviceId === "string";
  });

  ipcMain.handle(IpcChannels.frameworkList, async () => store.listFrameworks());

  ipcMain.handle(IpcChannels.frameworkSave, async (_e, framework: unknown) => {
    const parsed = FrameworkSchema.safeParse(framework);
    if (!parsed.success) return false;
    store.saveFramework(parsed.data);
    return true;
  });

  ipcMain.handle(IpcChannels.settingsGet, async () => {
    const raw = store.getSetting("app_settings");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });

  ipcMain.handle(IpcChannels.settingsSave, async (_e, rawSettings: unknown) => {
    const parsed = SettingsSchema.safeParse(rawSettings);
    if (!parsed.success) return false;
    const clone = JSON.parse(JSON.stringify(parsed.data));
    if (clone.llm?.api_key) {
      store.setSetting("llm_api_key", clone.llm.api_key);
      delete clone.llm.api_key;
    }
    // ASR credentials live in their own key, never inside app_settings
    if (clone.asr) {
      const asrParsed = AsrConfigSchema.safeParse(clone.asr);
      if (!asrParsed.success) return false;
      store.setSetting("asr_config", JSON.stringify(asrParsed.data));
      delete clone.asr;
    }
    store.setSetting("app_settings", JSON.stringify(clone));
    return true;
  });

  // Returns asr config with secrets masked so the settings page can show
  // "configured" state without exposing values.
  ipcMain.handle("settings.getAsrStatus", async () => {
    const raw = store.getSetting("asr_config");
    if (!raw) return { configured: false };
    try {
      const cfg = JSON.parse(raw) as { secretId?: string; appId?: string };
      return {
        configured: true,
        appId: cfg.appId ?? "",
        secretIdTail: (cfg.secretId ?? "").slice(-4),
      };
    } catch {
      return { configured: false };
    }
  });

  ipcMain.handle("settings.getLlmStatus", async () => {
    const raw = store.getSetting("app_settings");
    const llmKey = store.getSetting("llm_api_key");
    let llm: { base_url?: string; model?: string } = {};
    if (raw) {
      try {
        llm = (JSON.parse(raw) as { llm?: { base_url?: string; model?: string } }).llm ?? {};
      } catch {
        /* fallthrough */
      }
    }
    return {
      configured: Boolean(llm.base_url && llm.model && llmKey),
      baseUrl: llm.base_url ?? "",
      model: llm.model ?? "",
      keyTail: (llmKey ?? "").slice(-4),
    };
  });

  // ---- connection tests (session-scoped, never touch the live session) ----

  ipcMain.handle(IpcChannels.asrTestConnection, async (_e, rawConfig: unknown) => {
    const parsed = AsrConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return { ok: false, error: { code: "ASR_CONFIG_INVALID", message: "ASR 配置不完整：需要 App ID、Secret ID、Secret Key", retryable: false } };
    }
    if (testAsr) {
      try { await testAsr.stop(); } catch { /* best effort */ }
    }
    testAsr = new TencentAsrAdapter();
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("连接测试超时")), 10000),
      );
      await Promise.race([testAsr.connect(parsed.data), timeout]);
      await testAsr.stop();
      return { ok: true, error: null };
    } catch (err) {
      try { await testAsr.stop(); } catch { /* best effort */ }
      testAsr = null;
      return { ok: false, error: safeError(err, "ASR_CONNECT_FAILED") };
    }
  });

  ipcMain.handle(IpcChannels.llmTestConnection, async (_e, rawConfig: unknown) => {
    const parsed = LlmConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      return { ok: false, error: { code: "LLM_CONFIG_INVALID", message: "LLM 配置不完整：需要 Base URL、模型名、API Key", retryable: false } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${parsed.data.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parsed.data.api_key}`,
        },
        body: JSON.stringify({
          model: parsed.data.model,
          messages: [{ role: "user", content: "回复 OK 两个字" }],
          max_tokens: 8,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // never surface the raw provider body: it may echo auth material
        return { ok: false, error: { code: "LLM_HTTP_ERROR", message: `LLM 服务返回 HTTP ${res.status}`, retryable: false } };
      }
      const data = (await res.json()) as { choices?: unknown };
      if (!Array.isArray(data.choices)) {
        return { ok: false, error: { code: "LLM_BAD_RESPONSE", message: "LLM 响应格式异常", retryable: false } };
      }
      return { ok: true, error: null };
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError" ? "连接测试超时" : err instanceof Error ? err.message : "unknown";
      return { ok: false, error: safeError(new Error(msg), "LLM_CONNECT_FAILED") };
    } finally {
      clearTimeout(timer);
    }
  });

  // ---- report ----

  ipcMain.handle(IpcChannels.reportGenerate, async (_e, sessionId: unknown, format: unknown) => {
    if (typeof sessionId !== "string") return null;
    const fmtParsed = ReportFormatSchema.safeParse(format);
    if (!fmtParsed.success) return null;
    const report = buildReportSummary(store, sessionId);
    if (!report) return null;
    return report;
  });

  ipcMain.handle(IpcChannels.reportExport, async (_e, sessionId: unknown, format: unknown) => {
    if (typeof sessionId !== "string") return "";
    const fmtParsed = ReportFormatSchema.safeParse(format);
    if (!fmtParsed.success) return "";
    const report = buildReportSummary(store, sessionId);
    if (!report) return "";
    let content: string;
    let ext: string;
    if (fmtParsed.data === "json") {
      content = JSON.stringify(report, null, 2);
      ext = "json";
    } else {
      content = buildHtmlReport(report);
      ext = "html";
    }
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(win ? app.getPath("documents") : ".", `report-${sessionId.slice(0, 8)}.${ext}`),
    });
    if (result.canceled || !result.filePath) return "";
    fs.writeFileSync(result.filePath, content, "utf8");
    return result.filePath;
  });
}
