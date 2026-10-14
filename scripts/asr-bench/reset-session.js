/**
 * 重置驱动：结束 app 当前会话（如果还在监听），让下一次跑从干净状态开始。
 * 只操作指定 CDP 端口对应的实例。
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const PORT = Number(process.argv[2] || "9333");

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.on("message", (raw) => { const msg = JSON.parse(String(raw)); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); } });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {
      const t = document.body.innerText;
      const hasEnd = Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束");
      if (hasEnd) {
        const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "结束");
        b.click();
        await new Promise(r => setTimeout(r, 1500));
        return { ended: true, before: t.slice(0, 200) };
      }
      return { ended: false, snippet: t.slice(0, 200) };
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
  ws.close();
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
