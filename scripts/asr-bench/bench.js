/**
 * ASR 真实链路压测（真实 PCM 音频 → 腾讯云实时语音识别 WebSocket）。
 *
 * 只从环境变量读凭证，绝不打印、回显、写文件：
 *   DSH_SECRET_TENCENT_ASR_SECRET_ID / DSH_SECRET_TENCENT_ASR_SECRET_KEY
 * APPID 不是密钥，可直接写在配置里：1502622498
 *
 * 采集真实中文语音（TTS 生成的直播口语 WAV）→ 重采样/切片成 200ms PCM →
 * 按 1:1 实时率送上腾讯云 → 记录 partial/final、时间戳、连接生命周期与端到端延迟。
 *
 * 用法：
 *   node scripts/asr-bench/bench.js [分钟数] [是否在结束时断网复连]
 * 输出：scripts/asr-bench/out/report-<时间戳>.json + 控制台摘要
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TencentAsrAdapter } = require("../../dist/main/main/asr/tencentAdapter");
const { AsrConfigSchema } = require("../../dist/main/shared/schemas");

const APP_ID = "1502622498";
const SAMPLE_RATE = 16000;
const PACKET_MS = 200;
const PACKET_BYTES = (SAMPLE_RATE * PACKET_MS / 1000) * 2; // 6400
const AUDIO_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";
const OUT_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\out";

const TARGET_MINUTES = Number(process.argv[2] || "30");
const DO_RECONNECT = process.argv[3] === "reconnect";

function log(...a) { console.log(new Date().toISOString().slice(11, 23), ...a); }

function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error("missing env " + name);
  return v;
}

/** 读取 WAV，取 PCM 数据，转成 16k/16bit/mono Buffer。 */
function loadWavAs16kMono(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE ") {
    throw new Error("not a wav: " + file);
  }
  let off = 12;
  let fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { ch: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") data = buf.subarray(body, body + size);
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("bad wav chunks: " + file);
  // 已是 16k/16bit/mono 就直接返回
  if (fmt.bits === 16 && fmt.ch === 1 && fmt.rate === 16000) return Buffer.from(data);
  if (fmt.bits !== 16) throw new Error("unsupported bits " + fmt.bits + " in " + file);
  // stereo→mono：取左声道
  let mono;
  if (fmt.ch === 2) {
    mono = Buffer.alloc(data.length / 2);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 2) data.copy(mono, j, i, i + 2);
  } else if (fmt.ch === 1) {
    mono = Buffer.from(data);
  } else throw new Error("unsupported ch " + fmt.ch);
  return resample(mono, fmt.rate, 16000);
}

/** 线性重采样 Int16LE。 */
function resample(buf, from, to) {
  if (from === to) return Buffer.from(buf);
  const inSamples = buf.length / 2;
  const outSamples = Math.floor(inSamples * to / from);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = from / to;
  for (let i = 0; i < outSamples; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = src - i0;
    const s0 = buf.readInt16LE(i0 * 2);
    const s1 = buf.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 * (1 - frac) + s1 * frac), i * 2);
  }
  return out;
}

function listAudio() {
  return fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".wav")).sort()
    .map((f) => path.join(AUDIO_DIR, f));
}

async function main() {
  const secretId = readEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID");
  const secretKey = readEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY");
  const config = AsrConfigSchema.parse({
    provider: "tencent",
    appId: APP_ID,
    secretId,
    secretKey,
    engineModelType: "16k_zh",
    sampleRate: 16000,
    audioFormat: 1,
    wordInfoEnabled: 1,
    needvad: 1,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = listAudio();
  log("audio segments:", files.length);

  const adapter = new TencentAsrAdapter();
  const t0 = Date.now();

  // ---- 观测记录 ----
  const partials = [];   // {seq,text,startMs,endMs,recvAt}
  const finals = [];     // 同上 + 端到端延迟
  const statuses = [];   // 连接生命周期
  const errors = [];
  let connectionSeq = 0;
  let currentOpenAt = null;
  let firstAudioSentAt = null;

  adapter.on("status", (s) => {
    const st = s;
    statuses.push({ at: Date.now() - t0, state: st.state, reconnectAttempt: st.reconnectAttempt ?? 0, connectionId: st.connectionId ?? null });
    if (st.state === "connected") { connectionSeq++; currentOpenAt = Date.now(); }
    if (st.state === "reconnecting" || st.state === "closed") currentOpenAt = null;
  });
  adapter.on("error", (e) => { errors.push({ at: Date.now() - t0, code: e.error.code, message: e.error.message }); });
  adapter.on("partial", (p) => {
    partials.push({ seq: p.sourceSeq, text: p.text, startMs: p.startMs, endMs: p.endMs, recvAt: Date.now() - t0 });
  });
  adapter.on("final", (p) => {
    const recvAt = Date.now() - t0;
    finals.push({
      seq: p.sourceSeq, text: p.text, startMs: p.startMs, endMs: p.endMs,
      recvAt, voiceId: p.voiceId, connectionSeq,
      // 端到端延迟：该句结束时间点（会话时钟）→ 文本到达时刻
      e2eMs: recvAt - (firstAudioSentAt + p.endMs),
    });
  });

  log("connecting (appid", APP_ID, ") ...");
  const connectStart = Date.now();
  await adapter.connect(config);
  log("handshake OK in", Date.now() - connectStart, "ms");

  // ---- 循环送音频，1:1 实时率 ----
  const packets = [];
  for (const f of files) {
    const pcm = loadWavAs16kMono(f);
    for (let i = 0; i < pcm.length; i += PACKET_BYTES) {
      packets.push(pcm.subarray(i, Math.min(i + PACKET_BYTES, pcm.length)));
    }
  }
  log("total packets:", packets.length, "audio minutes:", Math.round(packets.length * PACKET_MS / 600) / 10);

  const runMs = TARGET_MINUTES * 60 * 1000;
  const started = Date.now();
  let sent = 0;
  let reconnectDone = false;
  let idx = 0;

  while (Date.now() - started < runMs) {
    const packet = packets[idx % packets.length];
    idx++;
    if (firstAudioSentAt === null) firstAudioSentAt = Date.now() - t0;
    try {
      await adapter.sendPcm(packet);
      sent++;
    } catch (err) {
      // 未连接时发送会抛；等待重连
      await new Promise((r) => setTimeout(r, 200));
    }
    // 1:1 实时率
    await new Promise((r) => setTimeout(r, PACKET_MS));

    // 中途断线复连：跑到一半时 stop 再重连（模拟网络闪断后客户端主动重连）
    if (DO_RECONNECT && !reconnectDone && Date.now() - started > runMs / 2) {
      reconnectDone = true;
      log(">>> 模拟断线：stop()");
      await adapter.stop();
      const gapStart = Date.now();
      await new Promise((r) => setTimeout(r, 5000));
      log(">>> 恢复：重连");
      await adapter.connect(config);
      log(">>> 重连完成，中断", Date.now() - gapStart, "ms");
    }
  }

  log("flushing & stopping");
  await adapter.stop();
  const totalMs = Date.now() - t0;

  // ---- 统计 ----
  const lat = finals.map((f) => f.e2eMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  const summary = {
    generatedAtIso: new Date().toISOString(),
    targetMinutes: TARGET_MINUTES,
    reconnectScenario: DO_RECONNECT,
    credentials: { appId: "configured", secretId: "configured", secretKey: "configured" },
    audio: { segments: files.length, packetsAvailable: packets.length, packetsSent: sent },
    counts: { partial: partials.length, final: finals.length, errors: errors.length, statusChanges: statuses.length },
    connections: { count: connectionSeq, events: statuses.filter((s) => s.state === "connected" || s.state === "reconnecting" || s.state === "closed") },
    latencyMs: {
      n: lat.length,
      mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      p50: q(lat, 0.5), p90: q(lat, 0.9), p95: q(lat, 0.95), max: lat.length ? lat[lat.length - 1] : null,
      min: lat.length ? lat[0] : null,
    },
    timestampMonotonic: checkMonotonic(finals),
    errors,
    wallMs: totalMs,
  };

  const outFile = path.join(OUT_DIR, "report-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(outFile, JSON.stringify({ summary, partials, finals, statuses }, null, 2));
  log("report written:", outFile);

  console.log("\n===== SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n===== FIRST 12 FINALS =====");
  for (const f of finals.slice(0, 12)) console.log(`seq=${f.seq} [${f.startMs}-${f.endMs}] e2e=${f.e2eMs}ms  ${f.text}`);
  console.log("===== LAST 6 FINALS =====");
  for (const f of finals.slice(-6)) console.log(`seq=${f.seq} [${f.startMs}-${f.endMs}] e2e=${f.e2eMs}ms  ${f.text}`);
}

function checkMonotonic(finals) {
  let nonDecreasing = true, duplicates = 0, prevEnd = -1, prevSeq = -1;
  const seqs = new Set();
  for (const f of finals) {
    if (f.startMs < 0 || f.endMs < f.startMs) nonDecreasing = false;
    if (f.endMs < prevEnd) nonDecreasing = false;
    prevEnd = f.endMs;
    if (f.seq <= prevSeq) nonDecreasing = false;
    prevSeq = f.seq;
    if (seqs.has(f.seq)) duplicates++;
    seqs.add(f.seq);
  }
  return { nonDecreasing, duplicateSeqCount: duplicates, uniqueSeq: seqs.size, total: finals.length };
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
