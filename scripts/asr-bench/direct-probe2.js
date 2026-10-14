/**
 * ASR 压测探针（真实 PCM → 腾讯云实时 ASR WebSocket）。
 * 与原 direct-probe 的区别：DNS 用系统解析器预取 IP，再用 lookup 手动绑定，
 * 规避 Node 在"多网卡且仅 WLAN 在线"下 EAI_AGAIN 的问题。
 *
 * 凭证只从环境变量读，不打印、不落盘。
 * 用法：node direct-probe2.js [秒数]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns");
const { execSync } = require("node:child_process");
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");

const APP_ID = process.env.DSH_TENCENT_ASR_APP_ID || "1502622498";
const SECRET_ID = process.env.DSH_SECRET_TENCENT_ASR_SECRET_ID;
const SECRET_KEY = process.env.DSH_SECRET_TENCENT_ASR_SECRET_KEY;
const RUN_SECONDS = Number(process.argv[2] || "60");
const AUDIO_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";
const RECONNECT_AT = Number(process.argv[3] || "0"); // 秒；>0 时在该时刻主动断线复连

if (!SECRET_ID || !SECRET_KEY) { console.error("missing env credentials"); process.exit(2); }

const SAMPLE_RATE = 16000, PACKET_MS = 200, PACKET_BYTES = SAMPLE_RATE * PACKET_MS / 1000 * 2;
const HOST = "asr.cloud.tencent.com";

/** 用系统解析器拿 IP（PowerShell Resolve-DnsName 在这个网卡状态下比 Node 可靠）。 */
function resolveHostIp() {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "(Resolve-DnsName ${HOST} -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const m = raw.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return null;
}
const HOST_IP = resolveHostIp();
if (HOST_IP) {
  // ws 内部用 dns.lookup(hostname, {family, hints, all}, cb)。
  // 覆盖时必须保持 (hostname, options, callback) 签名，否则 ws 收到
  // "Invalid IP address: undefined"（它期望 cb 里带回 all 数组或单地址）。
  dns.lookup = (hostname, options, callback) => {
    let cb = callback;
    if (typeof options === "function") { cb = options; }
    process.nextTick(() => cb(null, HOST_IP, 4));
  };
  console.log("pinned", HOST, "->", HOST_IP);
} else {
  console.log("no pre-resolved IP, using system resolver");
}

let VOICE_SEQ = 0;
function buildUrl() {
  VOICE_SEQ++;
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
    voice_id: crypto.randomUUID(),
    word_info: "1",
  };
  const qs = Object.keys(q).filter((k) => q[k] !== "").sort().map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  const sig = crypto.createHmac("sha1", SECRET_KEY).update(`${HOST}${p}?${qs}`).digest("base64");
  return `wss://${HOST}${p}?${qs}&signature=${encodeURIComponent(sig)}`;
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

const t0 = Date.now();
const finals = [], partials = [], errors = [], connections = [];
let ws = null, connectStart = 0;
/** 每个连接第一包音频送出的会话时钟（服务端时间戳的基准）。 */
const connFirstSent = {};
let firstSentAt = null;

function open() {
  connectStart = Date.now();
  // 完全绕开 ws 内部的 dns.lookup：直接给 createConnection 一个已连到
  // HOST_IP:443 的 TCP socket，Servername 仍是 HOST（SNI/证书校验对）。
  const net = require("node:net");
  const tls = require("node:tls");
  const socket = HOST_IP
    ? tls.connect({ host: HOST_IP, port: 443, servername: HOST }, () => {})
    : undefined;
  const opts = socket
    ? { handshakeTimeout: 10000, createConnection: () => socket }
    : { handshakeTimeout: 10000 };
  ws = new WebSocket(buildUrl(), opts);
  ws.on("open", () => {
    const hs = Date.now() - connectStart;
    connections.push({ openAt: Date.now() - t0, handshakeMs: hs });
    console.log("OPEN #" + connections.length, "handshakeMs", hs, "connIdx", VOICE_SEQ);
  });
  ws.on("message", (d) => {
    const msg = JSON.parse(String(d));
    if (msg.code && msg.code !== 0) {
      errors.push({ code: msg.code, message: msg.message });
      console.log("SERVER_ERROR", msg.code, msg.message);
      return;
    }
    const r = msg.result;
    if (!r || !r.voice_text_str) return;
    const rec = { seq: r.index, slice: r.slice_type, text: r.voice_text_str, start: r.start_time, end: r.end_time, conn: VOICE_SEQ, recvAt: Date.now() - t0 };
    if (r.slice_type === 2) {
      // 端到端延迟 = 该句音频结束时刻（会话时钟）→ final 到达时刻（会话时钟）。
      // 关键：服务端 start_time/end_time 是"该 WebSocket 连接内已送入音频的偏移"，
      // 每次重连都从 0 重新计数。所以基准必须按连接取——该连接第一包音频
      // 送出的会话时钟 + 服务端给的 end_time。
      const base = connFirstSent[VOICE_SEQ];
      rec.e2e = base === undefined ? null : rec.recvAt - (base + r.end_time);
      // 首字延迟：该句第一个 partial 到达时刻 - 该句起始音频时刻
      const firstPartial = partials.find((p) => p.seq === r.index && p.conn === VOICE_SEQ);
      rec.firstTokenLatency = firstPartial && base !== undefined ? firstPartial.recvAt - (base + r.start_time) : null;
      finals.push(rec);
      console.log(`FINAL conn=${rec.conn} seq=${rec.seq} [${rec.start}-${rec.end}] e2e=${rec.e2e}ms ftl=${rec.firstTokenLatency}ms  ${rec.text}`);
    } else {
      partials.push(rec);
      console.log(`PARTIAL(${r.slice_type}) conn=${rec.conn} seq=${rec.seq} ${rec.text}`);
    }
  });
  ws.on("error", (e) => { errors.push({ code: "WS", message: e.message }); console.log("WS_ERROR", e.message); });
  ws.on("close", (c) => { console.log("WS_CLOSE", c, "connIdx", VOICE_SEQ); });
}

open();

(async () => {
  const started = Date.now();
  let idx = 0, reconnected = false;
  while (Date.now() - started < RUN_SECONDS * 1000) {
    if (ws && ws.readyState === 1) {
      const p = packets[idx % packets.length]; idx++;
      const now = Date.now() - t0;
      if (connFirstSent[VOICE_SEQ] === undefined) connFirstSent[VOICE_SEQ] = now;
      if (firstSentAt === null) firstSentAt = now;
      ws.send(p);
    } else {
      idx++;
    }
    await new Promise((r) => setTimeout(r, PACKET_MS));

    if (RECONNECT_AT > 0 && !reconnected && (Date.now() - started) / 1000 >= RECONNECT_AT) {
      reconnected = true;
      console.log(">>> SIMULATE_NETWORK_CUT: terminating socket");
      try { ws.terminate(); } catch {}
      await new Promise((r) => setTimeout(r, 5000));
      console.log(">>> REOPEN");
      open();
    }
  }
  try { ws.send(JSON.stringify({ type: "end" })); } catch {}
  await new Promise((r) => setTimeout(r, 3000));

  const lat = finals.map((f) => f.e2e).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const ftl = finals.map((f) => f.firstTokenLatency).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  let monotonic = true, prevEnd = -1, prevSeq = -1;
  // 时间戳单调性按连接分别校验：服务端每个连接内 index 从 0 重新计数、
  // 时间戳也从 0 重新计数，这是协议行为不是缺陷。跨连接的绝对时间由
  // orchestrator 的 asrAudioStartMs 重新锚定。
  let perConn = {};
  for (const f of finals) {
    const k = f.conn;
    if (!perConn[k]) perConn[k] = { end: -1, seq: -1, count: 0 };
    const c = perConn[k];
    if (f.end < f.start || f.end < c.end || f.seq <= c.seq) { monotonic = false; c.violation = (c.violation || 0) + 1; }
    c.end = Math.max(c.end, f.end); c.seq = Math.max(c.seq, f.seq); c.count++;
  }
  const connStats = Object.entries(perConn).map(([conn, c]) => ({ conn: Number(conn), finals: c.count, lastSeq: c.seq, lastEndMs: c.end, violations: c.violation || 0 }));
  const result = {
    appId: "configured", secretId: "configured", secretKey: "configured",
    measuredAtIso: new Date().toISOString(),
    runSeconds: RUN_SECONDS, packetsSent: idx, connections: connections.length,
    partials: partials.length, finals: finals.length, errorCount: errors.length, errors,
    e2eMs: {
      n: lat.length, mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      p50: q(lat, 0.5), p90: q(lat, 0.9), p95: q(lat, 0.95), max: lat.length ? lat[lat.length - 1] : null,
    },
    firstTokenLatencyMs: {
      n: ftl.length, mean: ftl.length ? Math.round(ftl.reduce((a, b) => a + b, 0) / ftl.length) : null,
      p50: q(ftl, 0.5), p95: q(ftl, 0.95), max: ftl.length ? ftl[ftl.length - 1] : null,
    },
    timestamps: { monotonicPerConnection: monotonic, connections: connStats, first: finals[0] ? { conn: finals[0].conn, seq: finals[0].seq, start: finals[0].start, end: finals[0].end } : null, last: finals.at(-1) ? { conn: finals.at(-1).conn, seq: finals.at(-1).seq, start: finals.at(-1).start, end: finals.at(-1).end } : null },
  };
  console.log("\n===== RESULT =====");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n===== FINAL TEXTS =====");
  for (const f of finals) console.log(`[${f.start}-${f.end}] ${f.text}`);
  try { ws.terminate(); } catch {}
  process.exit(0);
})();
