// 在渲染层安装 sendAudioChunk 计数器（必须在点击开始之前装），返回计数与电平统计。
// 用法: node docs/probe-install.js        -> 安装探针
//       node docs/probe-read.js           -> 读取计数
const http = require("node:http");
const WebSocket = require("../node_modules/ws");
const PORT = 9224;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

async function evalExpr(expr, timeoutMs) {
  const version = JSON.parse(await httpGet("/json/version"));
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      const msg = { id: i, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });
  ws.on("message", (m) => {
    const o = JSON.parse(m);
    if (o.id && pending.has(o.id)) {
      const { resolve, reject } = pending.get(o.id);
      pending.delete(o.id);
      o.error ? reject(new Error(o.error.message)) : resolve(o.result);
    }
  });
  await new Promise((r) => ws.on("open", r));
  const targets = await send("Target.getTargets");
  const page = targets.targetInfos.find((t) => t.type === "page");
  const att = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const result = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, att.sessionId),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
  ]);
  ws.close();
  if (result.result.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text));
  }
  return result.result.value;
}

const MODE = process.argv[2] || "install";

const INSTALL = `(() => {
  if (!window.appApi) return { err: 'no appApi' };
  if (window.__probeInstalled) return { already: true, n: window.__probe.n, samples: window.__probe.n };
  const orig = window.appApi.sendAudioChunk.bind(window.appApi);
  window.__probe = {
    n: 0, samples: 0, rates: {}, levels: [], peak: 0, startedAt: Date.now(), lastAt: 0,
  };
  window.appApi.sendAudioChunk = function (f32, rate) {
    const p = window.__probe;
    p.n++; p.samples += f32.length;
    p.rates[rate] = (p.rates[rate] || 0) + 1;
    p.lastAt = Date.now();
    let mx = 0, sum = 0;
    for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); sum += a; if (a > mx) mx = a; }
    const avg = sum / f32.length;
    if (p.levels.length < 400) p.levels.push(+avg.toFixed(5));
    if (mx > p.peak) p.peak = +mx.toFixed(5);
    return orig(f32, rate);
  };
  window.__probeInstalled = true;
  return { installed: true };
})()`;

const READ = `(() => {
  const p = window.__probe; if (!p) return { err: 'no probe' };
  const lv = p.levels; const nz = lv.filter(x => x > 0.001).length;
  return {
    chunks: p.n, samples: p.samples, rates: p.rates, peak: +p.peak.toFixed(5),
    levelSamples: lv.length, nonZeroLevelSamples: nz,
    avgLevel: +(lv.reduce((a,b)=>a+b,0) / Math.max(1,lv.length)).toFixed(5),
    maxLevel: Math.max(...lv), first8: lv.slice(0, 8),
    lastChunkAgoMs: Date.now() - p.lastAt, runningSec: Math.round((Date.now() - p.startedAt)/1000),
  };
})()`;

evalExpr(MODE === "read" ? READ : INSTALL, Number(process.argv[3] || 20000))
  .then((v) => console.log(JSON.stringify(v, null, 1)))
  .catch((e) => { console.error("ERR " + e.message); process.exit(1); });
