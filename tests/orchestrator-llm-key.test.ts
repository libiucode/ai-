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

/**
 * 回归防护（2026-10-14 用户实测）：start() 曾 await ASR WS 连接，今早腾讯云
 * 连接挂起（不 open 不报错）→ 会话卡在"启动中"假死、调度器/计时器从未创建、
 * 2 分 10 秒零条转写零次分析。ASR 连接必须非阻塞。
 */
describe("orchestrator 会话启动不被 ASR 连接阻塞", () => {
  it("ASR 连接挂起时 start() 仍立即返回，调度器与计时器就位", async () => {
    const store = tempStore();
    store.setSetting(
      "asr_config",
      JSON.stringify({ provider: "tencent", appId: "1250000000", secretId: "AKIDx", secretKey: "sk-x" }),
    );
    const orch = new SessionOrchestrator(store);
    // 白盒：connect 永不 settle，模拟 WS 握手挂起
    (orch as unknown as { asr: { connect: () => Promise<void> } }).asr.connect =
      () => new Promise<void>(() => {});
    const result = await orch.start({ audioSource: "microphone" });
    expect(result.error).toBeNull();
    const internals = orch as unknown as { scheduler: unknown; tickTimer: unknown };
    // 修复前这两个在 await 卡死时永远是 null
    expect(internals.scheduler).not.toBeNull();
    expect(internals.tickTimer).not.toBeNull();
    await orch.stop();
  });
});

/**
 * 回归防护（2026-10-14 用户实测）：暂停只翻主进程状态、渲染层采集不停 →
 * ASR 15 秒无音频被服务端掐断（4008）+ 满屏重连警告；且「继续」按钮只改 UI、
 * 没有 resume IPC，主进程永远停在 paused。修复：暂停断 ASR、恢复重连。
 */
describe("orchestrator 暂停/恢复", () => {
  it("暂停断开 ASR 并落库 paused；恢复重连 ASR 并回到 active", async () => {
    const store = tempStore();
    store.setSetting(
      "asr_config",
      JSON.stringify({ provider: "tencent", appId: "1250000000", secretId: "AKIDx", secretKey: "sk-x" }),
    );
    const orch = new SessionOrchestrator(store);
    let connectCalls = 0;
    // 白盒：connect 计数但不真连（避免测试依赖网络）
    (orch as unknown as { asr: { connect: () => Promise<void> } }).asr.connect =
      () => { connectCalls++; return new Promise<void>(() => {}); };

    await orch.start({ audioSource: "microphone" });
    expect(connectCalls).toBe(1); // 启动时非阻塞连一次

    await orch.pause();
    const internals = orch as unknown as { status: string; asr: { shouldRun: boolean } };
    expect(internals.status).toBe("paused");
    // 暂停后 ASR 必须已断开（shouldRun=false）——否则被服务端 4008 饿死
    expect(internals.asr.shouldRun).toBe(false);

    await orch.resume();
    expect(internals.status).toBe("active");
    expect(connectCalls).toBe(2); // 恢复时重连

    const row = store.getSession((orch as unknown as { sessionId: string }).sessionId)!;
    expect(row.status).toBe("active");
    await orch.stop();
  });
});
