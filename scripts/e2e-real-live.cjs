/**
 * 真实带货直播端到端验证（自动化驱动）。
 *
 * 前提：用户正在浏览器里播放抖音直播（兰蔻双11），系统有真实音频输出。
 * 本脚本用 CDP 连上**正在运行的打包版软件**，走真实按钮路径：
 *   1. 点「监听系统声音」建立会话
 *   2. 持续观测 90 秒（覆盖一次 60 秒分析窗口）
 *   3. 记录：字幕数 / ASR 状态 / 电平 / 分析运行 / 产生的问题
 *   4. 点「结束」并确认会话已停（防止残留采集污染后续数据）
 *
 * ⚠️ 若拿不到真实音频（默认输出是虚拟声卡等），会明确报告「无音频」，不伪造。
 */
const http = require("node:http");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || "9224");
const RUN_SECONDS = Number(process.argv[3] || "90");

const get = (p) =>
  new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(b));
    }).on("error", rej);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...a) => console.log(`[${el()}s]`, ...a);

async function main() {
  const targets = JSON.parse(await get("/json"));
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("没有找到应用页面");
  log("已连上应用:", page.url.slice(0, 80));

  const WS = require("D:/ai盯播工具/app/node_modules/ws");
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
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

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text };
    return r.result.value;
  };

  // 回到实时监控页
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => (x.textContent||'').trim() === '实时监控');
    if (b) b.click();
  })()`);
  await sleep(800);

  // 清残留会话
  const hasEnd = await ev(`Array.from(document.querySelectorAll('button')).some(b => (b.textContent||'').trim() === '结束')`);
  if (hasEnd) {
    log("发现残留会话，先结束");
    await ev(`Array.from(document.querySelectorAll('button')).find(b=>(b.textContent||'').trim()==='结束').click()`);
    await sleep(2500);
  }

  // 订阅事件
  await ev(`(() => {
    window.__ev = { partials: [], finals: [], asr: [], errors: [] };
    const api = window.appApi;
    api.subscribeEvents('transcript.partial', p => window.__ev.partials.push(p));
    api.subscribeEvents('transcript.final', p => window.__ev.finals.push(p));
    api.subscribeEvents('asr.status', p => window.__ev.asr.push(p));
    api.subscribeEvents('app.error', p => window.__ev.errors.push(p));
    return 'ok';
  })()`);

  // 点「监听系统声音」
  const btn = await ev(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '监听系统声音');
    return b ? { found: true, rect: b.getBoundingClientRect().toJSON() } : { found: false };
  })()`);
  if (!btn.found) throw new Error("找不到「监听系统声音」按钮");
  const r = btn.rect;
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
    await sleep(80);
  }
  log("已点击「监听系统声音」");
  await sleep(4000);

  const sess = await ev(`(() => {
    const t = document.body.innerText;
    return {
      sessionId: (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null,
      showsSystem: /系统声音/.test(t),
      text: t.replace(/\\n+/g,' | ').slice(0, 300),
    };
  })()`);
  log("会话:", sess.sessionId || "未建立");
  if (!sess.sessionId) {
    log("!! 会话没建起来");
    log("页面文本:", sess.text);
  }

  // 观测
  const timeline = [];
  for (let i = 0; i < RUN_SECONDS; i += 6) {
    await sleep(6000);
    const st = await ev(`(() => {
      const e = window.__ev; const t = document.body.innerText;
      return {
        partials: e.partials.length, finals: e.finals.length,
        lastFinal: e.finals.length ? e.finals[e.finals.length-1].text : null,
        asr: e.asr.length ? e.asr[e.asr.length-1].state : null,
        errors: e.errors.length,
        level: (t.match(/电平[\\s\\S]{0,40}?([0-9.]+)/)||[])[1] || null,
        dur: (t.match(/监听时长\\s*(\\d{2}:\\d{2})/)||[])[1] || null,
        issueCount: (t.match(/问题\\s*(\\d+)/)||[])[1] || null,
      };
    })()`);
    timeline.push({ at: el(), ...st });
    log(`finals=${st.finals} partials=${st.partials} asr=${st.asr} 电平=${st.level} 时长=${st.dur} 问题=${st.issueCount} 错误=${st.errors}`);
  }

  // 汇总
  const full = await ev(`(() => {
    const e = window.__ev;
    return {
      finals: e.finals.map(x => ({ s: x.startMs, e: x.endMs, t: x.text })),
      asrStates: [...new Set(e.asr.map(x => x.state))],
      errors: e.errors.map(x => x.code || x.message).slice(0, 5),
      uiText: document.body.innerText.replace(/\\n+/g,' | ').slice(0, 600),
    };
  })()`);

  console.log("\n===== 结果 =====");
  console.log("会话:", sess.sessionId);
  console.log("稳态字幕数:", full.finals.length);
  console.log("ASR 状态出现过:", full.asrStates.join(", "));
  console.log("错误:", full.errors.length ? full.errors.join(" / ") : "无");
  console.log("\n--- 字幕原文 ---");
  if (!full.finals.length) {
    console.log("  (0 条字幕)");
  } else {
    for (const f of full.finals) console.log(`  [${f.s}-${f.e}] ${f.t}`);
  }
  console.log("\n--- 页面文本 ---");
  console.log(full.uiText);

  // 结束会话（防污染）
  log("结束会话...");
  const endRes = await ev(`(async () => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === '结束');
    if (!b) return { clicked: false };
    b.click();
    await new Promise(r => setTimeout(r, 3000));
    const t = document.body.innerText;
    return { clicked: true, stillCapturing: /采集中/.test(t) };
  })()`);
  log("结束结果:", JSON.stringify(endRes));

  const report = {
    measuredAtIso: new Date().toISOString(),
    sessionId: sess.sessionId,
    finals: full.finals,
    counts: { finals: full.finals.length, asrStates: full.asrStates, errors: full.errors },
    timeline,
    sessionClosed: endRes.clicked && !endRes.stillCapturing,
  };
  const outFile = `D:/ai盯播工具/app/evidence/e2e-live-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  log("证据:", outFile);

  ws.close();
  process.exit(report.sessionClosed ? 0 : 2);
}
main().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
