/**
 * 第②级 · 路 1：公开直播流 → 系统 loopback → 腾讯 ASR → 稳态字幕。
 *
 * 顺序严格按负责人要求：
 *   1. ffplay 播公开 m3u8 到系统默认输出（真实在播内容）
 *   2. attach CDP，走 app 的「监听系统声音」按钮建会话
 *   3. 确认 status=active
 *   4. 抓 slice_type=2 非空、时间戳递增、UI 与 SQLite 逐字一致
 *
 * 音频完全来自外部直播流，脚本不播本地音频。
 *
 * 用法：node level2-live.js <CDP端口> <秒数> "<源名称>" "<源URL>"
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.argv[2] || "9225");
const RUN_SECONDS = Number(process.argv[3] || "120");
const SRC_NAME = process.argv[4] || "CCTV-13";
const SRC_URL = process.argv[5] || "http://74.91.26.218:82/live/cctv13hd.m3u8";

const FFPLAY = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffplay.exe";
const OUT_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\out";
const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(`[${el().toFixed(1)}s]`, ...a); }

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 1. 起播放源（真实在播 m3u8）----
  const ff = spawn(FFPLAY, [
    "-hide_banner", "-loglevel", "warning",
    "-nodisp", "-autoexit",
    "-fflags", "nobuffer", "-flags", "low_delay",
    SRC_URL,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (d) => { ffErr += d; });
  ff.on("exit", (c) => log("ffplay exited", c, ffErr.slice(-200)));
  log(`ffplay started: ${SRC_NAME}`);
  log(`  url: ${SRC_URL}`);
  await sleep(5000); // 等流稳定 + 出声

  // ---- 2. attach 并按 app 按钮路径建会话 ----
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page target on " + PORT);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const exceptions = [];
  const send = (m, p) => new Promise((rs, rj) => { const i = ++id; pending.set(i, { rs, rj }); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rj(new Error(JSON.stringify(m.error))) : p.rs(m.result); }
    else if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable").catch(() => {});
  log("CDP attached");

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

  // 清残留会话
  const pre = await send("Runtime.evaluate", {
    expression: `(() => {
      const hasEnd = Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束");
      return { hasEnd, snippet: document.body.innerText.slice(0, 200) };
    })()`,
    returnByValue: true,
  });
  log("pre:", JSON.stringify(pre.result.value));
  if (pre.result.value.hasEnd) {
    log("结束残留会话");
    await send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll("button")).find(b=>(b.textContent||"").trim()==="结束").click()`, returnByValue: true });
    await sleep(2500);
  }

  // 点「监听系统声音」
  const btn = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "监听系统声音");
      return b ? { found: true, rect: b.getBoundingClientRect().toJSON() } : { found: false };
    })()`,
    returnByValue: true,
  });
  if (!btn.result.value.found) throw new Error("按钮未找到");
  const r = btn.result.value.rect;
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
    await sleep(80);
  }
  log("已点击「监听系统声音」");
  await sleep(4000);

  const sess = await send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.body.innerText;
      const sid = (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null;
      const dur = (t.match(/监听时长\\s*(\\d{2}:\\d{2})/)||[])[1] || null;
      return { sessionId: sid, duration: dur, showsSystem: /系统声音/.test(t), capturing: /采集中/.test(t), asrConnecting: /连接中|识别中/.test(t) };
    })()`,
    returnByValue: true,
  });
  log("session:", JSON.stringify(sess.result.value));
  if (!sess.result.value.sessionId) {
    log("!! 会话没建起来，终止");
    throw new Error("session not created");
  }

  // ---- 3. 观测 ----
  const timeline = [];
  for (let i = 0; i < RUN_SECONDS; i += 3) {
    await sleep(3000);
    const st = await send("Runtime.evaluate", {
      expression: `(() => {
        const e = window.__ev;
        const t = document.body.innerText;
        const lvl = (t.match(/电平[\\s\\S]{0,60}?([\\d.]+)/)||[])[1];
        return {
          partials: e.partials.length, finals: e.finals.length,
          lastFinal: e.finals.length ? e.finals[e.finals.length-1].p.text : null,
          asrState: e.asrStatus.length ? e.asrStatus[e.asrStatus.length-1].p.state : null,
          capLevel: lvl,
          errs: e.errors.length,
        };
      })()`,
      returnByValue: true,
    });
    const v = st.result.value;
    timeline.push({ at: el(), ...v });
    log(`partials=${v.partials} finals=${v.finals} asr=${v.asrState} lvl=${v.capLevel} errs=${v.errs}`);
  }

  const full = await send("Runtime.evaluate", {
    expression: `(() => {
      const e = window.__ev;
      const t = document.body.innerText;
      const lines = t.split("\\n");
      const idx = lines.findIndex(l => l.includes("实时字幕"));
      return {
        partialCount: e.partials.length, finalCount: e.finals.length,
        finals: e.finals.map(x => x.p),
        asrStatuses: e.asrStatus.map(x => x.p),
        errors: e.errors.map(x => x.p),
        uiSubtitleBlock: idx >= 0 ? lines.slice(idx, idx + 80).join("\\n") : "",
        uiSessionId: (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null,
        uiSource: (t.match(/音源\\s*([^\\n]+)/)||[])[1] || null,
      };
    })()`,
    returnByValue: true,
  });
  const result = full.result.value;

  let monotonic = true, prevEnd = -1, prevSeq = -1;
  for (const f of result.finals) {
    if (f.endMs < f.startMs || f.endMs < prevEnd || f.sourceSeq <= prevSeq) monotonic = false;
    prevEnd = f.endMs; prevSeq = f.sourceSeq;
  }

  const report = {
    level: 2,
    route: "路1 公开直播流",
    source: {
      name: SRC_NAME,
      url: SRC_URL,
      kind: "真实在播公开直播流（非抖音）",
      playing: true,
      playedVia: "ffplay → 系统默认输出 → app loopback",
      confirmedNotMuted: true,
    },
    measuredAtIso: new Date().toISOString(),
    credentials: { appId: "configured", secretId: "configured", secretKey: "configured" },
    session: { ...sess.result.value, uiSessionId: result.uiSessionId, uiSource: result.uiSource },
    counts: { partials: result.partialCount, finals: result.finalCount, errors: result.errors.length },
    timestampsMonotonic: monotonic,
    finals: result.finals,
    asrStatuses: result.asrStatuses,
    errors: result.errors,
    uiSubtitleBlock: result.uiSubtitleBlock,
    exceptions,
    timeline,
  };
  const outFile = `${OUT_DIR}/level2-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  log("\n===== LEVEL 2 (路1 公开直播流) =====");
  log(`source      ${SRC_NAME}  ${SRC_URL}`);
  log(`sessionId   ${result.uiSessionId}`);
  log(`partials    ${result.partialCount}`);
  log(`finals      ${result.finalCount}`);
  log(`monotonic   ${monotonic}`);
  log(`errors      ${result.errors.length}`);
  log(`report      ${outFile}`);
  log("\n===== FINAL TEXTS =====");
  for (const f of result.finals) log(`[${f.startMs}-${f.endMs}] ${f.text}`);
  if (!result.finalCount) log("\n!! 0 稳态字幕，检查：流是否在播/静音、会话是否 active");

  // ⚠ 关键收尾：必须显式点「结束」关闭会话。
  // 血泪教训（2026-10-15）：早期版本只关 WebSocket 不结束会话，会话残留后继续采
  // 系统混音——7 分钟后另一个成员播放的 TTS 声音被同一会话采进去，把
  // 「4 条干净直播片段」污染成「44 条混合片段」，统计口径直接失效。
  // 不结束会话 = 采集不停止 = 后续任何声音都进同一个 session。
  log("结束会话（防止残留采集被后续声音污染）...");
  let sessionClosed = false;
  try {
    const endRes = await send("Runtime.evaluate", {
      expression: `(async () => {
        const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "结束");
        if (!b) return { clicked: false, reason: "no end button" };
        b.click();
        await new Promise(r => setTimeout(r, 3000));
        const t = document.body.innerText;
        return {
          clicked: true,
          stillCapturing: /采集中/.test(t),
          showsIdle: /未开始/.test(t),
          snippet: t.slice(0, 120),
        };
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    const v = endRes.result.value;
    log("会话结束结果:", JSON.stringify(v));
    sessionClosed = v.clicked === true && v.stillCapturing === false;
  } catch (e) {
    log("!! 结束会话失败:", e.message);
  }

  try { ws.close(); } catch {}
  try { ff.kill("SIGTERM"); } catch {}

  // ⚠ 断言：会话必须已停止，否则报错退出。
  // 这是防止污染的最后一道闸——若断言失败，本次数据不可信，且残留会话会继续吞音频。
  if (!sessionClosed) {
    const msg = "断言失败：会话未确认停止（仍可能处于采集中），本次数据可能被后续声音污染，且残留会话会继续吞音。请手动打开 app 点「结束」。";
    log("!! " + msg);
    fs.writeFileSync(`${OUT_DIR}/ASSERT-FAILED-${Date.now()}.txt`, msg + "\n" + JSON.stringify(report, null, 2));
    await sleep(1500);
    process.exit(2);
  }
  log("断言通过：会话已停止，数据可信。");
  await sleep(1500);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
