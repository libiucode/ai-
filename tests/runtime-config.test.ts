import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage/store";
import { registerIpc } from "../src/main/ipc";
import type { SessionOrchestrator } from "../src/main/analysis/orchestrator";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
  BrowserWindow: {}, dialog: {}, app: {},
}));

let dir: string;
let store: Store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-env-"));
  store = new Store(path.join(dir, "test.db"));
  handlers.clear();
  registerIpc(store, {} as SessionOrchestrator);
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("设置IPC不得持久化或回显密钥", () => {
  it("settings.save仅存公开配置，ASR/LLM密钥及旧专用key都不写", async () => {
    const saved = await handlers.get("settings.save")!({}, {
      asr: { provider: "tencent", appId: "1502622498", secretId: "AKID-fixture-secret", secretKey: "fixture-secret" },
      llm: { base_url: "https://example.test/v1", model: "unit", api_key: "fixture-llm-secret" },
      windowIntervalSec: 60, windowSizeSec: 300,
    });
    expect(saved).toBe(true);
    const raw = store.getSetting("app_settings")!;
    expect(raw).toContain("1502622498");
    expect(raw).toContain("example.test/v1");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("api_key");
    expect(store.getSetting("asr_config")).toBeNull();
    expect(store.getSetting("llm_api_key")).toBeNull();
  });

  it("settings.get遇到历史明文配置时不把凭证返给renderer", async () => {
    store.setSetting("app_settings", JSON.stringify({
      llm: { base_url: "https://example.test/v1", model: "unit", api_key: "old-fixture-llm" },
      asr: { appId: "1502622498", secretId: "old-fixture-id", secretKey: "old-fixture-key" },
    }));
    const result = await handlers.get("settings.get")!({});
    const text = JSON.stringify(result);
    expect(text).not.toContain("old-fixture");
    expect(text).not.toContain("secretKey");
    expect(text).not.toContain("api_key");
    expect(text).toContain("example.test/v1");
  });
});
