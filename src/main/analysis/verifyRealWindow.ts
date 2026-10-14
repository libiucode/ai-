import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { FrameworkSchema, TranscriptSegmentSchema } from "../../shared/schemas";
import type { Framework, Issue, TranscriptSegment } from "../../shared/contracts";
import { Store } from "../storage/store";
import { readRuntimeLlmConfig } from "../security/runtimeConfig";
import { buildHtmlReport, buildReportSummary } from "../report/reportBuilder";
import { SessionOrchestrator } from "./orchestrator";
import { LlmClient } from "./llmClient";
import { ScriptLoopState } from "./ruleEngine";

/**
 * Chief 锁定的唯一供应商口径。任何其他 base_url/model 都不得直接使用
 * 用户提供的密钥调用：若实际配置与此不一致，先停止执行并上报，
 * 绝不把某一供应商的 key 隐式发到另一个端点。
 */
export const LOCKED_LLM_BASE_URL = "http://127.0.0.1:3425/v1";
export const LOCKED_LLM_MODEL = "group/auto-step-5-preview";

export function assertLockedLlmTarget(config: { base_url: string; model: string }): void {
  const base = config.base_url.replace(/\/+$/, "");
  const expected = LOCKED_LLM_BASE_URL.replace(/\/+$/, "");
  if (base !== expected || config.model !== LOCKED_LLM_MODEL) {
    throw new Error(
      `LLM目标与Chief锁定口径不一致（期望 ${LOCKED_LLM_BASE_URL} + ${LOCKED_LLM_MODEL}）：` +
      "请先与盯播负责人/Chief确认实际配置，不得把密钥发往未确认端点。",
    );
  }
}

export interface RealWindowOptions {
  dbPath: string;
  sessionId: string;
  windowEndMs: number;
  outputPath: string;
  sourceLabel: string;
  confirmedRealAsr: boolean;
  frameworkId?: string;
}

/** Read live source DB without migration/writes; replay one source window into an isolated memory DB. */
export async function verifyRealWindow(options: RealWindowOptions) {
  if (!options.confirmedRealAsr || !options.sourceLabel.trim()) throw new Error("必须由操作人员确认真实ASR来源，并提供source-label；不得以模拟文字冒充真实转写");
  if (!Number.isInteger(options.windowEndMs) || options.windowEndMs <= 0) throw new Error("end-ms必须为正的会话相对毫秒数");
  const sourcePath = path.resolve(options.dbPath);
  const outputPath = path.resolve(options.outputPath);
  if ([outputPath, `${outputPath}.html`].some((p) => p.toLowerCase() === sourcePath.toLowerCase())) throw new Error("输出路径不得覆盖来源数据库");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const memory = new Store(":memory:");
  try {
    const setting = (key: string) => (source.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value ?? null;
    // runtimeConfig reads only public app_settings; provider key is environment-only.
    const config = readRuntimeLlmConfig({ getSetting: setting } as Store);
    if (!config) throw new Error("安全LLM环境配置未齐：需DSH_SECRET_LLM_API_KEY及已确认的公开base_url/model");
    // 发任何真实请求前先确认目标，避免把密钥发到非锁定端点。
    assertLockedLlmTarget(config);
    const session = source.prepare("SELECT * FROM sessions WHERE id=?").get(options.sessionId) as { started_at_iso: string; ended_at_iso: string | null; audio_source: string; device_id: string | null } | undefined;
    if (!session) throw new Error("来源会话不存在");
    const frameworkRow = (options.frameworkId
      ? source.prepare("SELECT * FROM frameworks WHERE id=?").get(options.frameworkId)
      : source.prepare("SELECT * FROM frameworks LIMIT 1").get()) as { id: string; name: string; product_facts: string; updated_at: string } | undefined;
    if (!frameworkRow) throw new Error("来源数据库没有话术框架，无法验收话术比对");
    const steps = source.prepare("SELECT id,framework_id AS frameworkId,name,priority,max_wait_ms AS maxWaitMs FROM framework_steps WHERE framework_id=?").all(frameworkRow.id);
    const rules = (source.prepare("SELECT id,framework_id AS frameworkId,step_id AS stepId,rule_type AS ruleType,pattern,enabled FROM framework_rules WHERE framework_id=?").all(frameworkRow.id) as Array<Record<string, unknown>>).map((r) => ({ ...r, enabled: !!r.enabled }));
    const framework: Framework = FrameworkSchema.parse({ id: frameworkRow.id, name: frameworkRow.name, productFacts: frameworkRow.product_facts, updatedAt: frameworkRow.updated_at, steps, rules });
    const windowStartMs = Math.max(0, options.windowEndMs - 300000);
    const rows = source.prepare("SELECT id,session_id AS sessionId,connection_id AS connectionId,source_seq AS sourceSeq,start_ms AS startMs,end_ms AS endMs,text,is_final AS isFinal,created_at AS createdAt FROM transcript_segments WHERE session_id=? AND is_final=1 AND start_ms<? AND end_ms>? ORDER BY start_ms").all(options.sessionId, options.windowEndMs, windowStartMs) as Array<Record<string, unknown>>;
    const segments: TranscriptSegment[] = rows.map((r) => TranscriptSegmentSchema.parse({ ...r, isFinal: !!r.isFinal }));
    if (!segments.length) throw new Error("指定窗口没有实际稳态ASR片段，未发送LLM请求");
    if (segments.some((s) => s.endMs < s.startMs)) throw new Error("来源片段时间范围非法");
    const intervals = source.prepare("SELECT id,session_id AS sessionId,start_ms AS startMs,end_ms AS endMs FROM speech_intervals WHERE session_id=? AND start_ms<? AND end_ms>? ORDER BY start_ms").all(options.sessionId, options.windowEndMs, windowStartMs) as Array<{ id: string; sessionId: string; startMs: number; endMs: number }>;
    memory.createSession({ id: options.sessionId, startedAtIso: session.started_at_iso, audioSource: session.audio_source, deviceId: session.device_id });
    memory.saveFramework(framework);
    for (const s of segments) memory.insertSegment(s);
    for (const iv of intervals) memory.insertSpeechInterval(iv);
    const llm = new LlmClient(); llm.configure(config);
    const phase = new ScriptLoopState(); for (const s of segments) phase.feed(s.text, s.endMs);
    const orch = new SessionOrchestrator(memory);
    // Deliberately don't call start(): no capture, ASR connection or source DB writes.
    Object.assign(orch, { sessionId: options.sessionId, sessionStartEpoch: Date.now() - options.windowEndMs, llm, scriptState: phase });
    const events: Array<{ event: string; payload: unknown }> = [];
    orch.setWindow({ isDestroyed: () => false, webContents: { send: (event: string, payload: unknown) => events.push({ event, payload }) } } as never);
    await (orch as unknown as { runAnalysis: (a: number, b: number) => Promise<void> }).runAnalysis(windowStartMs, options.windowEndMs);
    memory.updateSessionStatus(options.sessionId, "stopped", session.ended_at_iso ?? new Date().toISOString());
    const report = buildReportSummary(memory, options.sessionId)!;
    const runs = memory.db.prepare("SELECT status,error_message FROM analysis_runs WHERE session_id=?").all(options.sessionId) as Array<{ status: string; error_message: string | null }>;
    const shown = events.filter((e) => e.event === "analysis.issues").flatMap((e) => e.payload as Issue[]);
    const byId = new Map(segments.map((s) => [s.id, s]));
    const allEvidenceValid = shown.every((issue) => issue.segmentIds.length > 0 && issue.segmentIds.every((id) => byId.has(id)) && issue.segmentIds.some((id) => byId.get(id)!.text.includes(issue.quote)));
    const result = {
      verificationKind: "operator-confirmed-real-asr-window-live-llm",
      executedAtIso: new Date().toISOString(),
      sourceLabel: options.sourceLabel,
      sourceSessionId: options.sessionId,
      sourceConfirmation: "由操作人员确认来源，数据库记录本身不能证明录音来源真实性",
      window: { startMs: windowStartMs, endMs: options.windowEndMs },
      model: config.model,
      lockedTarget: { base_url: LOCKED_LLM_BASE_URL, model: LOCKED_LLM_MODEL },
      requestCount: llm.budgetUsed,
      transcriptSegmentCount: segments.length,
      allDisplayedEvidenceValid: allEvidenceValid,
      analysisRuns: runs,
      displayedIssues: shown,
      sourceSegments: segments,
      reviewStatus: { reviewedRealCandidates: 0, requiredRealCandidates: 20, falsePositiveRate: "未实测", falseNegativeRate: "未实测" },
      report,
    };
    const redactText = (text: string) => text.replaceAll(config.api_key, "[REDACTED]");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, redactText(JSON.stringify(result, null, 2)), "utf8");
    fs.writeFileSync(`${outputPath}.html`, redactText(buildHtmlReport(report)), "utf8");
    return { outputPath, htmlPath: `${outputPath}.html`, status: runs[0]?.status ?? "unknown", requestCount: llm.budgetUsed, transcriptSegmentCount: segments.length, issueCount: shown.length, allEvidenceValid };
  } finally { memory.close(); source.close(); }
}

function cliValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`缺少参数${flag}`);
  return argv[index + 1];
}
if (require.main === module) {
  const argv = process.argv.slice(2);
  Promise.resolve().then(() => verifyRealWindow({
    dbPath: cliValue(argv, "--db"),
    sessionId: cliValue(argv, "--session"),
    windowEndMs: Number(cliValue(argv, "--end-ms")),
    outputPath: cliValue(argv, "--output"),
    sourceLabel: cliValue(argv, "--source-label"),
    confirmedRealAsr: argv.includes("--confirm-real-asr"),
    frameworkId: argv.includes("--framework-id") ? cliValue(argv, "--framework-id") : undefined,
  })).then((result) => {
    console.log(JSON.stringify(result));
    if (result.status !== "success" || !result.allEvidenceValid) process.exitCode = 1;
  }).catch(() => {
    // Never echo provider/network errors or credentials to the console.
    console.error("真实窗口验证未完成；请核对来源参数、安全环境配置及报告状态。");
    process.exitCode = 1;
  });
}
