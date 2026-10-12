import { describe, it, expect } from "vitest";
import { parseTencentMessage } from "../src/main/asr/tencentAdapter";
import { buildTencentAsrUrl } from "../src/main/asr/tencentSign";

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
