#!/usr/bin/env node
/**
 * 渲染层冒烟测试：用真实 Electron 启动窗口，验证三件事——
 *   1. 预加载脚本生效（window.appApi 存在）；
 *   2. React 真正挂载（导航栏 + 四个页签渲染出来）；
 *   3. 渲染进程无 console 错误、页面加载成功。
 *
 * 存在的原因：曾经"窗口能打开但内容是白板"（tsconfig 漏编译 src/preload），
 * 而此前的启动验证只看窗口弹没弹。启动验证必须看内容。
 *
 * 用法：先 npm run build，再 npm run smoke
 */
// 两种降级场景的自愈：
// 1. 被 node 直接运行（没有 Electron）→ 提示改用 npm run smoke；
// 2. Electron 被 ELECTRON_RUN_AS_NODE 降级成纯 Node（沙箱/CI 常见）→ 剥掉该变量，
//    带上软件渲染开关从二进制命令行重启（命令行开关比 appendSwitch 更早生效，
//    否则 GPU 进程会在窗口创建前崩溃并把整个应用 FATAL 掉）。
if (process.type !== "browser") {
  if (!process.versions.electron) {
    console.error("[smoke] 请通过 npm run smoke 运行（需要 Electron 主进程）");
    process.exit(1);
  }
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log("[smoke] 正在以真实 Electron 模式（软件渲染）重启…");
  const child = spawn(
    process.execPath,
    ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", __filename],
    { stdio: "inherit", env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  return;
}

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

// 双保险：窗口创建前再设一次软件渲染
app.commandLine.appendSwitch("disable-gpu");

const root = path.join(__dirname, "..");
const preloadPath = path.join(root, "dist/main/preload/index.js");
const rendererPath = path.join(root, "dist/renderer/index.html");

const PROBE_JS = `(() => {
  const api = typeof window.appApi === "object" && window.appApi !== null;
  const nav = document.querySelector("nav");
  const tabs = Array.from(document.querySelectorAll("nav button")).map((b) => b.textContent);
  return { api, hasNav: !!nav, tabs, bodyText: document.body.innerText.slice(0, 60) };
})()`;

app.whenReady()
  .then(async () => {
    if (!fs.existsSync(preloadPath)) {
      console.error(`[smoke] 预加载脚本不存在: ${preloadPath}`);
      console.error("[smoke] 检查 tsconfig.main.json 的 include 是否包含 src/preload");
      app.exit(1);
      return;
    }
    if (!fs.existsSync(rendererPath)) {
      console.error(`[smoke] 渲染产物不存在: ${rendererPath}（先执行 npm run build）`);
      app.exit(1);
      return;
    }

    const errors = [];
    const warnings = [];
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.webContents.on("console-message", (_e, level, message) => {
      // level: 2=warning 3=error
      if (level >= 3) errors.push(`console: ${message}`);
      else if (level === 2) warnings.push(`console: ${message}`);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      errors.push(`did-fail-load: ${code} ${desc}`);
    });

    await win.loadFile(rendererPath);

    // 轮询等待 React 挂载（隐藏窗口定时器可能被节流，用主进程轮询更稳）
    let probe = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      probe = await win.webContents.executeJavaScript(PROBE_JS).catch(() => null);
      if (probe && probe.api && probe.hasNav) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // 注意：不要在这里 win.close()——关闭最后一个窗口会触发 window-all-closed，
    // Electron 默认直接退出进程，后面的结果打印会被吞掉（静默 exit 0）。
    // 收尾统一用 app.exit。
    const checks = [
      ["window.appApi 存在（预加载生效）", !!probe && probe.api === true],
      ["导航栏已渲染", !!probe && probe.hasNav === true],
      [
        "四个页签齐全",
        !!probe &&
          JSON.stringify(probe.tabs) ===
            JSON.stringify(["实时监控", "话术配置", "分析设置", "历史与报告"]),
      ],
      ["无 console 错误 / 加载失败", errors.length === 0],
    ];

    console.log("\n[smoke] 渲染层冒烟结果：");
    let ok = true;
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
      if (!pass) ok = false;
    }
    if (probe) console.log(`  body 文本预览: ${JSON.stringify(probe.bodyText)}`);
    if (warnings.length) console.log("  warning:\n" + warnings.map((w) => "    " + w).join("\n"));
    if (errors.length) console.log("  错误详情:\n" + errors.map((e) => "    " + e).join("\n"));

    app.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(`[smoke] 运行失败: ${err instanceof Error ? err.message : err}`);
    app.exit(1);
  });
