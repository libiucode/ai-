/**
 * 真实断网测试：用 netsh wlan disconnect 断开真实 Wi-Fi，保持 N 秒后重连，
 * 观测 ASR 适配器的重连行为。
 *
 * 说明：
 * - `netsh wlan disconnect` 不需要管理员权限（断开当前连接，不删配置文件）。
 * - 重连依赖系统的 WLAN 自动连接（通常几秒内自动回来）。
 * - 这个测试会短暂中断本机所有网络，跑之前要确认没有其他依赖网络的任务。
 *
 * 用法：node net-cut-test.js <CDP端口> <断开秒数>
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const { execSync, spawn } = require("node:child_process");
const PORT = Number(process.argv[2] || "9333");
const CUT_SECONDS = Number(process.argv[3] || "30");

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 确认 WLAN 在线
  let before = "";
  try {
    before = execSync("netsh wlan show interfaces", { encoding: "utf8" });
  } catch (e) { console.log("netsh failed:", e.message); }
  const connected = /已连接|Connected/.test(before);
  console.log("WLAN connected before test:", connected);
  if (!connected) { console.log("WLAN not connected, aborting"); return; }

  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page target on port " + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((rs, rj) => { const i = ++id; pending.set(i, { rs, rj }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rj(new Error(JSON.stringify(m.error))) : p.rs(m.result); } });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");

  // 2. 订阅 ASR 状态
  await send("Runtime.evaluate", {
    expression: `(() => {
      window.__asr = [];
      window.appApi.subscribeEvents("asr.status", (p) => window.__asr.push({ t: Date.now(), p }));
      window.appApi.subscribeEvents("app.error", (p) => window.__asr.push({ t: Date.now(), err: p }));
      return "subscribed";
    })()`,
    returnByValue: true,
  });

  const readAsr = async () => {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const a = window.__asr || [];
        return { count: a.length, last: a.length ? a[a.length-1] : null, states: a.filter(x=>x.p).map(x=>x.p.state + (x.p.gapDetected ? "(gap)" : "")) };
      })()`,
      returnByValue: true,
    });
    return r.result.value;
  };

  console.log("before cut:", JSON.stringify(await readAsr()));

  // 3. 断开 Wi-Fi
  console.log(`\n>>> CUTTING NETWORK (${CUT_SECONDS}s)`);
  const t0 = Date.now();
  try { execSync("netsh wlan disconnect", { encoding: "utf8" }); } catch (e) { console.log("disconnect failed:", e.message.slice(0, 200)); }

  // 观测断网期间的状态变化
  const samples = [];
  for (let i = 0; i < CUT_SECONDS; i++) {
    await sleep(1000);
    const s = await readAsr().catch(() => null);
    samples.push({ at: Date.now() - t0, ...s });
    if (i % 5 === 0 || i === CUT_SECONDS - 1) console.log(`  +${i + 1}s`, JSON.stringify(s));
  }

  // 4. 等待系统自动重连
  console.log("\n>>> WAITING FOR WLAN AUTO-RECONNECT");
  let reconnected = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const st = execSync("netsh wlan show interfaces", { encoding: "utf8" });
      if (/已连接|Connected/.test(st)) { reconnected = true; console.log(`  WLAN back after ${i + 1}s`); break; }
    } catch { /* keep waiting */ }
    if (i % 5 === 4) console.log(`  still down +${i + 1}s`);
  }

  // 5. 再观测 30 秒恢复情况
  console.log("\n>>> OBSERVING RECOVERY");
  const recovery = [];
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const s = await readAsr().catch(() => null);
    recovery.push({ at: Date.now() - t0, ...s });
    if (i % 5 === 0 || i === 29) console.log(`  +${i + 1}s`, JSON.stringify(s));
  }

  console.log("\n===== RESULT =====");
  console.log(JSON.stringify({
    wlanReconnected: reconnected,
    cutSeconds: CUT_SECONDS,
    totalObservedMs: Date.now() - t0,
    finalAsr: await readAsr(),
    duringCut: samples.filter((s) => s.count !== undefined).slice(-5),
    duringRecovery: recovery.slice(-5),
  }, null, 2));

  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
