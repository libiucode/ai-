import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
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
          index: 1,
          slice_type: 0,
          voice_text_str: "大家好",
          start_time: 0,
          end_time: 1000,
        },
      }),
    );
    expect(r.type).toBe("partial");
    expect(r.text).toBe("大家好");
    expect(r.seq).toBe(1);
  });

  it("稳态结果 -> final", () => {
    const r = parseTencentMessage(
      JSON.stringify({
        code: 0,
        voice_id: "v1",
        result: {
          index: 2,
          slice_type: 2,
          voice_text_str: "大家好欢迎来到直播间",
          start_time: 0,
          end_time: 2000,
        },
      }),
    );
    expect(r.type).toBe("final");
    expect(r.text).toBe("大家好欢迎来到直播间");
    expect(r.seq).toBe(2);
  });

  it("重复结果 seq 相同 -> 解析透传由适配器去重", () => {
    const msg = JSON.stringify({
      code: 0,
      result: { index: 3, slice_type: 2, voice_text_str: "测试" },
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

describe("腾讯云真实协议的逐句字幕回归", () => {
  function setup() {
    const adapter = new TencentAsrAdapter();
    const internal = adapter as unknown as {
      connectionId: string;
      handleMessage(raw: string): void;
    };
    internal.connectionId = "connection-1";
    const partials: Array<{ sourceSeq: number; text: string }> = [];
    const finals: Array<{ sourceSeq: number; text: string }> = [];
    adapter.on("partial", (p) => partials.push(p as typeof partials[number]));
    adapter.on("final", (p) => finals.push(p as typeof finals[number]));
    const send = (index: number, sliceType: number, text: string) => internal.handleMessage(JSON.stringify({
      code: 0,
      voice_id: "voice-1",
      result: { index, slice_type: sliceType, voice_text_str: text, start_time: index * 3000, end_time: index * 3000 + 2000 },
    }));
    return { internal, partials, finals, send };
  }

  it("官方示例字段解析出文字、句序号和毫秒时间", () => {
    const result = parseTencentMessage('{"code":0,"message":"success","voice_id":"RnKu9FODFHK5FPpsrN","message_id":"RnKu9FODFHK5FPpsrN_33_0","result":{"slice_type":2,"index":0,"start_time":0,"end_time":2840,"voice_text_str":"实时语音识别","word_size":0,"word_list":[]}}');
    expect(result).toMatchObject({ type: "final", seq: 0, text: "实时语音识别", startMs: 0, endMs: 2840 });
  });

  it("同一句多次更新后仍接收最终字幕，后续句子正常输出", () => {
    const { send, partials, finals } = setup();
    send(0, 0, "实时");
    send(0, 1, "实时语音");
    send(0, 1, "实时语音识别");
    send(0, 2, "实时语音识别");
    send(1, 0, "大家好");
    send(1, 2, "大家好欢迎来到直播间");
    expect(partials.map((p) => p.text)).toEqual(["实时", "实时语音", "实时语音识别", "大家好"]);
    expect(finals).toEqual([
      expect.objectContaining({ sourceSeq: 0, text: "实时语音识别" }),
      expect.objectContaining({ sourceSeq: 1, text: "大家好欢迎来到直播间" }),
    ]);
  });

  it("重复帧、已定稿句子的更新和旧句帧不重复输出", () => {
    const { send, partials, finals } = setup();
    send(0, 1, "测试");
    send(0, 1, "测试");
    send(0, 2, "测试");
    send(0, 2, "测试");
    send(0, 1, "迟到的更新");
    send(2, 1, "新句");
    send(1, 2, "旧句");
    send(2, 2, "新句");
    expect(partials.map((p) => p.text)).toEqual(["测试", "新句"]);
    expect(finals.map((p) => p.text)).toEqual(["测试", "新句"]);
  });

  it("空结果与握手/结束控制帧不产生空字幕，也不阻挡该句后续结果", () => {
    const { internal, send, partials, finals } = setup();
    internal.handleMessage('{"code":0,"message":"success","voice_id":"voice-1"}');
    send(0, 0, "");
    send(0, 1, "有效文字");
    send(0, 2, "有效文字");
    send(1, 2, "   ");
    send(1, 2, "下一句");
    internal.handleMessage('{"code":0,"final":1}');
    expect(partials.map((p) => p.text)).toEqual(["有效文字"]);
    expect(finals.map((p) => p.text)).toEqual(["有效文字", "下一句"]);
  });

  it("没有临时结果时也能直接接收最终字幕", () => {
    const { send, partials, finals } = setup();
    send(0, 2, "直接定稿");
    expect(partials).toEqual([]);
    expect(finals).toEqual([expect.objectContaining({ sourceSeq: 0, text: "直接定稿" })]);
  });
});

describe("腾讯云 ASR 签名（官方 HMAC-SHA1，非 TC3）", () => {
  it("签名 = Base64(HmacSHA1(host+path+排序query, SecretKey))，URL 带 signature 参数", () => {
    const { url } = buildTencentAsrUrl({
      appId: "125922123",
      secretId: "AKIDtest",
      secretKey: "super-secret-key",
      engineModelType: "16k_zh",
      voiceId: "c64385ee-3e5c-4fc5-bbfd-7c71addb35b0",
      sampleRate: 16000,
      audioFormat: 1,
      wordInfoEnabled: 1,
      needvad: 1,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // 规范 URI 含 appid 路径段；不是 TC3 的 authorization 参数
    expect(url.startsWith("wss://asr.cloud.tencent.com/asr/v2/125922123?")).toBe(true);
    expect(url).not.toContain("super-secret-key");
    expect(url).not.toContain("authorization=");
    expect(url).toContain("&signature=");

    // 独立复算：从 URL 取回参数重排，验证 signature 与官方算法一致
    const u = new URL(url);
    const sig = u.searchParams.get("signature");
    expect(sig).toBeTruthy();
    const rest = [...u.searchParams.entries()]
      .filter(([k]) => k !== "signature")
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const expected = crypto
      .createHmac("sha1", "super-secret-key")
      .update(`${u.host}${u.pathname}?${rest}`)
      .digest("base64");
    expect(sig).toBe(expected);
  });

  it("查询参数按字典序排序（服务端按排序结果重算签名，顺序错即鉴权失败）", () => {
    const { url } = buildTencentAsrUrl({
      appId: "125922123",
      secretId: "AKIDtest",
      secretKey: "super-secret-key",
      engineModelType: "16k_zh",
      voiceId: "c64385ee-3e5c-4fc5-bbfd-7c71addb35b0",
      sampleRate: 16000,
      audioFormat: 1,
      wordInfoEnabled: 1,
      needvad: 1,
    });
    const keys = [...new URL(url).searchParams.keys()];
    // 参与签名的参数必须字典序（signature 本身排在最后，不参与排序断言）
    const signed = keys.filter((k) => k !== "signature");
    expect(signed).toEqual([...signed].sort());
    expect(keys[keys.length - 1]).toBe("signature");
  });

  it("hotwordId 非空时进 query；sampleRate 非 16k 时才进 query", () => {
    const base = {
      appId: "125922123",
      secretId: "AKIDtest",
      secretKey: "super-secret-key",
      engineModelType: "16k_zh",
      voiceId: "c64385ee-3e5c-4fc5-bbfd-7c71addb35b0",
      audioFormat: 1,
      wordInfoEnabled: 1,
      needvad: 1,
    };
    const plain = new URL(buildTencentAsrUrl({ ...base, sampleRate: 16000 }).url);
    expect(plain.searchParams.has("hotword_id")).toBe(false);
    expect(plain.searchParams.has("sample_rate")).toBe(false);

    const full = new URL(buildTencentAsrUrl({ ...base, sampleRate: 8000, hotwordId: "abc123" }).url);
    expect(full.searchParams.get("hotword_id")).toBe("abc123");
    expect(full.searchParams.get("sample_rate")).toBe("8000");
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

describe("公开配置与环境凭证读取（useStored 兼容入口）", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "");
    vi.stubEnv("DSH_TENCENT_ASR_APP_ID", "");
    vi.stubEnv("DSH_LLM_BASE_URL", "");
    vi.stubEnv("DSH_LLM_MODEL", "");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stored-cfg-"));
    store = new Store(path.join(dir, "test.db"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("环境 ASR 凭证 + 公开选项组成配置，不读取旧数据库密钥", () => {
    store.setSetting("asr_config", JSON.stringify(validConfig));
    store.setSetting("app_settings", JSON.stringify({ asr: { appId: "1250000000" } }));
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "AKID-unit-env");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "unit-env-key");
    const cfg = readStoredAsrConfig(store);
    expect(cfg?.appId).toBe("1250000000");
    expect(cfg?.secretId).toBe("AKID-unit-env");
    expect(cfg?.secretKey).toBe("unit-env-key");
  });

  it("缺环境凭证时即使旧数据库有密钥也返回 null", () => {
    store.setSetting("asr_config", JSON.stringify(validConfig));
    expect(readStoredAsrConfig(store)).toBeNull();
  });

  it("公开 LLM 配置 + 环境 api_key 组成完整配置", () => {
    store.setSetting("app_settings", JSON.stringify({ llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" } }));
    store.setSetting("llm_api_key", "sk-legacy-ignored");
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "sk-unit-env");
    const cfg = readStoredLlmConfig(store);
    expect(cfg?.base_url).toBe("https://api.example.com/v1");
    expect(cfg?.model).toBe("gpt-4o-mini");
    expect(cfg?.api_key).toBe("sk-unit-env");
  });

  it("缺环境 LLM key 返回 null，不回读数据库", () => {
    store.setSetting("app_settings", JSON.stringify({ llm: { base_url: "https://api.example.com/v1", model: "gpt-4o-mini" } }));
    store.setSetting("llm_api_key", "sk-legacy-ignored");
    expect(readStoredLlmConfig(store)).toBeNull();
  });
});
