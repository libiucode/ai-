// CDP attach helper for AI盯播 audio acceptance.
// Usage: node docs/cdp-probe.js <expression> [timeoutMs]
const http = require("node:http");
const WebSocket = require("../node_modules/ws");

const PORT = 9224;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}

async function main() {
  const expr = process.argv[2];
  const timeoutMs = Number(process.argv[3] || 15000);
  if (!expr) {
    console.error("usage: node docs/cdp-probe.js <expression> [timeoutMs]");
    process.exit(2);
  }
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
  if (!page) throw new Error("no page target");
  const att = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const sid = att.sessionId;

  const result = await Promise.race([
    send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid),
    new Promise((_, rej) => setTimeout(() => rej(new Error("evaluate timeout " + timeoutMs + "ms")), timeoutMs)),
  ]);
  const out = result.result ?? {};
  if (out.exceptionDetails) {
    console.error("PAGE EXCEPTION: " + JSON.stringify(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(out.value, null, 1));
  }
  ws.close();
}

main().catch((e) => {
  console.error("ERR " + e.message);
  process.exit(1);
});
