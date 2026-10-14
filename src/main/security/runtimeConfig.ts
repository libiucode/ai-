import type { Store } from "../storage/store";
import { AsrConfigSchema, LlmConfigSchema, type AsrConfig, type LlmConfig } from "../../shared/schemas";

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
    secretId: process.env.DSH_SECRET_TENCENT_ASR_SECRET_ID ?? "",
    secretKey: process.env.DSH_SECRET_TENCENT_ASR_SECRET_KEY ?? "",
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
    api_key: process.env.DSH_SECRET_LLM_API_KEY ?? "",
    request_timeout_ms: llm.request_timeout_ms ?? 20000,
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
