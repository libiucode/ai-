import crypto from "node:crypto";

/**
 * Tencent Cloud TC3-HMAC-SHA256 signature for the ASR WebSocket handshake.
 * Produces the `authorization` URL parameter. Secrets are never returned.
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
  const path = "/asr/v2/";
  const query: Record<string, string> = {
    engine_model_type: params.engineModelType,
    expired: String(
      Math.floor((params.now?.getTime() ?? Date.now()) / 1000) + 3600,
    ),
    needvad: String(params.needvad),
    hotword_id: params.hotwordId ?? "",
    nonce: String(crypto.randomInt(0, 1 << 30)),
    secretid: params.secretId,
    appid: params.appId,
    timestamp: "",
    voice_format: String(params.audioFormat),
    voice_id: params.voiceId,
    word_info: String(params.wordInfoEnabled),
  };
  if (params.sampleRate !== 16000) {
    query.sample_rate = String(params.sampleRate);
  }

  const timestampSec = Math.floor(
    (params.now?.getTime() ?? Date.now()) / 1000,
  );
  query.timestamp = String(timestampSec);

  const sortedKeys = Object.keys(query)
    .filter((k) => query[k] !== "")
    .sort();
  const queryStr = sortedKeys
    .map((k) => `${k}=${encodeURIComponent(query[k]).replace(/%2F/g, "%2F")}`)
    .join("&");

  const canonical = `GET\n${path}\n${queryStr}\nhost:${host}\n`;
  const hashedCanonical = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  const date = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  const stringToSign = `TC3-HMAC-SHA256\n${timestampSec}\n${date}/asr/tc3_request\n${hashedCanonical}`;

  const kDate = crypto
    .createHmac("sha256", `TC3${params.secretKey}`)
    .update(date)
    .digest();
  const kService = crypto.createHmac("sha256", kDate).update("asr").digest();
  const kSigning = crypto
    .createHmac("sha256", kService)
    .update("tc3_request")
    .digest();
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  const authorization = `TC3-HMAC-SHA256 Credential=${params.secretId}/${date}/asr/tc3_request, SignedHeaders=host, Signature=${signature}`;

  return {
    url: `wss://${host}${path}${params.appId}?${queryStr}&authorization=${encodeURIComponent(authorization)}`,
    timestampSec,
  };
}
