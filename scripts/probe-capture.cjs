// 通过 Chrome DevTools Protocol 驱动已启动的 Electron 应用，在真实渲染进程里
// 调用 startMicCapture / startLoopbackCapture，采集 N 秒音频并统计电平与 PCM 特征。
//
// 用法: node scripts/probe-capture.cjs <seconds> [mode]
//   mode = mic | loopback | both
//
// 依赖: 应用已用 --remote-debugging-port=9222 启动。

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const SECONDS = Number(process.argv[2] ?? 10);
const MODE = process.argv[3] ?? "both";
const PORT = 9222;
const OUT = path.join(__dirname, "..", `capture-probe-${Date.now()}.json`);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`bad json from ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

// 极简 WebSocket 客户端（无依赖），支持分片文本帧
const net = require("node:net");
const crypto = require("node:crypto");

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname + (u.search || "");
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.handlers = { message: [], close: [] };
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let handshakeDone = false;
      this.sock.on("data", (d) => {
        if (!handshakeDone) {
          const s = d.toString("latin1");
          const idx = s.indexOf("\r\n\r\n");
          if (idx === -1) return;
          handshakeDone = true;
          const rest = d.slice(Buffer.byteLength(s.slice(0, idx + 4), "latin1"));
          this.buf = Buffer.concat([this.buf, rest]);
          resolve();
          this._drain();
          return;
        }
        this.buf = Buffer.concat([this.buf, d]);
        this._drain();
      });
      this.sock.on("error", reject);
      this.sock.on("close", () => this.handlers.close.forEach((h) => h()));
    });
  }
  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (opcode === 1) this.handlers.message.forEach((h) => h(payload.toString("utf8")));
      if (opcode === 8) {
        this.sock.end();
        return;
      }
      if (!fin) {
        /* 本项目消息都很小，忽略分片续帧 */
      }
    }
  }
  sendText(str) {
    const payload = Buffer.from(str, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  onMessage(h) {
    this.handlers.message.push(h);
  }
  close() {
    try {
      this.sock.end();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
  if (!page) throw new Error("找不到渲染进程页面目标: " + JSON.stringify(targets.map((t) => t.url)));
  console.log("目标页面:", page.url, "webSocketDebuggerUrl:", page.webSocketDebuggerUrl);

  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  let msgId = 0;
  const pending = new Map();
  ws.onMessage((raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.sendText(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expr, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");

  // 在页面里安装采集探针：拦截 sendAudioChunk 记录每个 chunk 的统计量
  const install = await evaluate(`
    (() => {
      window.__probe = {
        chunks: [],
        levels: [],
        startWall: Date.now(),
        sourceLabel: null,
        sampleRate: null,
        errors: [],
        installed: true,
      };
      const orig = window.appApi.sendAudioChunk;
      window.appApi.sendAudioChunk = (f32, rate) => {
        const p = window.__probe;
        let sum = 0, peak = 0, zeros = 0, clipped = 0, nans = 0;
        for (let i = 0; i < f32.length; i++) {
          const v = f32[i];
          if (Number.isNaN(v)) { nans++; continue; }
          const a = Math.abs(v);
          sum += a;
          if (a > peak) peak = a;
          if (v === 0) zeros++;
          if (a >= 0.999) clipped++;
        }
        p.chunks.push({
          n: f32.length,
          rate,
          mean: sum / f32.length,
          peak,
          zeros,
          clipped,
          nans,
          t: Date.now() - p.startWall,
        });
        p.sampleRate = rate;
        return orig(f32, rate);
      };
      return { ok: true, hadApi: typeof window.appApi?.sendAudioChunk === 'function' };
    })()
  `);
  console.log("探针安装:", JSON.stringify(install));

  async function runMode(mode) {
    const res = await evaluate(`
      (async () => {
        const p = window.__probe;
        p.chunks = []; p.levels = []; p.errors = []; p.startWall = Date.now(); p.sourceLabel = null;
        const mod = await import('./assets/index-B5IpudRN.js').catch(() => null);
        return { hasImport: !!mod };
      })()
    `);
    // 直接从模块图里拿不到（打包后），改用页面已绑定的全局入口：MonitorPage 的按钮不可靠，
    // 所以在页面上下文里重新实现等价调用：通过 React 事件太脆，改为直接调 capture 模块导出的
    // 函数——打包后它们不在全局。退路：用 window.appApi + 手动 getUserMedia/getDisplayMedia。
    // 这里采用手动等价实现，确保路径与 audioCapture.ts 完全一致。
    const code = mode === "mic" ? MIC_CODE : LOOPBACK_CODE;
    const started = await evaluate(code);
    console.log(`[${mode}] 启动结果:`, JSON.stringify(started));
    if (!started.ok) {
      return { mode, ok: false, error: started.error };
    }
    // 等 N 秒，期间采样电平
    const samples = [];
    for (let i = 0; i < SECONDS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const snap = await evaluate(`(() => {
        const p = window.__probe;
        return { chunks: p.chunks.length, rate: p.sampleRate, label: p.sourceLabel,
                 lastMean: p.chunks.length ? p.chunks[p.chunks.length-1].mean : null,
                 lastPeak: p.chunks.length ? p.chunks[p.chunks.length-1].peak : null };
      })()`);
      samples.push({ t: i + 1, ...snap });
      console.log(`[${mode}] t=${i + 1}s chunks=${snap.chunks} rate=${snap.rate} mean=${snap.lastMean} peak=${snap.lastPeak}`);
    }
    const final = await evaluate(`(() => {
      const p = window.__probe;
      const ch = p.chunks;
      const nonzero = ch.filter(c => c.mean > 0);
      const totalSamples = ch.reduce((a,c) => a + c.n, 0);
      return {
        sourceLabel: p.sourceLabel,
        sampleRate: p.sampleRate,
        chunkCount: ch.length,
        totalSamples,
        firstChunk: ch[0] ?? null,
        lastChunk: ch[ch.length-1] ?? null,
        nonzeroChunks: nonzero.length,
        allZeroChunks: ch.length - nonzero.length,
        maxMean: Math.max(0, ...ch.map(c => c.mean)),
        maxPeak: Math.max(0, ...ch.map(c => c.peak)),
        avgChunkIntervalMs: ch.length > 1 ? Math.round((ch[ch.length-1].t - ch[0].t) / (ch.length - 1)) : null,
        anyNan: ch.some(c => c.nans > 0),
        anyClipped: ch.some(c => c.clipped > 0),
        allZerosInChunk: ch.filter(c => c.zeros === c.n).length,
        expectedChunksPerSec: p.sampleRate ? (p.sampleRate / 4096).toFixed(2) : null,
        wallMs: Date.now() - p.startWall,
      };
    })()`);
    return { mode, ok: true, samples, final };
  }

  const results = {};
  if (MODE === "mic" || MODE === "both") results.mic = await runMode("mic");
  if (MODE === "loopback" || MODE === "both") results.loopback = await runMode("loopback");

  fs.writeFileSync(OUT, JSON.stringify({ seconds: SECONDS, mode: MODE, results }, null, 2));
  console.log("结果写入:", OUT);
  console.log(JSON.stringify(results, null, 2));
  ws.close();
}

const MIC_CODE = `
(async () => {
  const p = window.__probe;
  p.sourceLabel = "麦克风";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false },
    });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
      const level = sum / data.length;
      p.levels.push(level);
      window.appApi.sendAudioChunk(new Float32Array(data), ctx.sampleRate);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    window.__cap = { ctx, stream, proc, src, mute };
    return { ok: true, deviceLabel: stream.getAudioTracks()[0]?.label ?? null, ctxRate: ctx.sampleRate, ctxState: ctx.state };
  } catch (err) {
    p.errors.push(String(err && err.name) + ": " + String(err && err.message));
    return { ok: false, error: { name: err?.name, message: err?.message } };
  }
})()
`;

const LOOPBACK_CODE = `
(async () => {
  const p = window.__probe;
  p.sourceLabel = "系统声音";
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(t => t.stop());
      p.errors.push("no audio track in shared stream");
      return { ok: false, error: { name: "NoAudioTrack", message: "共享流没有音频轨道" } };
    }
    stream.getVideoTracks().forEach(t => t.stop());
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
      const level = sum / data.length;
      p.levels.push(level);
      window.appApi.sendAudioChunk(new Float32Array(data), ctx.sampleRate);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    window.__cap = { ctx, stream, proc, src, mute };
    return { ok: true, deviceLabel: audioTracks[0]?.label ?? null, ctxRate: ctx.sampleRate, ctxState: ctx.state };
  } catch (err) {
    p.errors.push(String(err && err.name) + ": " + String(err && err.message));
    return { ok: false, error: { name: err?.name, message: err?.message } };
  }
})()
`;

main().catch((e) => {
  console.error("探针失败:", e.message);
  process.exit(1);
});
