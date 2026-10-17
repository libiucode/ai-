/**
 * 界面可用性实测：用 CDP 连上正在跑的应用，逐页检查真实渲染。
 *
 * 回答「能不能正常使用」不能只看进程活着，要看：
 * 1. 四页是否能渲染、有无白屏
 * 2. 设置页的密钥输入框是否真的存在且可填（客户最关心的一条）
 * 3. 框架页是否有入口（当前库里 frameworks = 0，用户得先建一个）
 * 4. 监控页开始按钮是否可用
 */
const http = require("node:http");

const PORT = Number(process.argv[2] || "9222");
const get = (p) =>
  new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(b));
    }).on("error", rej);
  });

async function main() {
  let targets;
  try {
    targets = JSON.parse(await get("/json"));
  } catch (e) {
    console.log("无法连接 CDP（应用可能未以调试端口启动）:", e.message);
    process.exit(2);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) { console.log("没有找到页面"); process.exit(2); }
  console.log("页面 URL:", page.url);

  const WebSocket = require("D:/ai盯播工具/app/node_modules/ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (m, p) =>
    new Promise((rs, rj) => {
      const i = ++id;
      pending.set(i, { rs, rj });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rj(new Error(JSON.stringify(m.error))) : p.rs(m.result);
    }
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
    return r.result.value;
  };

  console.log("\n=== [1] 页面基本渲染 ===");
  console.log(JSON.stringify(await evalJs(`(() => ({
    title: document.title,
    bodyLen: document.body.innerText.length,
    hasSidebar: !!document.querySelector('.sidebar, nav'),
    navButtons: Array.from(document.querySelectorAll('button, a')).map(b => (b.textContent||'').trim()).filter(t => t && t.length < 12).slice(0, 12),
  }))()`), null, 1));

  console.log("\n=== [2] 逐页检查 ===");
  const pages = await evalJs(`(() => {
    // 找导航按钮
    const navs = Array.from(document.querySelectorAll('button, a')).filter(b => /监控|话术|设置|历史|报告/.test((b.textContent||'').trim()));
    return navs.map(n => (n.textContent||'').trim());
  })()`);
  console.log("导航项:", JSON.stringify(pages));

  for (const label of pages || []) {
    const r = await evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button, a')).find(b => (b.textContent||'').trim() === ${JSON.stringify(label)});
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()`);
    if (!r.found) continue;
    await new Promise((res) => setTimeout(res, 700));
    const info = await evalJs(`(() => {
      const t = document.body.innerText;
      return {
        len: t.length,
        text: t.replace(/\\n+/g, ' | ').slice(0, 220),
        passwordInputs: document.querySelectorAll('input[type=password]').length,
        allInputs: document.querySelectorAll('input, textarea, select').length,
      };
    })()`);
    console.log(`\n--- ${label} ---`);
    console.log("  内容长度:", info.len, "| 输入框:", info.allInputs, "| 密码框:", info.passwordInputs);
    console.log("  文本:", info.text);
  }

  console.log("\n=== [3] 设置页密钥输入框（客户最关心）===");
  await evalJs(`(() => {
    const btn = Array.from(document.querySelectorAll('button, a')).find(b => /设置/.test((b.textContent||'').trim()));
    if (btn) btn.click();
  })()`);
  await new Promise((res) => setTimeout(res, 900));
  console.log(JSON.stringify(await evalJs(`(() => {
    const pw = Array.from(document.querySelectorAll('input[type=password]'));
    const t = document.body.innerText;
    return {
      passwordInputCount: pw.length,
      anyDisabled: pw.some(i => i.disabled),
      disabledCount: pw.filter(i => i.disabled).length,
      hasSaveSecretBtn: Array.from(document.querySelectorAll('button')).some(b => /保存密钥/.test(b.textContent||'')),
      hasPlaintextWarn: /明文/.test(t),
      hasEnvOnlyText: /请改用环境变量启动/.test(t),
      calibrationWarn: /未标定/.test(t),
    };
  })()`), null, 1));

  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
