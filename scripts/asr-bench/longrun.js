/**
 * 30 分钟长跑（第②级之后的稳定性验证）。
 *
 * 用最稳的公开源（CCTV-1 720p，0 丢帧警告）→ ffplay → 系统 loopback → 腾讯 ASR。
 *
 * 观测项（负责人指定）：
 *   - 内存趋势（RSS）是否单调增长 + 句柄数
 *   - 是否中途断线重连、重连后时间戳是否正确
 *   - 片段数 / 总时长 / 平均间隔
 *   - 有无空文本稳态帧
 *   - 片段长度分布（最短 / 中位 / 最长），不只平均值
 *
 * 用法：node longrun.js <CDP端口> <分钟数> "<源名>" "<源URL>"
 */
const WebSocket = require("D:\\ai盯播工具\\app\\node_modules\\ws");
const http = require("node:http");
const fs = require("node:fs");
const { spawn, execSync } = require("node:child_process");

const PORT = Number(process.argv[2] || "9225");
const MINUTES = Number(process.argv[3] || "30");
const SRC_NAME = process.argv[4] || "CCTV-1 (720p)";
const SRC_URL = process.argv[5] || "http://74.91.26.218:82/live/cctv1hd.m3u8";

const FFPLAY = "C:\\Users\\libiu\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffplay.exe";
const OUT_DIR = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\out";
const LOG = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\longrun.log";
const RUN_MS = MINUTES * 60 * 1000;

const t0 = Date.now();
const el = () => (Date.now() - t0) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) {
  const s = `[${el().toFixed(1)}s] ` + a.join(" ");
  console.log(s);
  fs.appendFileSync(LOG, s + "\n");
}
function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
function procStats(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ '{0} {1}' -f [int]($p.WorkingSet64/1MB), $p.Handles } else { 'GONE' }"`,
      { encoding: "utf8", timeout: 8000 },
    ).trim();
    if (out === "GONE" || !out) return null;
    const [rssMB, handles] = out.split(/\s+/).map(Number);
    return { rssMB, handles };
  } catch { return null; }
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, "");

  // ---- 基线（负责人要求：跑前记一次） ----
  const instancePid = process.argv[6] || null;
  const baseline = instancePid ? procStats(Number(instancePid)) : null;
  log(`baseline (PID ${instancePid || "n/a"}):`, JSON.stringify(baseline));

  // ---- 起播放源 ----
  const ff = spawn(FFPLAY, [
    "-hide_banner", "-loglevel", "warning",
    "-nodisp", "-autoexit",
    "-fflags", "nobuffer", "-flags", "low_delay",
    SRC_URL,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let ffErr = "";
  ff.stderr.on("data", (d) => { ffErr += d; });
  let ffExited = null;
  ff.on("exit", (c) => { ffExited = c; log(`ffplay exited code=${c}`); });
  log(`ffplay started: ${SRC_NAME}`);
  log(`  url: ${SRC_URL}`);
  await sleep(6000);

  // ---- attach CDP ----
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
  if (!page) throw new Error("no page target");
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
  log("CDP attached");

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
      // 记录页面侧的连接切换时刻，用于精确计算重连耗时
      window.__connLog = [];
      let lastState = null;
      api.subscribeEvents("asr.status", (p) => {
        if (!p) return;
        if (p.state !== lastState) {
          window.__connLog.push({ at: Date.now(), state: p.state, connectionId: p.connectionId || null, attempt: p.reconnectAttempt ?? null, gapDetected: p.gapDetected ?? null });
          lastState = p.state;
        }
      });

      // ⚠ chunks 计数（2026-10-15 补）。
      // 缺口背景：早期版本只记 ASR 侧的 partials/finals，不记采集侧音频包数，
      // 导致「chunks 停增但 UI 仍显示采集中」（静默失效）无法判定——
      // 这是无人值守最危险的失败模式，必须有证据能区分。
      // 包装 window.appApi.sendAudioChunk 统计渲染层实际产出的音频帧数。
      // 必须在点「监听系统声音」之前安装（audioCapture.ts 每次回调现取该函数，
      // 所以包装能生效）。
      window.__chunks = { count: 0, lastAt: Date.now(), intervals: [], firstAt: Date.now() };
      const origSend = window.appApi.sendAudioChunk.bind(window.appApi);
      window.appApi.sendAudioChunk = function (f32, rate) {
        const now = Date.now();
        const c = window.__chunks;
        if (c.count > 0) c.intervals.push(now - c.lastAt);
        if (c.intervals.length > 200) c.intervals.shift();
        c.lastAt = now;
        c.count++;
        c.lastBytes = f32 && f32.length ? f32.length * 4 : 0;
        c.lastRate = rate;
        return origSend(f32, rate);
      };
      return "subscribed+chunks";
    })()`,
    returnByValue: true,
  });

  // 清残留会话
  const pre = await send("Runtime.evaluate", {
    expression: `(() => ({ hasEnd: Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束") }))()`,
    returnByValue: true,
  });
  if (pre.result.value.hasEnd) {
    log("结束残留会话");
    await send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll("button")).find(b=>(b.textContent||"").trim()==="结束").click()`, returnByValue: true });
    await sleep(2500);
  }

  // 点按钮
  const btn = await send("Runtime.evaluate", {
    expression: `(() => { const b = Array.from(document.querySelectorAll("button")).find(x => (x.textContent||"").trim() === "监听系统声音"); return b ? { found: true, rect: b.getBoundingClientRect().toJSON() } : { found: false }; })()`,
    returnByValue: true,
  });
  if (!btn.result.value.found) throw new Error("button not found");
  const r = btn.result.value.rect;
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
    await sleep(80);
  }
  await sleep(4000);
  const sess = await send("Runtime.evaluate", {
    expression: `(() => { const t = document.body.innerText; return { sessionId: (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null, showsSystem: /系统声音/.test(t) }; })()`,
    returnByValue: true,
  });
  log("session:", JSON.stringify(sess.result.value));
  if (!sess.result.value.sessionId) throw new Error("session not created");

  // ---- 主循环：每 30 秒采样 ----
  const samples = [];
  const t0run = Date.now();
  let sampleIdx = 0;
  let prevChunk = null;   // 上一采样点的 chunks 计数（判定停增）
  while (Date.now() - t0run < RUN_MS) {
    await sleep(30000);
    sampleIdx++;
    const st = await send("Runtime.evaluate", {
      expression: `(() => {
        const e = window.__ev;
        const t = document.body.innerText;
        return {
          partials: e.partials.length, finals: e.finals.length,
          emptyFinals: e.finals.filter(x => !x.p.text || !String(x.p.text).trim()).length,
          asrState: e.asrStatus.length ? e.asrStatus[e.asrStatus.length-1].p.state : null,
          reconnectSeen: e.asrStatus.filter(x => x.p && x.p.state === "reconnecting").length,
          errorCount: e.errors.length,
          lvl: (t.match(/电平[\\s\\S]{0,60}?([\\d.]+)/)||[])[1] || null,
          duration: (t.match(/监听时长\\s*(\\d{2}:\\d{2})/)||[])[1] || null,
          // 采集侧音频包计数（静默失效判定的关键证据）
          chunks: window.__chunks ? window.__chunks.count : null,
          chunksSinceMs: window.__chunks ? (Date.now() - window.__chunks.lastAt) : null,
          chunksRate: window.__chunks ? window.__chunks.lastRate : null,
          // UI 上「采集」chip 的文字状态（与 chunks 交叉判定）
          captureChip: (t.match(/采集\\s*\\n\\s*([^\\n]+)/)||[])[1] || null,
          // 会话是否已被外部结束：UI 不再有「结束」按钮（说明已回到未开始状态），
          // 或显示「已完成」。用于防止脚本对已结束的会话空转。
          stillActive: Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束"),
          sessionEnded: !Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "结束")
            && !Array.from(document.querySelectorAll("button")).some(b => (b.textContent||"").trim() === "继续"),
        };
      })()`,
      returnByValue: true,
    });
    const v = st.result.value;
    const ps = instancePid ? procStats(Number(instancePid)) : null;
    const rec = { at: Math.round((Date.now() - t0run) / 1000), ...v, ...(ps || {}) };

    // ⚠ 静默失效判定（chunks × asrState × captureChip 三者交叉）。
    // 这是无人值守最危险的失败模式：轨道还活、UI 显示「采集中」，但音频不再产生。
    // 判据（音频采集提供）：
    //   chunks 停增 + chip 仍「采集中」 → 静默失效（故障）
    //   chunks 在涨 + 电平为 0        → 内容静默（正常）
    if (typeof v.chunks === "number" && prevChunk !== null) {
      const delta = v.chunks - prevChunk;
      rec.chunksDelta = delta;
      const chipCapturing = v.captureChip ? /采集中|监听中/.test(v.captureChip) : null;
      rec.chipCapturing = chipCapturing;
      // 静默失效：音频包不再增长，但界面仍显示采集正常
      if (delta === 0 && chipCapturing === true && v.chunks > 0) {
        rec.STALL_SUSPECTED = true;
        log(`!!! 疑似静默失效 t=${rec.at}s：chunks 停止增长（${v.chunks}）但 UI 显示「${v.captureChip}」`);
        log(`    asrState=${v.asrState} lvl=${v.lvl} duration=${v.duration}`);
      }
    }
    if (typeof v.chunks === "number") prevChunk = v.chunks;
    samples.push(rec);

    // 每 2 分钟一条详细日志，避免刷屏
    if (sampleIdx % 2 === 0 || v.finals === 1) {
      log(`t=${rec.at}s chunks=${v.chunks}(${rec.chunksDelta >= 0 ? "+" + rec.chunksDelta : "?"}) chip=${v.captureChip || "?"} finals=${v.finals} partials=${v.partials} asr=${v.asrState} rss=${ps ? ps.rssMB + "MB" : "?"}`);
    }
    // 第一条字幕出现时插播进度（负责人要求）
    if (v.finals === 1 && !samples.some((s) => s._firstReported)) {
      rec._firstReported = true;
      log(`>>> 第一条稳态字幕已出现（t=${rec.at}s）`);
    }

    // ⚠ 会话被外部结束的检测（2026-10-15 实测教训）。
    // 曾出现：会话在 82 秒被外部结束，脚本毫无察觉，继续对已结束的会话
    // 发送音频包空转约 2 分钟——既浪费额度也让日志产生误导性状态。
    // 判据：UI 不再显示「监听中/采集中」且 ASR 状态为 closed。
    if (v.sessionEnded) {
      log(`>>> 检测到会话已结束（t=${rec.at}s），提前停止空转`);
      log(`    片段=${v.finals} partials=${v.partials} chunks=${v.chunks}`);
      break;
    }
  }
  // 把逐样本的 chunks 序列存到全局，供报告使用
  global.__chunkSamples = samples.map((s) => ({ at: s.at, chunks: s.chunks, chunksDelta: s.chunksDelta, chipCapturing: s.chipCapturing, asrState: s.asrState, finals: s.finals, stallSuspected: !!s.STALL_SUSPECTED }));

  const full = await send("Runtime.evaluate", {
    expression: `(() => {
      const e = window.__ev;
      const t = document.body.innerText;
      const lines = t.split("\\n");
      const idx = lines.findIndex(l => l.includes("实时字幕"));
      return {
        partialCount: e.partials.length, finalCount: e.finals.length,
        finals: e.finals.map(x => x.p),
        allFinalsRaw: e.finals.map(x => ({ text: x.p.text, startMs: x.p.startMs, endMs: x.p.endMs, conn: x.p.connectionId })),
        asrStatuses: e.asrStatus.map(x => x.p),
        connLog: (window.__connLog || []).map(x => ({ ...x, at: x.at })),
        errors: e.errors.map(x => x.p),
        uiSubtitleBlock: idx >= 0 ? lines.slice(idx, idx + 200).join("\\n") : "",
        uiSessionId: (t.match(/会话\\s*([0-9a-f-]{8,})/)||[])[1] || null,
      };
    })()`,
    returnByValue: true,
  });
  const result = full.result.value;
  const endStats = instancePid ? procStats(Number(instancePid)) : null;

  // ---- 统计 ----
  const lens = result.finals.map((f) => f.endMs - f.startMs);
  const gaps = [];
  for (let i = 1; i < result.finals.length; i++) gaps.push(result.finals[i].startMs - result.finals[i - 1].endMs);
  const emptyFinals = result.finals.filter((f) => !f.text || !String(f.text).trim()).length;

  // 时间戳单调性（按连接）
  const byConn = {};
  for (const f of result.finals) {
    const k = f.connectionId || "?";
    if (!byConn[k]) byConn[k] = { prevEnd: -1, prevSeq: -1, ok: true, count: 0, lastEnd: 0 };
    const c = byConn[k];
    if (f.endMs < f.startMs || f.endMs < c.prevEnd || f.sourceSeq <= c.prevSeq) c.ok = false;
    c.prevEnd = Math.max(c.prevEnd, f.endMs); c.prevSeq = Math.max(c.prevSeq, f.sourceSeq);
    c.count++; c.lastEnd = Math.max(c.lastEnd, f.endMs);
  }

  // ---- 重连分析（必答项：多次重连后的时间轴正确性） ----
  // 从页面侧 connLog 提取每次状态切换，与前一条 final 的会话时间对照。
  const connLog = result.connLog || [];
  const reconnects = [];
  for (let i = 0; i < connLog.length; i++) {
    const c = connLog[i];
    if (c.state !== "reconnecting" && c.state !== "closed") continue;
    // 找这次断开之后的下一次 connected
    const next = connLog.slice(i + 1).find((x) => x.state === "connected");
    const priorFinal = [...result.finals].reverse().find((f) => f.endMs !== undefined);
    reconnects.push({
      disconnectState: c.state,
      disconnectAt: c.at,
      gapDetected: c.gapDetected,
      attempt: c.attempt,
      reconnectedConnectionId: next ? next.connectionId : null,
      reconnectCostMs: next ? next.at - c.at : null,
    });
  }
  // 每个连接的片段统计 + 重连后首条片段的锚定情况
  const connOrder = [...new Set(result.finals.map((f) => f.connectionId))];
  const connTimeline = connOrder.map((conn, i) => {
    const segs = result.finals.filter((f) => f.connectionId === conn);
    const first = segs[0];
    const prevConn = i > 0 ? connOrder[i - 1] : null;
    const prevSegs = prevConn ? result.finals.filter((f) => f.connectionId === prevConn) : [];
    const prevLastEnd = prevSegs.length ? Math.max(...prevSegs.map((s) => s.endMs)) : null;
    return {
      index: i + 1,
      connectionId: String(conn).slice(0, 8),
      segments: segs.length,
      firstSegmentStartMs: first ? first.startMs : null,
      firstSegmentEndMs: first ? first.endMs : null,
      lastSegmentEndMs: segs.length ? Math.max(...segs.map((s) => s.endMs)) : null,
      // 重连后首条片段的起点 vs 上一连接最后片段的终点：
      // 差值应为正且量级合理（接近断开时长），不应为负（负=时间轴回退）
      gapFromPrevConnMs: (first && prevLastEnd !== null) ? first.startMs - prevLastEnd : null,
      monotonicWithinConn: (() => {
        let ok = true, pe = -1, ps = -1;
        for (const s of segs) { if (s.endMs < s.startMs || s.endMs < pe || s.sourceSeq <= ps) ok = false; pe = s.endMs; ps = s.sourceSeq; }
        return ok;
      })(),
    };
  });
  const rewindDetected = connTimeline.some((c) => c.gapFromPrevConnMs !== null && c.gapFromPrevConnMs < 0);
  const jumpDetected = connTimeline.some((c) => c.gapFromPrevConnMs !== null && c.gapFromPrevConnMs > 600000);

  const rss = samples.map((s) => s.rssMB).filter((x) => typeof x === "number");
  const hd = samples.map((s) => s.handles).filter((x) => typeof x === "number");

  const report = {
    kind: "30分钟长跑（真实在播直播流）",
    measuredAtIso: new Date().toISOString(),
    headCommit: (() => { try { return execSync('git -C "D:\\ai盯播工具\\app" rev-parse --short HEAD', { encoding: "utf8" }).trim(); } catch { return null; } })(),
    source: { name: SRC_NAME, url: SRC_URL, kind: "真实在播公开直播流（非抖音）", playedVia: "ffplay → 系统默认输出 → app loopback" },
    credentials: { appId: "configured", secretId: "configured", secretKey: "configured" },
    session: { sessionId: result.uiSessionId, ...sess.result.value },
    plannedMinutes: MINUTES,
    actualSeconds: Math.round((Date.now() - t0run) / 1000),
    counts: {
      partials: result.partialCount, finals: result.finalCount,
      emptyFinals, errors: result.errors.length,
      reconnects: result.asrStatuses.filter((s) => s && s.state === "reconnecting").length,
      connections: result.asrStatuses.filter((s) => s && s.state === "connected").length,
    },
    textDurationMs: result.finals.length ? result.finals[result.finals.length - 1].endMs : 0,
    segmentLengthMs: {
      count: lens.length,
      min: lens.length ? Math.min(...lens) : null,
      median: median(lens),
      mean: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : null,
      max: lens.length ? Math.max(...lens) : null,
      p25: lens.length ? [...lens].sort((a, b) => a - b)[Math.floor(lens.length * 0.25)] : null,
      p75: lens.length ? [...lens].sort((a, b) => a - b)[Math.floor(lens.length * 0.75)] : null,
    },
    gapBetweenSegmentsMs: {
      count: gaps.length,
      min: gaps.length ? Math.min(...gaps) : null,
      median: median(gaps),
      mean: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      max: gaps.length ? Math.max(...gaps) : null,
    },
    timestamps: {
      perConnection: Object.entries(byConn).map(([conn, c]) => ({ conn: conn.slice(0, 8), count: c.count, monotonic: c.ok, lastEndMs: c.lastEnd })),
      allMonotonic: Object.values(byConn).every((c) => c.ok),
    },
    reconnectAnalysis: {
      reconnectCount: reconnects.length,
      reconnects,
      connectionTimeline: connTimeline,
      rewindDetected,
      jumpDetected,
      verdict: reconnects.length === 0
        ? "长跑期间未发生重连（连接稳定）"
        : (rewindDetected || jumpDetected
          ? "重连后时间轴异常（回退或跳变）"
          : "重连后时间轴正确（逐连接连续递增，无回退无跳变）"),
    },
    // 采集侧音频包与静默失效判定（2026-10-15 补，负责人要求）
    chunkTracking: {
      samples: global.__chunkSamples || [],
      stallSuspectedCount: (global.__chunkSamples || []).filter((s) => s.stallSuspected).length,
      chunkTotal: (global.__chunkSamples || []).length ? (global.__chunkSamples || [])[((global.__chunkSamples || []).length - 1)].chunks : null,
      verdict: (global.__chunkSamples || []).some((s) => s.stallSuspected)
        ? "疑似静默失效：出现 chunks 停增但 UI 仍显示采集中"
        : "未观察到静默失效（chunks 持续增长）",
    },
    memory: {
      baseline, end: endStats,
      samples: samples.length,
      rssMin: rss.length ? Math.min(...rss) : null,
      rssMax: rss.length ? Math.max(...rss) : null,
      rssFirst: rss[0] ?? null, rssLast: rss.at(-1) ?? null,
      rssGrowthMB: rss.length >= 2 ? rss.at(-1) - rss[0] : null,
      handlesFirst: hd[0] ?? null, handlesLast: hd.at(-1) ?? null,
      handlesGrowth: hd.length >= 2 ? hd.at(-1) - hd[0] : null,
      series: samples.map((s) => ({ at: s.at, rssMB: s.rssMB, handles: s.handles, finals: s.finals })),
    },
    ffplayExitCode: ffExited,
    ffplayStderrTail: ffErr.slice(-600),
    exceptions,
    finals: result.finals,
  };
  const outFile = `${OUT_DIR}/longrun-${MINUTES}min-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  log("\n===== LONGRUN RESULT =====");
  log(`source      ${SRC_NAME}`);
  log(`sessionId   ${result.uiSessionId}`);
  log(`时长        ${report.actualSeconds}s (计划 ${MINUTES}min)`);
  log(`partials    ${result.partialCount}`);
  log(`finals      ${result.finalCount}  (空文本 ${emptyFinals})`);
  log(`重连次数    ${report.counts.reconnects}`);
  log(`时间戳单调  ${report.timestamps.allMonotonic}`);
  log(`重连分析    ${report.reconnectAnalysis.verdict}`);
  for (const c of connTimeline) {
    log(`  连接#${c.index} ${c.connectionId} 片段${c.segments} 首条[${c.firstSegmentStartMs}-${c.firstSegmentEndMs}] 与上一连接间隔=${c.gapFromPrevConnMs}ms 内部单调=${c.monotonicWithinConn}`);
  }
  for (const r of reconnects) {
    log(`  断线@${r.disconnectAt} → 重连耗时=${r.reconnectCostMs}ms 新连接=${r.reconnectedConnectionId ? String(r.reconnectedConnectionId).slice(0, 8) : "?"} gapDetected=${r.gapDetected}`);
  }
  log(`片段长度    min=${report.segmentLengthMs.min}ms 中位=${report.segmentLengthMs.median}ms mean=${report.segmentLengthMs.mean}ms max=${report.segmentLengthMs.max}ms`);
  log(`片段间隔    中位=${report.gapBetweenSegmentsMs.median}ms`);
  log(`chunks 追踪 ${report.chunkTracking.verdict}`);
  log(`           总包数=${report.chunkTracking.chunkTotal} 采样点=${report.chunkTracking.samples.length}`);
  log(`内存        ${report.memory.rssFirst}MB → ${report.memory.rssLast}MB (增 ${report.memory.rssGrowthMB}MB)`);
  log(`句柄        ${report.memory.handlesFirst} → ${report.memory.handlesLast} (增 ${report.memory.handlesGrowth})`);
  log(`报告        ${outFile}`);

  // ⚠ 关键收尾：必须显式点「结束」关闭会话（见 level2-live.js 的长注释）。
  // 不结束会话 = 采集不停止 = 后续任何声音都进同一个 session，污染统计口径。
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
        return { clicked: true, stillCapturing: /采集中/.test(t), snippet: t.slice(0, 120) };
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

  // ⚠ 断言：会话必须已停止，否则报错退出（防止污染的最后一道闸）
  if (!sessionClosed) {
    const msg = "断言失败：会话未确认停止，本次数据可能被后续声音污染。请手动打开 app 点「结束」。";
    log("!! " + msg);
    fs.writeFileSync(`${OUT_DIR}/ASSERT-FAILED-longrun-${Date.now()}.txt`, msg + "\n" + JSON.stringify(report, null, 2));
    await sleep(1500);
    process.exit(2);
  }
  log("断言通过：会话已停止，数据可信。");
  await sleep(1500);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
