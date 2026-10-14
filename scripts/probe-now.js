const path = require("node:path"); const fs = require("node:fs");
const ROOT = "D:/ai盯播工具/app";
const { app, BrowserWindow } = require("electron");
app.setPath("userData", "C:/Users/libiu/AppData/Roaming/ai-live-monitor");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, "dist/main/preload/index.js"), contextIsolation: true, sandbox: false } });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  await win.loadFile(path.join(ROOT, "dist/renderer/index.html"));
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const out = [];
      for (const d of (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput")) {
        let peak = null;
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } });
          const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 2048;
          ctx.createMediaStreamSource(s).connect(an);
          const buf = new Float32Array(an.fftSize); let p = 0;
          const t0 = Date.now();
          while (Date.now() - t0 < 2000) { an.getFloatTimeDomainData(buf); for (const v of buf) p = Math.max(p, Math.abs(v)); await new Promise(r => setTimeout(r, 50)); }
          peak = Math.round(p * 1000) / 1000;
          s.getTracks().forEach(t => t.stop()); await ctx.close();
        } catch (e) { peak = "ERR"; }
        out.push(d.deviceId.slice(0,8) + " peak=" + peak + " :: " + d.label);
      }
      return out;
    })()
  `);
  try { fs.appendFileSync(ROOT + "/scripts/probe-now.log", "NOW " + JSON.stringify(r) + "\n"); } catch {}
  app.exit(0);
});
