import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { LlmClient } from "../src/main/analysis/llmClient";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";

const stores: Array<{ store: Store; dir: string }> = [];
const sessions: SessionOrchestrator[] = [];

beforeEach(() => {
  for (const key of ["DSH_SECRET_LLM_API_KEY", "DSH_LLM_BASE_URL", "DSH_LLM_MODEL", "DSH_SECRET_TENCENT_ASR_SECRET_ID", "DSH_SECRET_TENCENT_ASR_SECRET_KEY", "DSH_TENCENT_ASR_APP_ID"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  for (const orch of sessions.splice(0)) await orch.stop();
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-env-"));
  const store = new Store(path.join(dir, "test.db"));
  stores.push({ store, dir });
  return store;
}

function orchestrator(store: Store): SessionOrchestrator {
  const orch = new SessionOrchestrator(store);
  sessions.push(orch);
  return orch;
}

function llmOptions(store: Store) {
  store.setSetting("app_settings", JSON.stringify({
    llm: { base_url: "https://api.example.com/v1", model: "unit-model" },
  }));
}

function asrEnvironment() {
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "AKID-unit-env");
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "unit-env-key");
}

describe("orchestrator 环境凭证", () => {
  it("公开LLM配置回接环境密钥，忽略数据库旧密钥且不写新密钥", async () => {
    const store = tempStore();
    llmOptions(store);
    store.setSetting("llm_api_key", "legacy-unit-key");
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "env-unit-key");
    const spy = vi.spyOn(LlmClient.prototype, "configure");
    const result = await orchestrator(store).start({ audioSource: "microphone" });
    expect(result.error).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      base_url: "https://api.example.com/v1", model: "unit-model", api_key: "env-unit-key",
    }));
    expect(store.getSetting("llm_api_key")).toBe("legacy-unit-key");
    expect(store.getSetting("app_settings")).not.toContain("env-unit-key");
  });

  it("环境密钥缺失时不得使用数据库旧密钥启用LLM", async () => {
    const store = tempStore();
    llmOptions(store);
    store.setSetting("llm_api_key", "legacy-unit-key");
    const spy = vi.spyOn(LlmClient.prototype, "configure");
    expect((await orchestrator(store).start({ audioSource: "microphone" })).error).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("orchestrator 非阻塞ASR与暂停恢复", () => {
  it("ASR握手挂起仍立即启动计时器及调度器，凭证不落盘", async () => {
    const store = tempStore();
    asrEnvironment();
    const spy = vi.spyOn(TencentAsrAdapter.prototype, "connect").mockImplementation(() => new Promise<void>(() => {}));
    const orch = orchestrator(store);
    expect((await orch.start({ audioSource: "microphone" })).error).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ secretId: "AKID-unit-env" }));
    const internals = orch as unknown as { scheduler: unknown; tickTimer: unknown };
    expect(internals.scheduler).not.toBeNull();
    expect(internals.tickTimer).not.toBeNull();
    expect(store.getSetting("asr_config")).toBeNull();
  });

  it("暂停断开ASR，恢复从环境重连并恢复active状态", async () => {
    const store = tempStore();
    asrEnvironment();
    const connect = vi.spyOn(TencentAsrAdapter.prototype, "connect").mockImplementation(() => new Promise<void>(() => {}));
    const stop = vi.spyOn(TencentAsrAdapter.prototype, "stop");
    const orch = orchestrator(store);
    const result = await orch.start({ audioSource: "microphone" });
    expect(connect).toHaveBeenCalledTimes(1);
    await orch.pause();
    expect(stop).toHaveBeenCalled();
    expect(store.getSession(result.sessionId)?.status).toBe("paused");
    await orch.resume();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(store.getSession(result.sessionId)?.status).toBe("active");
    expect(store.getSetting("asr_config")).toBeNull();
  });
});
