/**
 * 起一个属于我的 app 实例：独立 CDP 端口 + 独立 userData，
 * 不碰机器上其他人起的实例。
 *
 * 凭证通过继承当前进程的环境变量进入（DSH_SECRET_TENCENT_ASR_SECRET_ID/_KEY），
 * 启动后 app 的 runtimeConfig 会读到它们并显示 ASR 已配置。
 *
 * 用法：node start-my-instance.js [端口]
 * 输出：PID 与调试端口，供 level2-drive.js 使用。
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = Number(process.argv[2] || "9444");
const APP = "D:\\ai盯播工具\\app";
const USER_DATA = path.join(APP, ".verify-tmp", `myrun-${PORT}`);
const EXE = path.join(APP, "node_modules", "electron", "dist", "electron.exe");

fs.mkdirSync(USER_DATA, { recursive: true });

// ELECTRON_RUN_AS_NODE 必须清掉，否则 require('electron') 返回路径字符串而崩溃
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const logFile = path.join(APP, "scripts", "asr-bench", `my-instance-${PORT}.log`);
const out = fs.openSync(logFile, "a");

const child = spawn(EXE, [APP, "--no-sandbox", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`], {
  cwd: APP,
  env,
  stdio: ["ignore", out, out],
  detached: false,
});
console.log("PID=" + child.pid);
console.log("PORT=" + PORT);
console.log("USER_DATA=" + USER_DATA);
console.log("LOG=" + logFile);

function waitForPort() {
  return new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const tryOnce = () => {
      http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => { try { resolve(JSON.parse(b)); } catch { retry(); } });
      }).on("error", retry);
    };
    const retry = () => { if (Date.now() > deadline) resolve(null); else setTimeout(tryOnce, 400); };
    tryOnce();
  });
}

(async () => {
  const targets = await waitForPort();
  if (!targets) { console.log("PORT_NOT_READY"); process.exit(1); }
  const page = targets.find((t) => t.type === "page");
  console.log("PAGE_URL=" + (page ? page.url : "(none)"));
  console.log("READY");
  // 不退出，保持实例运行；由外部 kill
  child.on("exit", (c) => { console.log("INSTANCE_EXITED=" + c); process.exit(c ?? 0); });
})();
