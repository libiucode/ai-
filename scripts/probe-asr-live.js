// 只读探测（不提交）：用库里已保存的真实 ASR 配置跑一次「测试连接」同款链路，
// 只打印状态机迁移与服务端错误码（密钥绝不输出）。
// 用法：node_modules\.bin\electron.cmd scripts\probe-asr-live.js
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app } = require("electron");
const ROOT = "D:/ai盯播工具/app";
app.disableHardwareAcceleration();

const log = (o) => console.log("[asr-probe] " + JSON.stringify(o));

app.whenReady().then(async () => {
  const out = { steps: [] };
  try {
    const Database = require(path.join(ROOT, "node_modules/better-sqlite3"));
    const db = new Database("C:/Users/libiu/AppData/Roaming/ai-live-monitor/live-monitor.db", { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM settings WHERE key='asr_config'").get();
    db.close();
    if (!row) { log({ fatal: "no asr_config" }); app.exit(1); return; }
    const cfg = JSON.parse(row.value);
    out.cfgShape = {
      appIdDigits: String(cfg.appId || "").length,
      secretIdLen: String(cfg.secretId || "").length,
      secretKeyLen: String(cfg.secretKey || "").length,
      engine: cfg.engineModelType,
    };

    const { TencentAsrAdapter } = require(path.join(ROOT, "dist/main/main/asr/tencentAdapter.js"));
    const { buildTencentAsrUrl } = require(path.join(ROOT, "dist/main/main/asr/tencentSign.js"));
    const adapter = new TencentAsrAdapter();

    adapter.on("status", (s) => out.steps.push(["status", s.state, s.reconnectAttempt ?? 0]));
    adapter.on("error", (e) => out.steps.push(["error", e.error?.code, String(e.error?.message || "").slice(0, 160)]));
    adapter.on("partial", (p) => out.steps.push(["partial", p.sourceSeq, String(p.text || "").slice(0, 40)]));
    adapter.on("final", (p) => out.steps.push(["final", p.sourceSeq, String(p.text || "").slice(0, 40)]));

    const t0 = Date.now();
    const result = await adapter.probe(cfg, 6000);
    out.probe = { ok: result.ok, code: result.error?.code ?? null, msg: result.error ? String(result.error.message).slice(0, 200) : null, ms: Date.now() - t0 };
    out.steps = out.steps.slice(0, 30);
    log(out);
  } catch (e) {
    log({ fatal: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 400) });
  }
  app.exit(0);
});
