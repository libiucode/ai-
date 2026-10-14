/**
 * CDP 轻量客户端：连上指定调试端口，列 target、在渲染页执行 JS、读 console。
 * 只依赖 Node 内置能力 + ws。
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const http = require(url.startsWith("https") ? "node:https" : "node:http");
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function main() {
  const port = Number(process.argv[2] || "9333");
  const targets = await httpJson(`http://127.0.0.1:${port}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) { console.log("NO_PAGE", targets.map((t) => t.type + " " + t.url.slice(0, 60))); return; }
  console.log("PAGE", page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const consoleMsgs = [];
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
      consoleMsgs.push("[" + msg.params.type + "] " + args);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleMsgs.push("[exception] " + (d.exception?.description || d.text));
    }
  });

  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable").catch(() => {});

  // 页面加载完成后探测 DOM 与 appApi 状态
  await new Promise((r) => setTimeout(r, 1500));
  const probe = await send("Runtime.evaluate", {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll("button")).map(b => (b.textContent||"").trim()).filter(Boolean);
      return {
        hasApi: typeof window.appApi === "object" && window.appApi !== null,
        apiKeys: typeof window.appApi === "object" ? Object.keys(window.appApi) : [],
        buttons: btns,
        bodyHead: document.body.innerText.slice(0, 400),
      };
    })()`,
    returnByValue: true,
  });
  console.log("PROBE", JSON.stringify(probe.result.value, null, 2));

  // ASR 配置来源（只说是否配置，不打印任何密文）
  const asr = await send("Runtime.evaluate", {
    expression: `window.appApi.getAsrStatus().then(s => JSON.stringify(s))`,
    returnByValue: true, awaitPromise: true,
  }).catch((e) => ({ err: e.message }));
  console.log("ASR_STATUS", asr.result ? asr.result.value : asr.err);

  console.log("CONSOLE_MSGS", JSON.stringify(consoleMsgs.slice(0, 40), null, 2));
  ws.close();
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
