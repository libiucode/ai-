#!/usr/bin/env node
/**
 * 腾讯云实时 ASR 连通探针（本地验证用，不部署）。
 *
 * 输入为本地合成多频正弦波，不是人声、更不是直播音频。
 * 仅验证鉴权、PCM上传、服务端响应和结束过程；空文本或1006异常关闭
 * 不代表语音识别、实时字幕或真实直播采集验收通过。
 *
 * 密钥只从环境变量读，绝不落盘、绝不打印：
 *   $DSH_SECRET_TENCENT_ASR_SECRET_ID
 *   $DSH_SECRET_TENCENT_ASR_SECRET_KEY
 *
 * 用法（在 app 目录下）：
 *   node scripts/tencent-live-probe.js
 */
const path = require("node:path");
const WebSocket = require("ws");
const { buildTencentAsrUrl } = require(
  path.join(__dirname, "..", "dist", "main", "main", "asr", "tencentSign.js"),
);

const SECRET_ID = process.env.DSH_SECRET_TENCENT_ASR_SECRET_ID;
const SECRET_KEY = process.env.DSH_SECRET_TENCENT_ASR_SECRET_KEY;
const APP_ID = "1502622498";

if (!SECRET_ID || !SECRET_KEY) {
  console.error("[probe] 缺少环境变量 DSH_SECRET_TENCENT_ASR_SECRET_ID / _SECRET_KEY");
  process.exit(2);
}

const SAMPLE_RATE = 16000;
const CHUNK_MS = 200; // 官方建议约 200ms 一包
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000;

/** 生成一段时长秒的中文语音能量分布的 PCM16（本地合成，用于鉴权+连通性验证）。 */
function makeTonePcm(seconds) {
  const total = Math.floor(SAMPLE_RATE * seconds);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    // 多基频叠加 + 缓慢包络，模拟语音能量起伏，避免纯正弦被 VAD 判静音
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    const v =
      Math.sin(2 * Math.PI * 180 * t) * 0.4 +
      Math.sin(2 * Math.PI * 380 * t) * 0.3 +
      Math.sin(2 * Math.PI * 700 * t) * 0.2;
    const s = Math.max(-1, Math.min(1, v * env));
    buf.writeInt16LE(Math.round(s * 12000), i * 2);
  }
  return buf;
}

function main() {
  const voiceId = `probe_${Date.now()}`;
  const { url } = buildTencentAsrUrl({
    appId: APP_ID,
    secretId: SECRET_ID,
    secretKey: SECRET_KEY,
    engineModelType: "16k_zh",
    voiceId,
    sampleRate: SAMPLE_RATE,
    audioFormat: 1, // PCM
    wordInfoEnabled: 0,
    needvad: 1,
  });

  console.log(`[probe] appid=${APP_ID} voice_id=${voiceId}`);
  console.log("[probe] 连接腾讯云实时 ASR WebSocket …");

  const ws = new WebSocket(url);
  const t0 = Date.now();
  let openMs = 0;
  let partial = 0;
  let final = 0;
  const finals = [];
  let firstTextMs = 0;

  ws.on("open", () => {
    openMs = Date.now() - t0;
    console.log(`[probe] 已连接，握手耗时 ${openMs} ms（鉴权通过）`);
    const pcm = makeTonePcm(12);
    let offset = 0;
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (offset >= pcm.length) {
        clearInterval(timer);
        // 官方要求发送结束帧；frame 为空串表示音频发送完毕
        ws.send(JSON.stringify({ type: "end" }));
        console.log("[probe] 音频发送完毕，已发结束帧");
        return;
      }
      const chunk = pcm.subarray(offset, offset + SAMPLES_PER_CHUNK * 2);
      offset += chunk.length;
      ws.send(chunk);
    }, CHUNK_MS);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.code !== 0) {
      console.error(`[probe] 服务端错误 code=${msg.code} message=${msg.message}`);
      ws.close();
      return;
    }
    const r = msg.result;
    if (!r) return;
    if (r.slice_type === 2) {
      final++;
      finals.push({
        index: r.index,
        text: r.voice_text_str,
        startMs: r.start_time,
        endMs: r.end_time,
      });
      if (!firstTextMs) firstTextMs = Date.now() - t0;
      console.log(
        `[probe] 稳态 #${r.index} [${r.start_time}ms→${r.end_time}ms] ${r.voice_text_str}`,
      );
    } else if (r.slice_type === 1) {
      partial++;
    }
  });

  ws.on("error", (err) => {
    console.error(`[probe] WebSocket 错误: ${err.message}`);
    process.exitCode = 1;
  });

  ws.on("close", (code, reason) => {
    const total = Date.now() - t0;
    console.log("────────── 结果 ──────────");
    console.log(`握手耗时       : ${openMs} ms`);
    console.log(`首次稳态文本   : ${firstTextMs ? firstTextMs + " ms" : "未收到"}`);
    console.log(`总耗时         : ${total} ms`);
    console.log(`临时结果帧     : ${partial}`);
    console.log(`稳态结果条数   : ${final}`);
    console.log(`稳态文本       : ${finals.map((f) => f.text).join(" | ") || "(空)"}`);
    console.log(`close code=${code} reason=${reason.toString() || "(无)"}`);
    console.log("──────────────────────────");
    process.exit(process.exitCode ?? 0);
  });

  // 兜底超时
  setTimeout(() => {
    console.error("[probe] 超时未完成，强制结束");
    process.exit(3);
  }, 60000).unref();
}

main();
