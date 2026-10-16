import type { Store } from "../storage/store";
import { AsrConfigSchema, LlmConfigSchema, type AsrConfig, type LlmConfig } from "../../shared/schemas";
import { getCredential } from "./credentialStore";

/**
 * 凭证取值顺序：环境变量 > 界面存的本机密文。
 *
 * 环境变量优先，是给 CI / 自动化 / 多环境切换用的；界面存储是便利选项，
 * 让双击图标启动的普通用户也能配置。两者取其一即可，不必都填。
 */
function credential(
  store: Store,
  key: "TENCENT_ASR_SECRET_ID" | "TENCENT_ASR_SECRET_KEY" | "LLM_API_KEY",
): string {
  const env = process.env[`DSH_SECRET_${key}`];
  if (env && env.trim()) return env;
  return getCredential(store, key);
}

/** Public options may live in SQLite. Credentials are read only from the environment. */
function publicSettings(store: Store): Record<string, unknown> {
  try {
    const raw = store.getSetting("app_settings");
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readRuntimeAsrConfig(store: Store): AsrConfig | null {
  const settings = publicSettings(store);
  const asr = settings.asr && typeof settings.asr === "object"
    ? settings.asr as Record<string, unknown> : {};
  const parsed = AsrConfigSchema.safeParse({
    provider: "tencent",
    appId: process.env.DSH_TENCENT_ASR_APP_ID || asr.appId || "1502622498",
    secretId: credential(store, "TENCENT_ASR_SECRET_ID"),
    secretKey: credential(store, "TENCENT_ASR_SECRET_KEY"),
    engineModelType: asr.engineModelType ?? "16k_zh",
    sampleRate: 16000,
    audioFormat: 1,
    wordInfoEnabled: asr.wordInfoEnabled ?? 1,
    needvad: asr.needvad ?? 1,
    hotwordId: asr.hotwordId,
  });
  return parsed.success ? parsed.data : null;
}

export function readRuntimeLlmConfig(store: Store): LlmConfig | null {
  const settings = publicSettings(store);
  const llm = settings.llm && typeof settings.llm === "object"
    ? settings.llm as Record<string, unknown> : {};
  const parsed = LlmConfigSchema.safeParse({
    ...llm,
    base_url: process.env.DSH_LLM_BASE_URL || llm.base_url,
    model: process.env.DSH_LLM_MODEL || llm.model,
    api_key: credential(store, "LLM_API_KEY"),
    // 不要在这里给 request_timeout_ms 兜底：显式传值会盖掉 LlmConfigSchema 的默认值
    // （150 秒），未配置超时的用户会退回 20 秒，导致真实 LLM 分析（约 65~100 秒）
    // 全部超时被丢弃。缺省留给 schema 决定。
    ...(llm.request_timeout_ms === undefined ? {} : { request_timeout_ms: llm.request_timeout_ms }),
  });
  return parsed.success ? parsed.data : null;
}

/** Keep legacy records intact, but never return or write their credential fields. */
export function withoutCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutCredentials) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(secret_?id|secret_?key|api_?key|authorization|token)$/i.test(key)) continue;
    out[key] = withoutCredentials(child);
  }
  return out as T;
}

export interface ConfigDiagnosis {
  ready: boolean;
  /** 公开配置（用户可在界面填写）是否齐全 */
  publicConfigPresent: boolean;
  /** 环境变量里的密钥是否存在 */
  credentialPresent: boolean;
  /** 给用户看的可执行说明，指出真正缺什么、去哪里补 */
  message: string;
}

/**
 * 诊断 ASR 配置缺失的真实原因。界面据此给出可执行指引，
 * 而不是笼统报「未配置」把用户引向不存在的输入框。
 */
export function diagnoseAsrConfig(store: Store): ConfigDiagnosis {
  const settings = publicSettings(store);
  const asr = settings.asr && typeof settings.asr === "object"
    ? settings.asr as Record<string, unknown> : {};
  const credentialPresent = Boolean(
    credential(store, "TENCENT_ASR_SECRET_ID") && credential(store, "TENCENT_ASR_SECRET_KEY"),
  );
  const publicConfigPresent = Boolean(process.env.DSH_TENCENT_ASR_APP_ID || asr.appId || "1502622498");
  if (credentialPresent) {
    return { ready: true, publicConfigPresent, credentialPresent, message: "ASR 环境凭证已就绪。" };
  }
  return {
    ready: false,
    publicConfigPresent,
    credentialPresent,
    message:
      "缺少 ASR 凭证：可在下方输入框填写并保存（加密存本机），" +
      "或在启动环境里提供 DSH_SECRET_TENCENT_ASR_SECRET_ID 与 DSH_SECRET_TENCENT_ASR_SECRET_KEY。" +
      "环境变量优先级更高，两者取其一即可。",
  };
}

/** 诊断 LLM 配置缺失的真实原因（同上，分开标注公开配置与环境密钥）。 */
export function diagnoseLlmConfig(store: Store): ConfigDiagnosis {
  const settings = publicSettings(store);
  const llm = settings.llm && typeof settings.llm === "object"
    ? settings.llm as Record<string, unknown> : {};
  const baseUrl = process.env.DSH_LLM_BASE_URL || llm.base_url;
  const model = process.env.DSH_LLM_MODEL || llm.model;
  const credentialPresent = Boolean(credential(store, "LLM_API_KEY"));
  const publicConfigPresent = Boolean(baseUrl && model);
  if (credentialPresent && publicConfigPresent) {
    return { ready: true, publicConfigPresent, credentialPresent, message: "LLM 配置已就绪。" };
  }
  if (!publicConfigPresent && !credentialPresent) {
    return {
      ready: false,
      publicConfigPresent,
      credentialPresent,
      message:
        "LLM 未配置：缺少 Base URL 与模型名（可在本页填写并保存），同时也缺少环境变量 DSH_SECRET_LLM_API_KEY。",
    };
  }
  if (!publicConfigPresent) {
    return {
      ready: false,
      publicConfigPresent,
      credentialPresent,
      message: "缺少 Base URL 或模型名：请在本页填写后点「保存全部设置」。",
    };
  }
  return {
    ready: false,
    publicConfigPresent,
    credentialPresent,
    message:
      "Base URL 与模型名已保存，但缺少 LLM API Key。" +
      "可在下方输入框填写并保存（加密存本机），或提供环境变量 DSH_SECRET_LLM_API_KEY。" +
      "环境变量优先级更高，两者取其一即可。",
  };
}
