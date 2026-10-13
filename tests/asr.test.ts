import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseTencentMessage, TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { buildTencentAsrUrl } from "../src/main/asr/tencentSign";
import { AsrConfigSchema } from "../src/shared/schemas";
import { makeError } from "../src/main/security/errorFactory";
import { readStoredAsrConfig, readStoredLlmConfig } from "../src/main/ipc";
import { Store } from "../src/main/storage/store";

const validConfig = AsrConfigSchema.parse({
  provider: "tencent",
  appId: "1250000000",
  secretId: "AKIDtest",
  secretKey: "test-secret",
});

describe("腾讯云 ASR 消息解析 fixture", () => {
  it("中间结果变更 -> partial", () => {
    const r = parseTencentMessage(
      JSON.stringify({
        code: 0,
        message: "success",
        voice_id: "v1",
        audio_duration: 1000,
        result: {
          slice_seq: 1,
          slice_type: 0,
          result_text: "大家好",
          start_time: 0,
          end_time: 1000,
        },
      }),
    );
    expect(r.type).toBe("partial");
    expect(r.text).toBe("大家好");
    // 中间结果变更（同 seq 不同文本也由 seq 去重逻辑控制，解析本身透传）
  });

  it("稳态结果 -> final", () => {
    const r = parseTencentMessage(
      JSON.stringify({
        code: 0,
        voice_id: "v1",
        result: {
          slice_seq: 2,
          slice_type: 2,
          result_text: "大家好欢迎来到直播间",
          start_time: 0,
          end_time: 2000,
        },
      }),
    );
    expect(r.type).toBe("final");
    expect(r.text).toBe("大家好欢迎来到直播间");
  });

  it("重复结果 seq 相同 -> 解析透传由适配器去重", () => {
    const msg = JSON.stringify({
      code: 0,
      result: { slice_seq: 3, slice_type: 2, result_text: "测试" },
    });
    expect(parseTencentMessage(msg).seq).toBe(parseTencentMessage(msg).seq);
  });

  it("错误结果 -> error with code", () => {
    const r = parseTencentMessage(JSON.stringify({ code: 4001, message: "auth failed" }));
    expect(r.type).toBe("error");
    expect(r.code).toBe(4001);
  });

  it("断线/坏 JSON -> ignore", () => {
    expect(parseTencentMessage("not-json").type).toBe("ignore");
  });
});

describe("腾讯云 ASR 签名", () => {
  it("生成 wss url 且不含明文 secretKey", () => {
    const { url } = buildTencentAsrUrl({
      appId: "125000000",
      secretId: "AKIDtest",
      secretKey: "super-secret-key",
      engineModelType: "16k_zh",
      voiceId: "voice-123",
      sampleRate: 16000,
      audioFormat: 1,
      wordInfoEnabled: 1,
      needvad: 1,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(url.startsWith("wss://asr.cloud.tencent.com/asr/v2/125000000?")).toBe(true);
    expect(url).not.toContain("super-secret-key");
    expect(url).toContain("authorization=");
  });
});

/**
 * 连接探测：修复“只等 WebSocket open 就把错误密钥误报为连接成功”。
 * 实测（2026-10-13，假密钥）：open 后约 2ms 服务端发 code 4002 鉴权失败帧并关闭。
 * 下面用白盒方式驱动适配器内部事件，不依赖真实网络。
 */
describe("ASR 连接探测 probe（open 后等服务端裁决）", () => {
  function stubConnect(adapter: TencentAsrAdapter, impl: () => Promise<void>) {
    (adapter as unknown as { connect: () => Promise<void> }).connect = impl;
  }
  function emit(adapter: TencentAsrAdapter, event: string, payload: unknown) {
    (adapter as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
  }

  it("open 后服务端错误帧 → 失败并透传服务端错误（不再误报成功）", async () => {
    const adapter = new TencentAsrAdapter();
    stubConnect(adapter, async () => {
      emit(adapter, "error", { error: makeError("ASR_REMOTE_4002", "鉴权失败", false) });
    });
    const r = await adapter.probe(validConfig, 30);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ASR_REMOTE_4002");
  });

  it("open 后窗口内静默 → 成功", async () => {
    const adapter = new TencentAsrAdapter();
    stubConnect(adapter, async () => {});
    const r = await adapter.probe(validConfig, 30);
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
  });

  it("open 后服务端关闭 → 失败（ASR_WS_CLOSED）", async () => {
    const adapter = new TencentAsrAdapter();
    stubConnect(adapter, async () => {
      setTimeout(() => emit(adapter, "status", { state: "closed" }), 5);
    });
    const r = await adapter.probe(validConfig, 80);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ASR_WS_CLOSED");
  });

  it("connect 本身失败（网络不可达等）→ 失败且透传错误", async () => {
    const adapter = new TencentAsrAdapter();
    stubConnect(adapter, async () => {
      throw makeError("ASR_WS_ERROR", "网络不可达", true);
    });
    const r = await adapter.probe(validConfig, 30);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ASR_WS_ERROR");
  });
});

describe("已保存配置读取（测试连接的 useStored 路径）", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stored-cfg-"));
    store = new Store(path.join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("asr_config 存在 → 解析回配置", () => {
    store.setSetting("asr_config", JSON.stringify(validConfig));
    expect(readStoredAsrConfig(store)?.appId).toBe("1250000000");
  });

  it("asr_config 缺失或损坏 → null", () => {
    expect(readStoredAsrConfig(store)).toBeNull();
    store.setSetting("asr_config", "not-json");
    expect(readStoredAsrConfig(store)).toBeNull();
  });

  it("llm 配置 + api_key 齐全 → 回接出完整配置", () => {
    store.setSetting(
      "app_settings",
      JSON.stringify({ llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" } }),
    );
    store.setSetting("llm_api_key", "sk-test-123");
    const cfg = readStoredLlmConfig(store);
    expect(cfg?.base_url).toBe("https://api.example.com/v1");
    expect(cfg?.model).toBe("gpt-4o-mini");
    expect(cfg?.api_key).toBe("sk-test-123");
  });

  it("缺 api_key → null（不允许把空 key 当作已配置）", () => {
    store.setSetting(
      "app_settings",
      JSON.stringify({ llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" } }),
    );
    expect(readStoredLlmConfig(store)).toBeNull();
  });
});
