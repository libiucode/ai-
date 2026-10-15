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
  type AsrConfig,
  type LlmConfig,
} from "../shared/schemas";
import { TencentAsrAdapter } from "./asr/tencentAdapter";
import { buildReportSummary, buildHtmlReport } from "./report/reportBuilder";
import fs from "node:fs";
import path from "node:path";
import { readRuntimeAsrConfig, readRuntimeLlmConfig, withoutCredentials, diagnoseAsrConfig, diagnoseLlmConfig } from "./security/runtimeConfig";

/** Session-scoped test adapter so connect tests never touch the live orchestrator ASR. */
let testAsr: TencentAsrAdapter | null = null;

/** Compatibility names: public options are saved; credentials come only from env. */
export function readStoredAsrConfig(store: Store): AsrConfig | null {
  return readRuntimeAsrConfig(store);
}

export function readStoredLlmConfig(store: Store): LlmConfig | null {
  return readRuntimeLlmConfig(store);
}

/** 连接测试请求是否标记为“使用已保存配置”（界面字段留空但已配置过时）。 */
function wantsStoredConfig(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as { useStored?: unknown }).useStored === true;
}

/**
 * Redacts anything resembling a key/signature from provider error text before
 * it reaches the UI, logs, or exports.
 */
export function redactSecrets(text: string): string {
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
  // 注意：makeError 产出的是普通对象不是 Error 实例（probe 的服务端裁决错误就是它），
  // 只认 instanceof Error 会把“鉴权失败”压成“unknown error”。
  let raw = "unknown error";
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    raw = (err as { message: string }).message;
  }
  const code =
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : fallbackCode;
  return { code, message: redactSecrets(raw), retryable: false };
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

  ipcMain.handle(IpcChannels.sessionResume, async () => {
    if (active()) await orchestrator.resume();
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
          frameworkId: row.framework_id,
          speakerId: row.speaker_id,
          speakerName: row.speaker_name,
          endReason: row.end_reason,
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

  // 原先这里有一个 captureSelectDevice handler，只 return typeof deviceId === "string"，
  // 主进程侧没有任何效果——调用方却以为"设备选择被记录了"。
  // 设备选择持久化改走 settingsSave（公开配置通道，与 App ID / Base URL 同类），
  // 见 renderer/pages/MonitorPage.tsx 的 onSelectDevice 与 deviceSelection.ts。
  // 假通道比没有通道更糟：留着会让人以为设备选择有主进程侧记录，重新踩一遍。
  // 2026-10-15 二轮清理：IPC handler / preload / api 契约三层一并移除。

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
      return withoutCredentials(JSON.parse(raw));
    } catch {
      return {};
    }
  });

  ipcMain.handle(IpcChannels.settingsSave, async (_e, rawSettings: unknown) => {
    const safeInput = withoutCredentials(rawSettings);
    if (!safeInput || typeof safeInput !== "object") return false;
    const input = safeInput as Record<string, unknown>;
    const parsed = SettingsSchema.safeParse({ ...input, asr: undefined });
    if (!parsed.success) return false;
    const clone = withoutCredentials(parsed.data) as Record<string, unknown>;
    if (input.asr !== undefined) {
      const asrParsed = AsrConfigSchema.omit({ secretId: true, secretKey: true }).safeParse(input.asr);
      if (!asrParsed.success) return false;
      clone.asr = asrParsed.data;
    }
    store.setSetting("app_settings", JSON.stringify(clone));
    return true;
  });

  // Credentials never cross IPC or get written to SQLite.
  ipcMain.handle("settings.getAsrStatus", async () => {
    const cfg = readRuntimeAsrConfig(store);
    const diag = diagnoseAsrConfig(store);
    return {
      configured: Boolean(cfg),
      appId: cfg?.appId ?? "1502622498",
      source: "environment",
      credentialPresent: diag.credentialPresent,
      message: diag.message,
    };
  });

  ipcMain.handle("settings.getLlmStatus", async () => {
    const cfg = readRuntimeLlmConfig(store);
    const diag = diagnoseLlmConfig(store);
    let llm: { base_url?: string; model?: string } = {};
    try {
      const raw = store.getSetting("app_settings");
      llm = raw ? JSON.parse(raw).llm ?? {} : {};
    } catch { /* keep defaults */ }
    return {
      configured: Boolean(cfg),
      baseUrl: process.env.DSH_LLM_BASE_URL || llm.base_url || "",
      model: process.env.DSH_LLM_MODEL || llm.model || "",
      source: "environment",
      publicConfigPresent: diag.publicConfigPresent,
      credentialPresent: diag.credentialPresent,
      message: diag.message,
    };
  });

  // ---- connection tests (session-scoped, never touch the live session) ----

  ipcMain.handle(IpcChannels.asrTestConnection, async (_e, rawConfig: unknown) => {
    // 两种调用：带完整字段直接测；useStored 测库里已存配置（渲染层始终不落明文）
    let config: AsrConfig;
    if (wantsStoredConfig(rawConfig)) {
      const stored = readStoredAsrConfig(store);
      if (!stored) {
        return { ok: false, error: { code: "ASR_NOT_CONFIGURED", message: diagnoseAsrConfig(store).message, retryable: false } };
      }
      config = stored;
    } else {
      const parsed = AsrConfigSchema.safeParse({
        ...(typeof rawConfig === "object" && rawConfig !== null ? rawConfig : {}),
        secretId: process.env.DSH_SECRET_TENCENT_ASR_SECRET_ID ?? "",
        secretKey: process.env.DSH_SECRET_TENCENT_ASR_SECRET_KEY ?? "",
      });
      if (!parsed.success) {
        return { ok: false, error: { code: "ASR_CONFIG_INVALID", message: "ASR 配置不完整：需要 App ID、Secret ID、Secret Key", retryable: false } };
      }
      config = parsed.data;
    }
    if (testAsr) {
      try { await testAsr.stop(); } catch { /* best effort */ }
    }
    const adapter = new TencentAsrAdapter();
    testAsr = adapter;
    // probe 内部 open 后有 1.5s 服务端裁决窗口；外层 12s 兜底防挂起
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("连接测试超时")), 12000),
    );
    try {
      const result = await Promise.race([adapter.probe(config), timeout]);
      return result.ok
        ? { ok: true, error: null }
        : { ok: false, error: safeError(result.error, "ASR_CONNECT_FAILED") };
    } catch (err) {
      return { ok: false, error: safeError(err, "ASR_CONNECT_FAILED") };
    } finally {
      try { await adapter.stop(); } catch { /* best effort */ }
      testAsr = null;
    }
  });

  ipcMain.handle(IpcChannels.llmTestConnection, async (_e, rawConfig: unknown) => {
    let config: LlmConfig;
    if (wantsStoredConfig(rawConfig)) {
      const stored = readStoredLlmConfig(store);
      if (!stored) {
        return { ok: false, error: { code: "LLM_NOT_CONFIGURED", message: diagnoseLlmConfig(store).message, retryable: false } };
      }
      config = stored;
    } else {
      const parsed = LlmConfigSchema.safeParse({
        ...(typeof rawConfig === "object" && rawConfig !== null ? rawConfig : {}),
        api_key: process.env.DSH_SECRET_LLM_API_KEY ?? "",
      });
      if (!parsed.success) {
        return { ok: false, error: { code: "LLM_CONFIG_INVALID", message: "LLM 配置不完整：需要 Base URL、模型名、API Key", retryable: false } };
      }
      config = parsed.data;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${config.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
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
