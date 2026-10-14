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

/** 样本性质：必须显式声明，不得用「真实直播流」这类笼统措辞掩盖实际内容。 */
export type SampleNature =
  | "clean-live-stream"
  | "advertisement-voiceover"
  | "tts-voiceover"
  | "mixed"
  | "unknown";

export interface SampleBoundary {
  /** 干净（可用）区间，会话相对毫秒；无干净区间时为 null */
  cleanRangeMs: { startMs: number; endMs: number } | null;
  /** 说明该会话的污染或性质切换情况 */
  note: string;
  /** 本次分析窗口是否完全落在干净区间内 */
  windowWithinCleanRange: boolean;
}

export interface RealWindowOptions {
  dbPath: string;
  sessionId: string;
  windowEndMs: number;
  outputPath: string;
  sourceLabel: string;
  /** 本窗口样本的真实性质；用于报告如实标注，必填。 */
  sampleNature: SampleNature;
  /** 样本性质与污染边界的文字说明；必填，避免只写 sessionId。 */
  sampleBoundary: SampleBoundary;
  /**
   * 操作人员确认「这是真实 ASR 产出」。
   * 注意：它只确认「转写来自真实 ASR」，**不确认内容性质是带货直播**——
   * 内容性质一律由 sampleNature 决定，二者不可混为一谈。
   */
  confirmedRealAsr: boolean;
  frameworkId?: string;
  /**
   * 来源库没有话术框架时，用这个 JSON 提供框架（例如 demo/sample-framework.json）。
   * 只影响本次隔离分析，绝不写回来源库。
   */
  frameworkJsonPath?: string;
  /** 仅验证脚本使用：放宽整轮超时以适配真实推理模型耗时；生产默认仍为 20 秒。 */
  llmTimeoutMsOverride?: number;
  /** 仅验证规则链路：不调用 LLM，报告中必须标注语义分析未跑。 */
  skipLlm?: boolean;
}

/** Read live source DB without migration/writes; replay one source window into an isolated memory DB. */
export async function verifyRealWindow(options: RealWindowOptions) {
  if (!options.confirmedRealAsr || !options.sourceLabel.trim()) throw new Error("必须由操作人员确认真实ASR来源，并提供source-label；不得以模拟文字冒充真实转写");
  if (!Number.isInteger(options.windowEndMs) || options.windowEndMs <= 0) throw new Error("end-ms必须为正的会话相对毫秒数");
  // 样本性质必须显式声明：禁止用「真实直播流」这类措辞掩盖实际是广告口播或 TTS 的事实。
  if (!options.sampleNature) throw new Error("必须提供 sampleNature（clean-live-stream / advertisement-voiceover / tts-voiceover / mixed / unknown）");
  if (!options.sampleBoundary?.note?.trim()) throw new Error("必须提供 sampleBoundary.note，说明样本性质与污染边界；只写 sessionId 的引用视为无效");
  const windowStartMsForCheck = Math.max(0, options.windowEndMs - 300000);
  const clean = options.sampleBoundary.cleanRangeMs;
  const windowWithinClean = !clean
    ? false
    : windowStartMsForCheck >= clean.startMs && options.windowEndMs <= clean.endMs;
  options = {
    ...options,
    sampleBoundary: {
      ...options.sampleBoundary,
      windowWithinCleanRange: windowWithinClean,
      // 只要未完全落在干净区间内，就必须带警示——不论声明的是什么性质，
      // 避免「声明成干净直播」就把越界事实盖过去。
      note: windowWithinClean
        ? options.sampleBoundary.note
        : `${options.sampleBoundary.note}｜注意：本窗口(${windowStartMsForCheck}~${options.windowEndMs}ms)未完全落在干净区间内，结论不得表述为干净直播样本`,
    },
  };
  const sourcePath = path.resolve(options.dbPath);
  const outputPath = path.resolve(options.outputPath);
  if ([outputPath, `${outputPath}.html`].some((p) => p.toLowerCase() === sourcePath.toLowerCase())) throw new Error("输出路径不得覆盖来源数据库");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const memory = new Store(":memory:");
  try {
    const setting = (key: string) => (source.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined)?.value ?? null;
    // runtimeConfig reads only public app_settings; provider key is environment-only.
    const config = readRuntimeLlmConfig({ getSetting: setting } as Store);
    // --skip-llm：仅在没有安全密钥时验证规则引擎与证据校验，明确不宣称真实 LLM 验收。
    if (!config && !options.skipLlm) throw new Error("安全LLM环境配置未齐：需DSH_SECRET_LLM_API_KEY及已确认的公开base_url/model；如只验证规则链路请显式加 --skip-llm");
    // 发任何真实请求前先确认目标，避免把密钥发到非锁定端点。
    if (config) assertLockedLlmTarget(config);
    const session = source.prepare("SELECT * FROM sessions WHERE id=?").get(options.sessionId) as { started_at_iso: string; ended_at_iso: string | null; audio_source: string; device_id: string | null } | undefined;
    if (!session) throw new Error("来源会话不存在");
    let frameworkRow = (options.frameworkId
      ? source.prepare("SELECT * FROM frameworks WHERE id=?").get(options.frameworkId)
      : source.prepare("SELECT * FROM frameworks LIMIT 1").get()) as { id: string; name: string; product_facts: string; updated_at: string } | undefined;
    let framework: Framework;
    if (frameworkRow) {
      const steps = source.prepare("SELECT id,framework_id AS frameworkId,name,priority,max_wait_ms AS maxWaitMs FROM framework_steps WHERE framework_id=?").all(frameworkRow.id);
      const rules = (source.prepare("SELECT id,framework_id AS frameworkId,step_id AS stepId,rule_type AS ruleType,pattern,enabled FROM framework_rules WHERE framework_id=?").all(frameworkRow.id) as Array<Record<string, unknown>>).map((r) => ({ ...r, enabled: !!r.enabled }));
      framework = FrameworkSchema.parse({ id: frameworkRow.id, name: frameworkRow.name, productFacts: frameworkRow.product_facts, updatedAt: frameworkRow.updated_at, steps, rules });
    } else if (options.frameworkJsonPath) {
      // 来源库没有框架：从外部 JSON 读，只用于本次隔离分析，不写回来源库。
      const raw = JSON.parse(fs.readFileSync(path.resolve(options.frameworkJsonPath), "utf8")) as { framework?: unknown };
      framework = FrameworkSchema.parse((raw as { framework?: unknown }).framework ?? raw);
    } else {
      throw new Error("来源数据库没有话术框架；请用 --framework-json 提供框架文件，不要往用户数据库写数据");
    }
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
    const llm = new LlmClient();
    if (config) {
      const effective = options.llmTimeoutMsOverride && options.llmTimeoutMsOverride > 0
        ? { ...config, request_timeout_ms: options.llmTimeoutMsOverride }
        : config;
      llm.configure(effective, options.llmTimeoutMsOverride ? { maxTimeoutMs: options.llmTimeoutMsOverride } : undefined);
    }
    const phase = new ScriptLoopState(); for (const s of segments) phase.feed(s.text, s.endMs);
    const orch = new SessionOrchestrator(memory);
    // 不调用 start()：不启动采集、不连 ASR、不写来源库。
    // 但必须同步 llmState，否则 runAnalysis 会按"未配置"跳过语义分析，
    // 脚本会静默退化成"只跑本地规则"，那不是真实 LLM 验收。
    Object.assign(orch, {
      sessionId: options.sessionId,
      sessionStartEpoch: Date.now() - options.windowEndMs,
      llm,
      llmState: config ? "configured" : "not_configured",
      scriptState: phase,
    });
    const events: Array<{ event: string; payload: unknown }> = [];
    orch.setWindow({ isDestroyed: () => false, webContents: { send: (event: string, payload: unknown) => events.push({ event, payload }) } } as never);
    await (orch as unknown as { runAnalysis: (a: number, b: number) => Promise<void> }).runAnalysis(windowStartMs, options.windowEndMs);
    memory.updateSessionStatus(options.sessionId, "stopped", session.ended_at_iso ?? new Date().toISOString());
    const report = buildReportSummary(memory, options.sessionId)!;
    const runs = memory.db.prepare("SELECT status,error_message FROM analysis_runs WHERE session_id=?").all(options.sessionId) as Array<{ status: string; error_message: string | null }>;
    const shown = events.filter((e) => e.event === "analysis.issues").flatMap((e) => e.payload as Issue[]);
    const byId = new Map(segments.map((s) => [s.id, s]));
    // 注意：空集上做 every() 恒为 true，会把「一条问题都没产出」误报成
    // 「证据全部有效」。这里显式区分「无可验证样本」，避免指标误导。
    const checkedIssueCount = shown.length;
    const invalidIssueCount = shown.filter((issue) =>
      !(issue.segmentIds.length > 0
        && issue.segmentIds.every((id) => byId.has(id))
        && issue.segmentIds.some((id) => byId.get(id)!.text.includes(issue.quote))),
    ).length;
    const allEvidenceValid = checkedIssueCount > 0 && invalidIssueCount === 0;
    const evidenceNote = checkedIssueCount === 0
      ? "本次没有任何问题通过证据校验（可能为0问题、也可能被门禁全部拒绝），无可验证样本，不能据此宣称证据校验通过"
      : `已校验 ${checkedIssueCount} 条问题，无效 ${invalidIssueCount} 条`;
    const result = {
      // 不再用 operator-confirmed-real-... 这类暗示真实直播的笼统标签：
      // 「确认真实 ASR」≠「内容是带货直播」，两者必须分开表述。
      verificationKind: config ? "real-asr-window-live-llm" : "real-asr-window-rules-only",
      executedAtIso: new Date().toISOString(),
      semanticAnalysisRan: !!config,
      semanticAnalysisNote: config ? "真实LLM已调用" : "未调用LLM（无安全密钥或显式--skip-llm）：本结果只覆盖规则引擎与证据校验，不构成真实LLM验收",
      sourceLabel: options.sourceLabel,
      sourceSessionId: options.sessionId,
      /** 本窗口样本的真实性质；由调用方显式声明，非推断。 */
      sampleNature: options.sampleNature,
      /** 样本性质与污染边界；引用本报告必须连同该字段一起引用。 */
      sampleBoundary: options.sampleBoundary,
      sourceConfirmation: "由操作人员确认转写来自真实 ASR；该确认不表示内容性质是带货直播，内容性质见 sampleNature",
      window: { startMs: windowStartMs, endMs: options.windowEndMs },
      model: config?.model ?? null,
      lockedTarget: { base_url: LOCKED_LLM_BASE_URL, model: LOCKED_LLM_MODEL },
      requestCount: llm.budgetUsed,
      transcriptSegmentCount: segments.length,
      allDisplayedEvidenceValid: allEvidenceValid,
      evidenceCheck: { checkedIssueCount, invalidIssueCount, note: evidenceNote },
      analysisRuns: runs,
      displayedIssues: shown,
      sourceSegments: segments,
      reviewStatus: { reviewedRealCandidates: 0, requiredRealCandidates: 20, falsePositiveRate: "未实测", falseNegativeRate: "未实测" },
      report,
    };
    const redactText = (text: string) => (config ? text.replaceAll(config.api_key, "[REDACTED]") : text);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, redactText(JSON.stringify(result, null, 2)), "utf8");
    // HTML 是给人直接双击打开的工件：必须同样带上样本性质与边界，
    // 否则「纯 TTS 样本」在报告里看起来和真实直播报告没有区别。
    const annotation = {
      sampleNature: options.sampleNature,
      sourceLabel: options.sourceLabel,
      boundaryNote: options.sampleBoundary.note,
      usableAsLiveSample: options.sampleNature === "clean-live-stream" && options.sampleBoundary.windowWithinCleanRange,
    };
    fs.writeFileSync(`${outputPath}.html`, redactText(buildHtmlReport(report, annotation)), "utf8");
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
    // 样本性质必填；干净区间可选（--clean-start-ms/--clean-end-ms 同时给才生效）。
    sampleNature: cliValue(argv, "--sample-nature") as SampleNature,
    sampleBoundary: {
      cleanRangeMs: argv.includes("--clean-start-ms") && argv.includes("--clean-end-ms")
        ? { startMs: Number(cliValue(argv, "--clean-start-ms")), endMs: Number(cliValue(argv, "--clean-end-ms")) }
        : null,
      note: cliValue(argv, "--sample-note"),
      windowWithinCleanRange: false, // 由 verifyRealWindow 按实际窗口计算后覆盖
    },
    confirmedRealAsr: argv.includes("--confirm-real-asr"),
    frameworkId: argv.includes("--framework-id") ? cliValue(argv, "--framework-id") : undefined,
    frameworkJsonPath: argv.includes("--framework-json") ? cliValue(argv, "--framework-json") : undefined,
    skipLlm: argv.includes("--skip-llm"),
  })).then((result) => {
    console.log(JSON.stringify(result));
    if (result.status !== "success" || !result.allEvidenceValid) process.exitCode = 1;
  }).catch(() => {
    // Never echo provider/network errors or credentials to the console.
    console.error("真实窗口验证未完成；请核对来源参数、安全环境配置及报告状态。");
    process.exitCode = 1;
  });
}
