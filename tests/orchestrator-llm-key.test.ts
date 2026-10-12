import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { LlmClient } from "../src/main/analysis/llmClient";
import { Store } from "../src/main/storage/store";

afterEach(() => {
  vi.restoreAllMocks();
});

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  return new Store(path.join(dir, "test.db"));
}

/**
 * 回归防护：ipc.ts 保存设置时会把 llm.api_key 剥离到独立的 llm_api_key 键，
 * 历史上 orchestrator 直接用 settings.llm 配置 LLM，导致 Zod 校验永远失败、
 * 分析静默禁用。orchestrator.start() 必须从 llm_api_key 回接后再 configure。
 */
describe("orchestrator LLM 密钥回接", () => {
  it("启动会话时从 llm_api_key 独立键回接 api_key", async () => {
    const store = tempStore();
    store.setSetting(
      "app_settings",
      JSON.stringify({
        llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" },
      }),
    );
    store.setSetting("llm_api_key", "sk-regression-key-001");

    const configureSpy = vi.spyOn(LlmClient.prototype, "configure");
    const orch = new SessionOrchestrator(store);
    const result = await orch.start({ audioSource: "microphone" });
    expect(result.error).toBeNull();

    expect(configureSpy).toHaveBeenCalledTimes(1);
    expect(configureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        base_url: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        api_key: "sk-regression-key-001",
      }),
    );
    await orch.stop();
  });

  it("没有 llm_api_key 时回接空 key，配置失败被吞掉、分析保持禁用", async () => {
    const store = tempStore();
    store.setSetting(
      "app_settings",
      JSON.stringify({
        llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" },
      }),
    );

    const configureSpy = vi.spyOn(LlmClient.prototype, "configure");
    const orch = new SessionOrchestrator(store);
    const result = await orch.start({ audioSource: "microphone" });
    expect(result.error).toBeNull();

    // api_key 有 min(1) 约束：空 key 通不过 Zod，configure 抛错被 orchestrator 捕获，
    // LLM 保持未配置——不允许把空 key 当成"已配置"蒙混过关
    expect(configureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: "" }),
    );
    await orch.stop();
  });
});
