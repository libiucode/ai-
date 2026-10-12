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
  request_timeout_ms: z.number().int().positive().default(30000),
  max_retries: z.number().int().nonnegative().default(1),
  budget_limit: z.number().nonnegative().default(10),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const SettingsSchema = z.object({
  llm: LlmConfigSchema.partial({ api_key: true }).optional(),
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
});
export type Settings = z.infer<typeof SettingsSchema>;

export const StartSessionConfigSchema = z.object({
  audioSource: z.enum(["microphone", "systemLoopback"]),
  deviceId: z.string().nullable().optional(),
  windowIntervalSec: z.number().optional(),
  windowSizeSec: z.number().optional(),
});
export type StartSessionConfig = z.infer<typeof StartSessionConfigSchema>;

export const ReportFormatSchema = z.enum(["markdown", "json"]);

export const IpcChannels = {
  sessionStart: "session.start",
  sessionPause: "session.pause",
  sessionStop: "session.stop",
  captureListDevices: "capture.listDevices",
  captureSelectDevice: "capture.selectDevice",
  captureStatus: "capture.status",
  asrStatus: "asr.status",
  transcriptPartial: "transcript.partial",
  transcriptFinal: "transcript.final",
  analysisStatus: "analysis.status",
  analysisIssues: "analysis.issues",
  frameworkList: "framework.list",
  frameworkSave: "framework.save",
  settingsGet: "settings.get",
  settingsSave: "settings.save",
  reportExport: "report.export",
  appError: "app.error",
} as const;
