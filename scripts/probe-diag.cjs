// 诊断：AudioContext 在 Electron 渲染进程里为什么不回调
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(JSON.parse(b)));
      })
      .on("error", reject);
  });
}

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname;
    this.handlers = { message: [] };
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let done = false;
      this.buf = Buffer.alloc(0);
      this.sock.on("data", (d) => {
        if (!done) {
          const s = d.toString("latin1");
          const i = s.indexOf("\r\n\r\n");
          if (i === -1) return;
          done = true;
          this.buf = Buffer.concat([this.buf, d.slice(Buffer.byteLength(s.slice(0, i + 4), "latin1"))]);
          resolve();
          this._drain();
          return;
        }
        this.buf = Buffer.concat([this.buf, d]);
        this._drain();
      });
      this.sock.on("error", reject);
    });
  }
  _drain() {
    for (;;) {
      if (!this.buf || this.buf.length < 2) return;
      const b1 = this.buf[1];
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
      this.handlers.message.forEach((h) => h(payload.toString("utf8")));
    }
  }
  sendText(s) {
    const p = Buffer.from(s, "utf8");
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), mask, masked]));
  }
  onMessage(h) {
    this.handlers.message.push(h);
  }
}

async function main() {
  const targets = await getJson("http://127.0.0.1:9222/json/list");
  const page = targets.find((t) => t.type === "page");
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();
  let id = 0;
  const pending = new Map();
  ws.onMessage((raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { resolve: res, reject: rej });
      ws.sendText(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr, awaitPromise = true) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description));
    return r.result.value;
  };

  console.log("1) 页面状态:", JSON.stringify(await ev(`({
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    url: location.href,
  })`)));

  // 用 OscillatorNode 测试：不依赖麦克风权限
  const oscTest = await ev(`
  (async () => {
    const ctx = new AudioContext();
    const before = ctx.state;
    const osc = ctx.createOscillator();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.frequency.value = 440;
    osc.connect(analyser);
    analyser.connect(ctx.destination);
    let frames = 0;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = () => { frames++; };
    osc.connect(proc);
    proc.connect(ctx.destination);
    osc.start();
    await new Promise(r => setTimeout(r, 2000));
    const after = ctx.state;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    const sum = buf.reduce((a,b)=>a+b,0);
    let peakBin = 0, peakVal = 0;
    buf.forEach((v,i) => { if (v > peakVal) { peakVal = v; peakBin = i; } });
    const rate = ctx.sampleRate;
    osc.stop();
    await ctx.close();
    return { before, after, rate, procFrames: frames, analyserSum: sum,
             peakBin, peakHz: Math.round(peakBin * rate / analyser.fftSize), peakVal };
  })()
  `);
  console.log("2) Oscillator + ScriptProcessor 测试:", JSON.stringify(oscTest));

  // 麦克风 + resume
  const micTest = await ev(`
  (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const state0 = ctx.state;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch(e) {} }
    const state1 = ctx.state;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    let frames = 0, lastRms = 0, lastPeak = 0;
    proc.onaudioprocess = (e) => {
      frames++;
      const d = e.inputBuffer.getChannelData(0);
      let s=0,p=0;
      for (let i=0;i<d.length;i++){ const a=Math.abs(d[i]); s+=a; if(a>p)p=a; }
      lastRms = s/d.length; lastPeak = p;
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    await new Promise(r => setTimeout(r, 3000));
    const info = {
      state0, state1, stateAfter: ctx.state, rate: ctx.sampleRate,
      frames, lastRms, lastPeak,
      trackLabel: stream.getAudioTracks()[0]?.label,
      trackEnabled: stream.getAudioTracks()[0]?.enabled,
      trackMuted: stream.getAudioTracks()[0]?.muted,
      trackReadyState: stream.getAudioTracks()[0]?.readyState,
      ctxCurrentTime: ctx.currentTime,
      ctxBaseLatency: ctx.baseLatency,
    };
    try { await ctx.close(); } catch {}
    stream.getTracks().forEach(t=>t.stop());
    return info;
  })()
  `);
  console.log("3) 麦克风 + ctx.resume() 测试:", JSON.stringify(micTest));

  // 检查 getDisplayMedia 是否可用 + desktopCapturer 源（需要 main 进程支持，这里先看 API 存在性）
  const gdm = await ev(`
  (async () => {
    const md = navigator.mediaDevices;
    const has = typeof md.getDisplayMedia === 'function';
    let permState = 'n/a';
    try {
      if (navigator.permissions) {
        const st = await navigator.permissions.query({ name: 'display-capture' });
        permState = st.state;
      }
    } catch (e) { permState = 'query-failed: ' + e.name; }
    return { hasGetDisplayMedia: has, displayCapturePermission: permState,
             enumerateDevicesCount: (await md.enumerateDevices()).length };
  })()
  `);
  console.log("4) getDisplayMedia 可用性:", JSON.stringify(gdm));
}

main().catch((e) => {
  console.error("诊断失败:", e.message);
  process.exit(1);
});
