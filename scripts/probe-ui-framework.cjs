/**
 * 验证：装上框架后，界面是否真的能用（只看不改）。
 */
const http = require("node:http");
const PORT = Number(process.argv[2] || "9223");

const get = (p) =>
  new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(b));
    }).on("error", rej);
  });

async function main() {
  const targets = JSON.parse(await get("/json"));
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log("无页面"); process.exit(2); }
  const WebSocket = require("D:/ai盯播工具/app/node_modules/ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((rs, rj) => {
    const i = ++id; pending.set(i, { rs, rj });
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rj(new Error(JSON.stringify(m.error))) : p.rs(m.result);
    }
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? { __error: r.exceptionDetails.text } : r.result.value;
  };

  // 切到话术配置页
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => (x.textContent||'').trim() === '话术配置');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const info = await ev(`(() => {
    const t = document.body.innerText;
    return {
      text: t.replace(/\\n+/g, ' | ').slice(0, 900),
      stepCountText: (t.match(/话术步骤（(\\d+)）/) || [])[1],
      ruleCountText: (t.match(/自定义规则（(\\d+)）/) || [])[1],
      hasFactText: /护肤|禁止|不得/.test(t),
      frameworkName: (t.match(/话术名称[\\s\\S]{0,60}/) || [''])[0].slice(0, 60),
    };
  })()`);
  console.log("=== 话术配置页 ===");
  console.log("话术步骤数 =", info.stepCountText);
  console.log("自定义规则数 =", info.ruleCountText);
  console.log("商品事实已加载 =", info.hasFactText);
  console.log("\n--- 页面文本 ---\n" + info.text);

  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
