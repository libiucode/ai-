/**
 * `stalled`（链路停摆）真实触发验证 —— 纯渲染层，不建 ASR 会话、零额度消耗
 *
 * 目标：验证「onaudioprocess 回调停止 → 判据能在阈值内判出 stalled」这个事实。
 *
 * 做法：
 *   1. 在真实 Electron 渲染进程里起一条 loopback 采集（getDisplayMedia）
 *   2. 用与 audioCapture.ts 相同的接线（ScriptProcessor 4096 + 静音 Gain）
 *   3. 记录回调时间戳，先确认正常节奏
 *   4. **挂起 AudioContext**（ctx.suspend()）→ 模拟"轨道还活着但数据不来了"
 *   5. 观察回调是否停止、以及"距上次回调"是否越过 HEALTH_STALLED_MS(3000ms)
 *   6. 同时读 track.readyState / muted，证明**轨道指标全部正常**——这正是判据要抓的盲区
 *
 * 不建 app 会话 → 不连 ASR → 不消耗额度。
 */
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const OUT = path.join("D:\\ai盯播工具\\app", "evidence", `stalled-verify-${Date.now()}.json`);
const HEALTH_STALLED_MS = 3000;

app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(async () => {
  // 模拟 app 的 handler（仅本地验收实例，等价于 AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE）
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    void desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
        if (!source) return callback({});
        callback({ video: source, audio: "loopback" });
      })
      .catch(() => callback({}));
  });

  await win.loadURL("data:text/html,<html><body>stalled-verify</body></html>");

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const out = { steps: [], ok: false };
      const md = navigator.mediaDevices;
      if (typeof md.getDisplayMedia !== "function") { out.error = "no getDisplayMedia"; return out; }

      let stream;
      try {
        stream = await md.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false } });
        out.steps.push("getDisplayMedia ok");
      } catch (e) { out.error = e.name + ": " + e.message; return out; }

      const audioTracks = stream.getAudioTracks();
      out.audioTracks = audioTracks.length;
      out.audioLabel = audioTracks[0] ? audioTracks[0].label : null;
      if (!audioTracks.length) { out.error = "no audio track"; return out; }
      stream.getVideoTracks().forEach(t => t.stop());

      const audioOnly = new MediaStream(audioTracks);
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(audioOnly);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain(); mute.gain.value = 0;

      const h = { lastChunkAt: 0, chunkCount: 0, lastLevel: 0 };
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let s = 0; for (let i = 0; i < d.length; i++) s += Math.abs(d[i]);
        h.lastLevel = s / d.length;
        h.lastChunkAt = Date.now();
        h.chunkCount++;
      };
      src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);

      // ---- 阶段1：正常节奏 ----
      await new Promise(r => setTimeout(r, 2000));
      const track = audioOnly.getAudioTracks()[0];
      out.phase1 = {
        chunkCount: h.chunkCount,
        chunkIntervalMs: h.chunkCount > 1 ? Math.round(2000 / h.chunkCount) : null,
        readyState: track.readyState,
        muted: track.muted,
        ctxState: ctx.state,
        level: h.lastLevel,
      };

      // ---- 阶段2：挂起 AudioContext 制造停摆 ----
      const chunksBeforeSuspend = h.chunkCount;
      await ctx.suspend();
      out.phase2 = { suspendedAt: new Date().toISOString(), ctxState: ctx.state, chunksBeforeSuspend };

      // 观察 5 秒（> HEALTH_STALLED_MS=3000），看回调是否停、判据是否会判出
      const marks = [];
      for (let i = 1; i <= 5; i++) {
        await new Promise(r => setTimeout(r, 1000));
        marks.push({
          sec: i,
          chunkCount: h.chunkCount,
          sinceLastChunkMs: h.lastChunkAt ? Date.now() - h.lastChunkAt : null,
          wouldBeStalled: h.lastChunkAt ? (Date.now() - h.lastChunkAt) >= 3000 : null,
          readyState: track.readyState,
          muted: track.muted,
          ctxState: ctx.state,
          lastLevel: h.lastLevel,
        });
      }
      out.phase3_marks = marks;

      // ---- 结论数据 ----
      out.verdict = {
        chunksStoppedAfterSuspend: h.chunkCount === chunksBeforeSuspend,
        maxSinceLastChunkMs: Math.max(...marks.map(m => m.sinceLastChunkMs ?? 0)),
        stalledDetected: marks.some(m => m.wouldBeStalled === true),
        // 关键：轨道指标在停摆期间是否全部"正常"
        trackStillLive: track.readyState === "live",
        trackNotMuted: track.muted === false,
        // 电平停在最后值（不会归 0）—— 证明按电平无法检测
        levelNotZeroDuringStall: h.lastLevel > 0.0001,
      };

      out.ok = true;
      proc.onaudioprocess = null;
      try { proc.disconnect(); src.disconnect(); mute.disconnect(); } catch (e) {}
      try { await ctx.resume(); await ctx.close(); } catch (e) {}
      audioOnly.getTracks().forEach(t => t.stop());
      return out;
    })()
  `);

  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log("证据:", OUT);
  app.exit(0);
});
