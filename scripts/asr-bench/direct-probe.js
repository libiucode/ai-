/**
 * 独立 WebSocket 压测探针：不依赖 dist 编译，直接用 ws + 官方 HMAC-SHA1 签名。
 * 只读环境变量凭证，绝不打印、写文件。
 * 用法：node scripts/asr-bench/direct-probe.js [秒数]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");

const APP_ID = process.env.DSH_TENCENT_ASR_APP_ID || "1502622498";
const SECRET_ID = process.env.DSH_SECRET_TENCENT_ASR_SECRET_ID;
const SECRET_KEY = process.env.DSH_SECRET_TENCENT_ASR_SECRET_KEY;
const RUN_SECONDS = Number(process.argv[2] || "60");
const AUDIO_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";

if (!SECRET_ID || !SECRET_KEY) { console.error("missing env credentials"); process.exit(2); }

const SAMPLE_RATE = 16000;
const PACKET_MS = 200;
const PACKET_BYTES = SAMPLE_RATE * PACKET_MS / 1000 * 2;

function buildUrl(voiceId) {
  const host = "asr.cloud.tencent.com";
  const p = `/asr/v2/${APP_ID}`;
  const ts = Math.floor(Date.now() / 1000);
  const q = {
    engine_model_type: "16k_zh",
    expired: String(ts + 3600),
    needvad: "1",
    nonce: String(crypto.randomInt(0, 1 << 30)),
    secretid: SECRET_ID,
    timestamp: String(ts),
    voice_format: "1",
    voice_id: voiceId,
    word_info: "1",
  };
  const qs = Object.keys(q).filter((k) => q[k] !== "").sort().map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  const sig = crypto.createHmac("sha1", SECRET_KEY).update(`${host}${p}?${qs}`).digest("base64");
  return `wss://${host}${p}?${qs}&signature=${encodeURIComponent(sig)}`;
}

function loadWav16kMono(file) {
  const buf = fs.readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") data = buf.subarray(body, body + sz);
    off = body + sz + (sz % 2);
  }
  if (fmt.bits !== 16) throw new Error("bits " + fmt.bits);
  let mono;
  if (fmt.ch === 2) { mono = Buffer.alloc(data.length / 2); for (let i = 0, j = 0; i < data.length; i += 4, j += 2) data.copy(mono, j, i, i + 2); }
  else mono = Buffer.from(data);
  if (fmt.rate !== 16000) return resample(mono, fmt.rate, 16000);
  return mono;
}
function resample(buf, from, to) {
  const inS = buf.length / 2;
  const outS = Math.floor(inS * to / from);
  const out = Buffer.alloc(outS * 2);
  const r = from / to;
  for (let i = 0; i < outS; i++) {
    const s = i * r, i0 = Math.floor(s), i1 = Math.min(i0 + 1, inS - 1), f = s - i0;
    out.writeInt16LE(Math.round(buf.readInt16LE(i0 * 2) * (1 - f) + buf.readInt16LE(i1 * 2) * f), i * 2);
  }
  return out;
}

const files = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".wav")).sort().map((f) => path.join(AUDIO_DIR, f));
const packets = [];
for (const f of files) {
  const pcm = loadWav16kMono(f);
  for (let i = 0; i < pcm.length; i += PACKET_BYTES) packets.push(pcm.subarray(i, Math.min(i + PACKET_BYTES, pcm.length)));
}
console.log("audio files:", files.length, "packets:", packets.length, "minutes:", Math.round(packets.length * PACKET_MS / 600) / 10);

const voiceId = crypto.randomUUID();
const url = buildUrl(voiceId);
const ws = new WebSocket(url, { handshakeTimeout: 10000 });
const t0 = Date.now();
let connectAt = 0;
const finals = [], partials = [], errors = [];
let firstSentAt = null;

ws.on("open", () => { connectAt = Date.now(); console.log("HANDSHAKE_MS", connectAt - t0); });
ws.on("message", (d) => {
  const msg = JSON.parse(String(d));
  if (msg.code && msg.code !== 0) { errors.push({ code: msg.code, message: msg.message }); console.log("SERVER_ERROR", msg.code, msg.message); return; }
  const r = msg.result;
  if (!r || !r.voice_text_str) return;
  const rec = { seq: r.index, slice: r.slice_type, text: r.voice_text_str, start: r.start_time, end: r.end_time, recvAt: Date.now() - t0 };
  if (r.slice_type === 2) {
    rec.e2e = rec.recvAt - (firstSentAt + r.end_time);
    finals.push(rec);
    console.log(`FINAL seq=${rec.seq} [${rec.start}-${rec.end}] e2e=${rec.e2e}ms  ${rec.text}`);
  } else {
    partials.push(rec);
    console.log(`PARTIAL(${r.slice_type}) seq=${rec.seq} ${rec.text}`);
  }
});
ws.on("error", (e) => { console.log("WS_ERROR", e.message); errors.push({ code: "WS", message: e.message }); });
ws.on("close", (c, r) => { console.log("WS_CLOSE", c, String(r).slice(0, 200)); });

const started = Date.now();
let idx = 0;
(async () => {
  while (Date.now() - started < RUN_SECONDS * 1000) {
    if (ws.readyState === 1) {
      const p = packets[idx % packets.length]; idx++;
      if (firstSentAt === null) firstSentAt = Date.now() - t0;
      ws.send(p);
    }
    await new Promise((r) => setTimeout(r, PACKET_MS));
  }
  try { ws.send(JSON.stringify({ type: "end" })); } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  const lat = finals.map((f) => f.e2e).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null;
  console.log("\n===== RESULT =====");
  console.log(JSON.stringify({
    handshakeMs: connectAt - t0,
    packetsSent: idx,
    partials: partials.length,
    finals: finals.length,
    errors: errors.length,
    latency: { n: lat.length, mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, p50: q(0.5), p95: q(0.95), max: lat.length ? lat[lat.length - 1] : null },
    tsCheck: checkTs(finals),
  }, null, 2));
  ws.terminate();
  process.exit(0);
})();

function checkTs(fs2) {
  let ok = true, prevEnd = -1, prevSeq = -1;
  for (const f of fs2) {
    if (f.end < f.start) ok = false;
    if (f.end < prevEnd) ok = false;
    prevEnd = f.end;
    if (f.seq <= prevSeq) ok = false;
    prevSeq = f.seq;
  }
  return { monotonic: ok, total: fs2.length };
}
