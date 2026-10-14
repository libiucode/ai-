import crypto from "node:crypto";

/**
 * 腾讯云实时语音识别 WebSocket 鉴权签名。
 *
 * 官方算法（云 API 文档 product/1093/48982「signature 签名生成」）：
 *   1. 除 signature 外的所有参数按字典序排序，拼成签名原文：
 *      `asr.cloud.tencent.com/asr/v2/<appid>?<排序后的 query>`
 *   2. 用 SecretKey 对签名原文做 HMAC-SHA1，取 base64
 *   3. signature urlencode 后作为 signature 参数拼到 URL 上
 *
 * 注意：本接口用的是**旧版 HMAC-SHA1 签名**，不是云 API 3.0 的
 * TC3-HMAC-SHA256（那套用 authorization 头）。2026-10-13 修复：此前实现成了
 * TC3，导致任何密钥都返回 4002 鉴权失败——真实联调从未做过，签名单测只查了
 * URL 格式没验证算法，所以这个错带病通过了全部关卡。
 */
export function buildTencentAsrUrl(params: {
  appId: string;
  secretId: string;
  secretKey: string;
  engineModelType: string;
  voiceId: string;
  sampleRate: number;
  audioFormat: number;
  wordInfoEnabled: number;
  needvad: number;
  hotwordId?: string;
  now?: Date;
}): { url: string; timestampSec: number } {
  const host = "asr.cloud.tencent.com";
  // 规范 URI 必须包含 appid 路径段
  const path = `/asr/v2/${params.appId}`;

  const timestampSec = Math.floor(
    (params.now?.getTime() ?? Date.now()) / 1000,
  );
  const query: Record<string, string> = {
    engine_model_type: params.engineModelType,
    expired: String(timestampSec + 3600), // 签名有效期 1 小时（要求 <90 天）
    needvad: String(params.needvad),
    nonce: String(crypto.randomInt(0, 1 << 30)), // 随机正整数，最长 10 位
    secretid: params.secretId,
    timestamp: String(timestampSec),
    voice_format: String(params.audioFormat),
    voice_id: params.voiceId,
    word_info: String(params.wordInfoEnabled),
  };
  if (params.hotwordId) query.hotword_id = params.hotwordId;
  if (params.sampleRate !== 16000) query.sample_rate = String(params.sampleRate);

  // 字典序排序；URL 查询串与签名原文用同一份，保证服务端重算时一致
  const queryStr = Object.keys(query)
    .filter((k) => query[k] !== "")
    .sort()
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join("&");

  const signOriginal = `${host}${path}?${queryStr}`;
  const signature = crypto
    .createHmac("sha1", params.secretKey)
    .update(signOriginal)
    .digest("base64");

  return {
    // signature 必须 urlencode：base64 含 + 和 =，不编码会导致鉴权失败
    url: `wss://${host}${path}?${queryStr}&signature=${encodeURIComponent(signature)}`,
    timestampSec,
  };
}
