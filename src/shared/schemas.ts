import { z } from "zod";

export const AudioDeviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["microphone", "systemLoopback"]),
  isDefault: z.boolean(),
});
export type AudioDevice = z.infer<typeof AudioDeviceSchema>;

export const AppErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});

export const TranscriptSegmentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  connectionId: z.string(),
  sourceSeq: z.number().int(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  isFinal: z.boolean(),
  createdAt: z.string(),
});

export const IssueSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  analysisRunId: z.string(),
  type: z.enum([
    "bannedWord",
    "absolutization",
    "unverifiedClaim",
    "repetition",
    "pace",
    "silence",
    "frameworkStep",
    "other",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  segmentIds: z.array(z.string()),
  quote: z.string().min(1),
  basis: z.string().min(1),
  recommendation: z.string().min(1),
  suggestedScript: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  status: z.enum(["open", "acknowledged", "dismissed"]),
});

export const LlmIssueSchema = z.object({
  type: z.enum([
    "bannedWord",
    "absolutization",
    "unverifiedClaim",
    "repetition",
    "pace",
    "silence",
    "frameworkStep",
    "other",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  segmentIds: z.array(z.string()).min(1),
  quote: z.string().min(1),
  basis: z.string().min(1),
  recommendation: z.string().min(1),
  suggestedScript: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
});

export const LlmAnalysisResultSchema = z.object({
  issues: z.array(LlmIssueSchema),
  frameworkStateSummary: z.string().optional(),
});
export type LlmAnalysisResult = z.infer<typeof LlmAnalysisResultSchema>;

export const AsrConfigSchema = z.object({
  provider: z.literal("tencent"),
  secretId: z.string().min(1),
  secretKey: z.string().min(1),
  appId: z.string().min(1),
  engineModelType: z.string().default("16k_zh"),
  sampleRate: z.literal(16000).default(16000),
  audioFormat: z.literal(1).default(1),
  wordInfoEnabled: z.number().default(1),
  needvad: z.number().default(1),
  hotwordId: z.string().optional(),
});
export type AsrConfig = z.infer<typeof AsrConfigSchema>;

export const LlmConfigSchema = z.object({
  base_url: z.string().url(),
  model: z.string().min(1),
  api_key: z.string().min(1),
  // 默认 150 秒：必须覆盖「一次调用约 65s + 一次修复约 65s = 130s」，
  // 120 秒会在修复路径失败。硬上限 180 秒见 analysis/llmClient.ts。
  // 决策记录（2026-10-14，盯播负责人）：方案第 7 节的 20 秒对真实推理型模型不可用。
  request_timeout_ms: z.number().int().positive().default(150000),
  max_retries: z.number().int().nonnegative().default(1),
  budget_limit: z.number().nonnegative().default(10),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** "HH:mm" 24 小时制，本地时间。 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ScheduleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  startTime: z.string().regex(HHMM, "开始时间需为 HH:mm（24 小时制）"),
  endTime: z.string().regex(HHMM, "结束时间需为 HH:mm（24 小时制）"),
  /** 0=周日 … 6=周六；空数组表示每天。 */
  weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  audioSource: z.enum(["microphone", "systemLoopback"]).default("systemLoopback"),
  frameworkId: z.string().nullable().default(null),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

export const SettingsSchema = z.object({
  llm: LlmConfigSchema.partial({ api_key: true }).optional(),
  // ASR credentials are accepted here for the settings page save, then routed
  // to the dedicated asr_config storage key and stripped from app_settings.
  asr: AsrConfigSchema.optional(),
  windowIntervalSec: z.union([
    z.literal(30),
    z.literal(60),
    z.literal(120),
  ]).default(60),
  windowSizeSec: z.union([
    z.literal(180),
    z.literal(300),
    z.literal(600),
  ]).default(300),
  paceThreshold: z.number().optional(),
  silenceThresholdMs: z.number().optional(),
  schedule: ScheduleConfigSchema.optional(),
  /**
   * 上次选择的麦克风 deviceId。
   * null = 用系统默认设备（用户主动选了「默认麦克风」）。空串不允许——见 contracts 里的说明。
   */
  audioDeviceId: z.string().nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const StartSessionConfigSchema = z.object({
  audioSource: z.enum(["microphone", "systemLoopback"]),
  deviceId: z.string().nullable().optional(),
  windowIntervalSec: z.number().optional(),
  windowSizeSec: z.number().optional(),
  /** 本场会话使用的话术框架 id。缺省或匹配不到时回退到第一个框架。 */
  frameworkId: z.string().nullable().optional(),
  /** 主播稳定标识；用于同一主播跨场对比，改名不影响聚合。 */
  speakerId: z.string().nullable().optional(),
  /** 主播当次显示名快照；历史报告保留当时的名字（有意的可追溯性）。 */
  speakerName: z.string().nullable().optional(),
});
export type StartSessionConfig = z.infer<typeof StartSessionConfigSchema>;

/**
 * 报告导出格式。
 *
 * 历史遗留："markdown" 这个名字是错的——该分支实际调用 buildHtmlReport()，
 * 产出 .html 文件，从来不生成 Markdown。名字与实际行为不符比没有契约更糟，
 * 故改名为 "html"。
 *
 * 兼容读取：改名前的调用方可能仍在传 "markdown"，这里统一归一化为 "html"，
 * 避免它们静默走到回退分支（拿不到报告却看不出为什么）。写出时只会是 html/json。
 */
export const ReportFormatSchema = z
  .enum(["html", "json", "markdown"])
  .transform((v): "html" | "json" => (v === "markdown" ? "html" : v));

export const IpcChannels = {
  sessionStart: "session.start",
  sessionPause: "session.pause",
  sessionResume: "session.resume",
  sessionStop: "session.stop",
  sessionList: "session.list",
  sessionDetail: "session.detail",
  sessionDelete: "session.delete",
  captureListDevices: "capture.listDevices",
  captureSelectDevice: "capture.selectDevice",
  captureAudioChunk: "capture.audioChunk",
  captureStatus: "capture.status",
  asrStatus: "asr.status",
  asrTestConnection: "asr.testConnection",
  llmTestConnection: "llm.testConnection",
  transcriptPartial: "transcript.partial",
  transcriptFinal: "transcript.final",
  analysisStatus: "analysis.status",
  analysisIssues: "analysis.issues",
  scriptStatus: "script.status",
  scheduleStatus: "schedule.status",
  frameworkList: "framework.list",
  frameworkSave: "framework.save",
  settingsGet: "settings.get",
  settingsSave: "settings.save",
  reportExport: "report.export",
  reportGenerate: "report.generate",
  appError: "app.error",
} as const;

/** Zod schema for the full framework payload saved from the script config page. */
export const FrameworkStepSchema = z.object({
  id: z.string(),
  frameworkId: z.string(),
  name: z.string().min(1),
  priority: z.number().int().min(0).max(2),
  maxWaitMs: z.number().int().nonnegative(),
});

export const FrameworkRuleConfigSchema = z.object({
  id: z.string(),
  frameworkId: z.string(),
  stepId: z.string().nullable(),
  ruleType: z.enum(["bannedWord", "absolutization", "unverifiedClaim", "repetition", "hotWord"]),
  pattern: z.string().min(1),
  enabled: z.boolean(),
});

export const FrameworkSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  steps: z.array(FrameworkStepSchema),
  rules: z.array(FrameworkRuleConfigSchema),
  productFacts: z.string(),
  updatedAt: z.string(),
});
