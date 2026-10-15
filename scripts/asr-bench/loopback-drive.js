/**
 * 真实 loopback 采集驱动：
 *   1. 通过 CDP 真实点击页面上「监听系统声音」按钮（带 userGesture），
 *      让 app 自己的 startLoopbackCapture 去 getDisplayMedia。
 *   2. 音频源：把 scripts/asr-bench/audio 里的中文 WAV
 *      推到 VB-CABLE Input，loopback 从 CABLE Output 采回。
 *
 * 为什么不用探针自建管线：orchestrator.ingestAudio() 第一行
 *   if (this.status !== "active" || !this.sessionId) return;
 * 不走 app 按钮就不会建会话，主进程会丢掉所有音频帧——那样只能证明
 * 渲染层收到帧，证明不了 ASR 出字。
 *
 * userGesture 陷阱（CDP）：Runtime.evaluate 的 userGesture 只在该次表达式
 * 执行期内授予手势。若表达式只做 button.click()，click 是同步派发，应该能
 * 传进去；但为了稳妥，这里先尝试用 CDP Input.dispatchMouseEvent 真实点击，
 * 失败再退化为同表达式 userGesture 调用。
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const PORT = Number(process.argv[2] || "9333");
const RUN_SECONDS = Number(process.argv[3] || "120");
const AUDIO_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\audio";
const FFMPEG = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe";
const OUT_LOG = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\loopback-run.log";
const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;

function log(...a) { const s = `[${el().toFixed(1)}s] ` + a.join(" "); console.log(s); fs.appendFileSync(OUT_LOG, s + "\n"); }

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function main() {
  fs.writeFileSync(OUT_LOG, "");
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const consoleMsgs = [];
  const exceptions = [];
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
      const args = (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ");
      if (/error|ASR|transcript|capture|app\b/i.test(args)) consoleMsgs.push(`[${msg.params.type}] ${args}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await send("Page.enable").catch(() => {});
  log("CDP attached to", page.url);

  // ---- 1. 打开 ffmpeg 把中文 WAV 推到 CABLE Input ----
  const files = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".wav")).sort();
  // Chromium 的 loopback 采集的是「系统默认渲染设备的混音」，所以只要
  // 默认播放设备有声音出来，loopback 就能采到——不一定要经过 CABLE。
  // 这里直接用 ffplay 播放合并后的中文语音，目标就是系统默认输出。
  const FFPLAY = FFMPEG.replace(/ffmpeg\.exe$/, "ffplay.exe");
  const merged = path.join(AUDIO_DIR, "merged.wav");
  const listFile = path.join(AUDIO_DIR, "playlist.txt");
  fs.writeFileSync(listFile, files.map((f) => "file '" + f + "'").join("\n"), "utf8");
  await new Promise((resolve, reject) => {
    const m = spawn(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-ar", "48000", "-ac", "2", merged], { stdio: ["ignore", "pipe", "pipe"] });
    let e = ""; m.stderr.on("data", (d) => (e += d));
    m.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("merge failed: " + e))));
  });
  log("merged wav:", (fs.statSync(merged).size / 1024 / 1024).toFixed(1), "MB");

  const ff = spawn(FFPLAY, [
    "-hide_banner", "-loglevel", "warning",
    "-nodisp", "-loop", "0", "-autoexit",
    merged,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (d) => { ffErr += d; });
  ff.on("exit", (c) => log("ffplay exited", c, ffErr.slice(0, 300)));
  log("ffplay started, looping chinese speech wav to default output device");
  await new Promise((r) => setTimeout(r, 2000));

  // ---- 2. 订阅 app 的 IPC 事件，抓字幕与状态 ----
  await send("Runtime.evaluate", {
    expression: `(() => {
      window.__ev = { partials: [], finals: [], asrStatus: [], captureStatus: [], errors: [], session: null };
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

  // ---- 3. 真实点击「监听系统声音」按钮 ----
  const before = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "监听系统声音");
      return b ? { found: true, disabled: b.disabled, rect: b.getBoundingClientRect().toJSON() } : { found: false };
    })()`,
    returnByValue: true,
  });
  log("before click:", JSON.stringify(before.result.value));

  if (!before.result.value.found) throw new Error("button 监听系统声音 not found");

  // 方式 A：CDP 物理鼠标点击（Chromium 侧是真实输入，userGesture 应为 true）
  const r = before.result.value.rect;
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x: cx, y: cy, button: "left", clickCount: 1,
      buttons: type === "mouseReleased" ? 0 : 1,
    });
    await new Promise((res) => setTimeout(res, 80));
  }
  log("dispatched real mouse click at", cx, cy);
  await new Promise((res) => setTimeout(res, 4000));

  // 检查会话是否建起来（这是关键判据，不能只看电平）
  const after = await send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.body.innerText;
      const m1 = t.match(/(\\d{2}):(\\d{2})/);
      const lvl = document.querySelectorAll("input[type=range]");
      return {
        hasTimer: !!m1,
        timerText: m1 ? m1[0] : null,
        showsSystem: /系统声音/.test(t),
        asrState: (t.match(/ASR[\\s\\S]{0,30}?([未连接|已连接|连接中|重连|错误][^\\n]*)/) || [])[1] || null,
        bodySnippet: t.slice(0, 600),
      };
    })()`,
    returnByValue: true,
  });
  log("after click:", JSON.stringify(after.result.value, null, 2));

  // ---- 4. 持续观测 ----
  const samples = [];
  for (let i = 0; i < RUN_SECONDS; i += 2) {
    await new Promise((res) => setTimeout(res, 2000));
    const st = await send("Runtime.evaluate", {
      expression: `(() => {
        const e = window.__ev;
        return {
          partials: e.partials.length,
          finals: e.finals.length,
          lastFinal: e.finals.length ? e.finals[e.finals.length-1].p : null,
          lastAsr: e.asrStatus.length ? e.asrStatus[e.asrStatus.at(-1)].p : null,
          lastErr: e.errors.length ? e.errors[e.errors.at(-1)].p : null,
        };
      })()`,
      returnByValue: true, awaitPromise: false,
    });
    const v = st.result.value;
    samples.push({ at: el(), ...v });
    log(`partials=${v.partials} finals=${v.finals} asr=${v.lastAsr ? v.lastAsr.state : "?"}`);
  }

  const final = await send("Runtime.evaluate", {
    expression: `(() => {
      const e = window.__ev;
      return {
        partialCount: e.partials.length, finalCount: e.finals.length,
        finals: e.finals.map(x => x.p),
        partialsTail: e.partials.slice(-8).map(x => x.p),
        asrStatuses: e.asrStatus.map(x => x.p),
        errors: e.errors.map(x => x.p),
        captureStatuses: e.captureStatus.map(x => x.p),
      };
    })()`,
    returnByValue: true,
  });
  const result = final.result.value;
  log("\n===== RESULT =====");
  log(JSON.stringify({
    partialCount: result.partialCount, finalCount: result.finalCount,
    finals: result.finals, asrStates: result.asrStatuses.map((s) => s && s.state),
    errors: result.errors, consoleMsgs, exceptions,
  }, null, 2));
  fs.writeFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\loopback-result.json", JSON.stringify({ result, samples, at: new Date().toISOString() }, null, 2));

  try { ws.close(); } catch {}
  try { ff.kill("SIGINT"); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
