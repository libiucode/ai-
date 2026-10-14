#!/usr/bin/env node
/**
 * 决定性复现（不提交）：CABLE 现有真实音频（peak=1.0 已验证）。
 * 真实 orchestrator + 真实密钥 + 真实采集，重点看：
 *   A) 发给腾讯云的 PCM 是否真含语音（落盘 RMS）
 *   B) transcript.partial/final 事件是否到达渲染层（区分"事件没到"vs"到了没渲染"）
 * 跑法：electron --no-sandbox --disable-gpu scripts/repro-e2e.js
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = "D:/ai盯播工具/app";
const LOG = path.join(ROOT, "scripts/repro-e2e.log");
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  try { fs.appendFileSync(LOG, s + "\n"); } catch { /* ignore */ }
}

const Database = require(path.join(ROOT, "node_modules/better-sqlite3"));
const { Store } = require(path.join(ROOT, "dist/main/main/storage/store.js"));
const { SessionOrchestrator } = require(path.join(ROOT, "dist/main/main/analysis/orchestrator.js"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
const store = new Store(path.join(dir, "t.db"));
const userDb = new Database(path.join(process.env.APPDATA, "ai-live-monitor/live-monitor.db"), { readonly: true });
const row = userDb.prepare("SELECT value FROM settings WHERE key = 'asr_config'").get();
const asrRaw = row && row.value;
userDb.close();
if (!asrRaw) { log("FATAL: user asr_config not found"); process.exit(1); }
store.setSetting("asr_config", asrRaw);
log("asr_config loaded, appId=" + JSON.parse(asrRaw).appId);

const { app, BrowserWindow, ipcMain } = require("electron");

const stats = { ingest: 0, sends: 0, sendBytes: 0 };
const savedPackets = [];
const orch = new SessionOrchestrator(store);

const origSend = orch.asr.sendPcm.bind(orch.asr);
orch.asr.sendPcm = (chunk) => {
  stats.sends++;
  stats.sendBytes += chunk.byteLength;
  if (savedPackets.length < 30) savedPackets.push(Buffer.from(chunk));
  return origSend(chunk);
};

ipcMain.on("capture.audioChunk", (_e, data, sourceRate) => {
  stats.ingest++;
  orch.ingestAudio(data, sourceRate);
});

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "dist/main/preload/index.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  await win.loadFile(path.join(ROOT, "dist/renderer/index.html"));

  await win.webContents.executeJavaScript(`
    window.__events = [];
    window.appApi.subscribeEvents("transcript.partial", (p) => window.__events.push(["partial", p.text]));
    window.appApi.subscribeEvents("transcript.final", (p) => window.__events.push(["final", p.text]));
    window.appApi.subscribeEvents("app.error", (e) => window.__events.push(["error", e.code, String(e.message).slice(0, 100)]));
    window.appApi.subscribeEvents("asr.status", (s) => window.__events.push(["asr", s.state]));
    true
  `);

  orch.setWindow(win);
  const started = await orch.start({ audioSource: "microphone" });
  log("START " + JSON.stringify(started));

  const cap = await win.webContents.executeJavaScript(`
    (async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cable = devices.find((d) => d.kind === "audioinput" && d.label.includes("CABLE"));
      if (!cable) return { error: "no CABLE device" };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: cable.deviceId }, echoCancellation: false, noiseSuppression: false },
      });
      const ctx = new AudioContext();
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      window.__cap = { chunks: 0, rmsSum: 0, ctxState: ctx.state, sampleRate: ctx.sampleRate };
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        window.__cap.chunks++;
        let sum = 0; for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
        window.__cap.rmsSum += sum / data.length;
        window.appApi.sendAudioChunk(new Float32Array(data), ctx.sampleRate);
      };
      ctx.createMediaStreamSource(stream).connect(proc);
      proc.connect(ctx.destination);
      return { deviceId: cable.deviceId.slice(0, 8), sampleRate: ctx.sampleRate, ctxState: ctx.state };
    })()
  `);
  log("CAPTURE " + JSON.stringify(cap));

  // 最多等 45 秒，出现 final 就提前收工
  for (let i = 1; i <= 22; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const snap = await win.webContents.executeJavaScript(`({
      chunks: window.__cap.chunks,
      avgLevel: window.__cap.chunks ? Math.round(window.__cap.rmsSum / window.__cap.chunks * 1000) / 1000 : 0,
      events: window.__events.slice(-6),
      total: window.__events.length,
    })`).catch((e) => ({ error: String(e) }));
    log(`T+${i * 2}s ${JSON.stringify(stats)} renderer=${JSON.stringify(snap)}`);
    if (snap.events && snap.events.some((e) => e[0] === "final" || e[0] === "partial")) break;
  }

  if (savedPackets.length > 0) {
    fs.writeFileSync(path.join(os.tmpdir(), "sent-pcm2.bin"), Buffer.concat(savedPackets));
    log("saved " + savedPackets.length + " packets");
  }
  const segCount = store.db.prepare("SELECT COUNT(*) AS n FROM transcript_segments").get().n;
  log("RESULT segments=" + segCount + " stats=" + JSON.stringify(stats));
  try { await orch.stop(); } catch { /* ignore */ }
  app.exit(0);
});
