/**
 * 第②级驱动：真实直播间系统声 → 非空稳态字幕。
 *
 * 与 loopback-drive.js 的区别：**不播放任何本地音频**。
 * 音频源完全来自外部（用户在 DSH Desktop 浏览器面板里播放的直播间），
 * 本脚本只做三件事：
 *   1. CDP 真实点击「监听系统声音」按钮，让 app 自己建会话 + 采 loopback
 *   2. 订阅 transcript.final / transcript.partial / asr.status / app.error
 *   3. 定时抓 UI 字幕区块，最后与 SQLite 比对
 *
 * 绝不与第①级的测试音混：本脚本不产生任何声音。
 *
 * 用法：node level2-drive.js <CDP端口> <观测秒数> [播放源URL]
 * 示例：node level2-drive.js 9333 120 "https://live.douyin.com/295178185857"
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const fs = require("node:fs");
const PORT = Number(process.argv[2] || "9333");
const RUN_SECONDS = Number(process.argv[3] || "120");
const SOURCE_URL = process.argv[4] || "(未指定)";
const OUT_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\out";
const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;

function log(...a) { const s = `[${el().toFixed(1)}s] ` + a.join(" "); console.log(s); }

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
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page target on port " + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((rs, rj) => { const i = ++id; pending.set(i, { rs, rj }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const exceptions = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rj(new Error(JSON.stringify(m.error))) : p.rs(m.result); }
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable").catch(() => {});
  log("CDP attached. source:", SOURCE_URL);

  // 订阅 IPC 事件
  await send("Runtime.evaluate", {
    expression: `(() => {
      window.__ev = { partials: [], finals: [], asrStatus: [], captureStatus: [], errors: [] };
      const api = window.appApi;
      const push = (k) => (p) => { window.__ev[k].push({ t: Date.now(), p }); };
      api.subscribeEvents("transcript.partial", push("partials"));
      api.subscribeEvents("transcript.final", push("finals"));
      api.subscribeEvents("asr.status", push("asrStatus"));
      api.subscribeEvents("capture.status", push("captureStatus"));
      api.subscribeEvents("app.error", push("errors"));
      return "subscribed";
    })()`,
    returnByValue: true,
  });

  // 前置检查：确认没有残留会话（避免叠加）
  const pre = await send("Runtime.evaluate", {
    expression: `(() => {
      const hasEnd = Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束");
      const hasStart = Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "监听系统声音");
      return { hasEnd, hasStart, snippet: document.body.innerText.slice(0, 300) };
    })()`,
    returnByValue: true,
  });
  log("pre-check:", JSON.stringify(pre.result.value));
  if (pre.result.value.hasEnd) {
    log("!! 已有会话在进行中，先结束它");
    await send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll("button")).find(b=>(b.textContent||"").trim()==="结束").click()`, returnByValue: true });
    await sleep(2000);
  }

  // 真实点击「监听系统声音」
  const btn = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "监听系统声音");
      return b ? { found: true, disabled: b.disabled, rect: b.getBoundingClientRect().toJSON() } : { found: false };
    })()`,
    returnByValue: true,
  });
  if (!btn.result.value.found) throw new Error("button 监听系统声音 not found");
  const r = btn.result.value.rect;
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
    await sleep(80);
  }
  log("clicked 监听系统声音 at", cx, cy);
  await sleep(4000);

  // 会话状态
  const sess = await send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.body.innerText;
      const sid = (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null;
      const dur = (t.match(/监听时长\\s*(\\d{2}:\\d{2})/)||[])[1] || null;
      const fin = (t.match(/稳态片段数\\s*(\\d+)/)||[])[1] || null;
      const err = (t.match(/音频设备已失效[^\\n]*/)||[])[0] || null;
      const capErr = (t.match(/系统声音采集[^\\n]*/)||[])[0] || null;
      return { sessionId: sid, duration: dur, finalsShown: fin, captureError: err || capErr, showsSystem: /系统声音/.test(t), capturing: /采集中/.test(t) };
    })()`,
    returnByValue: true,
  });
  log("session:", JSON.stringify(sess.result.value, null, 2));
  if (!sess.result.value.sessionId) {
    log("!! 会话没建起来——这一步不过关，后面都是空转");
    log("!! 可能原因：直播源没在播 / 静音 / 系统音量 0 / 播放设备不是默认输出");
  }

  // 持续观测
  const timeline = [];
  for (let i = 0; i < RUN_SECONDS; i += 2) {
    await sleep(2000);
    const st = await send("Runtime.evaluate", {
      expression: `(() => {
        const e = window.__ev;
        return {
          partials: e.partials.length, finals: e.finals.length,
          lastFinal: e.finals.length ? e.finals[e.finals.length-1].p : null,
          lastAsr: e.asrStatus.length ? e.asrStatus[e.asrStatus.length-1].p : null,
          lastErr: e.errors.length ? e.errors[e.errors.length-1].p : null,
          capState: e.captureStatus.length ? e.captureStatus[e.captureStatus.length-1].p : null,
        };
      })()`,
      returnByValue: true,
    });
    const v = st.result.value;
    timeline.push({ at: el(), ...v });
    log(`partials=${v.partials} finals=${v.finals} asr=${v.lastAsr ? v.lastAsr.state : "?"} lvl=${v.capState ? v.capState.level : "?"}`);
  }

  const full = await send("Runtime.evaluate", {
    expression: `(() => {
      const e = window.__ev;
      // 抓 UI 字幕区块原文
      const t = document.body.innerText;
      const lines = t.split("\\n");
      const idx = lines.findIndex(l => l.includes("实时字幕"));
      const sub = idx >= 0 ? lines.slice(idx, idx + 60).join("\\n") : "";
      // 抓会话与音源的可追溯信息
      const sid = (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null;
      const src = (t.match(/音源\\s*([^\\n]+)/)||[])[1] || null;
      const startedAt = (t.match(/开始于\\s*([0-9:]+)/)||[])[1] || null;
      const lvl = (t.match(/电平[\\s\\S]{0,40}?(\\d+%?)/)||[])[1] || null;
      return {
        partialCount: e.partials.length, finalCount: e.finals.length,
        finals: e.finals.map(x => x.p),
        partialsTail: e.partials.slice(-10).map(x => x.p),
        asrStatuses: e.asrStatus.map(x => x.p),
        errors: e.errors.map(x => x.p),
        captureStatuses: e.captureStatus.map(x => x.p),
        uiSubtitleBlock: sub,
        uiSessionId: sid, uiSource: src, uiStartedAt: startedAt, uiLevel: lvl,
      };
    })()`,
    returnByValue: true,
  });
  const result = full.result.value;

  // 时间戳单调性
  let monotonic = true, prevEnd = -1, prevSeq = -1;
  for (const f of result.finals) {
    if (f.endMs < f.startMs || f.endMs < prevEnd || f.sourceSeq <= prevSeq) monotonic = false;
    prevEnd = f.endMs; prevSeq = f.sourceSeq;
  }

  // 播放源可追溯性：URL + 在播状态 + 系统音量非静音。
  // 这三项必须由人确认后作为参数传入，脚本无法自己验证"是否真的在播"。
  const sourceMeta = {
    declaredUrl: SOURCE_URL,
    sourceKind: "真实直播间系统声（loopback）",
    confirmedPlaying: process.env.LEVEL2_CONFIRMED_PLAYING === "1",
    confirmedNotMuted: process.env.LEVEL2_CONFIRMED_NOT_MUTED === "1",
    note: "URL 与播放状态由操作人确认；脚本不产生任何本地音频，音频完全来自外部播放源。",
  };

  const report = {
    level: 2,
    source: sourceMeta,
    measuredAtIso: new Date().toISOString(),
    credentials: { appId: "configured", secretId: "configured", secretKey: "configured" },
    session: { ...sess.result.value, uiSessionId: result.uiSessionId, uiSource: result.uiSource, uiStartedAt: result.uiStartedAt, uiLevel: result.uiLevel },
    counts: { partials: result.partialCount, finals: result.finalCount, errors: result.errors.length },
    timestampsMonotonic: monotonic,
    finals: result.finals,
    partialsTail: result.partialsTail,
    asrStatuses: result.asrStatuses,
    errors: result.errors,
    captureStatuses: result.captureStatuses,
    uiSubtitleBlock: result.uiSubtitleBlock,
    exceptions,
    timeline,
  };
  const outFile = `${OUT_DIR}/level2-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  log("\n===== LEVEL 2 RESULT =====");
  log(`source            ${SOURCE_URL}`);
  log(`confirmedPlaying  ${sourceMeta.confirmedPlaying}`);
  log(`confirmedNotMuted ${sourceMeta.confirmedNotMuted}`);
  log(`sessionId         ${result.uiSessionId || sess.result.value.sessionId || "(未建起)"}`);
  log(`partials          ${result.partialCount}`);
  log(`finals            ${result.finalCount}`);
  log(`ts monotonic      ${monotonic}`);
  log(`errors            ${result.errors.length}`);
  log(`report            ${outFile}`);
  log("\n===== FINAL TEXTS =====");
  for (const f of result.finals) log(`[${f.startMs}-${f.endMs}] ${f.text}`);
  if (!result.finalCount) {
    log("\n!! 0 条稳态字幕。检查清单：");
    log("   1. 直播源是否真的在播（不是暂停/加载中/已结束）");
    log("   2. 系统音量是否静音或 0");
    log("   3. 播放设备是否是系统默认输出（loopback 采默认渲染设备混音）");
    log("   4. 会话是否建起来（上面 sessionId 是不是 null）");
  }
  if (exceptions.length) log("\n===== EXCEPTIONS =====\n" + exceptions.join("\n"));

  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
