#!/usr/bin/env node
/**
 * 用 Electron 内置 Node 跑 vitest。
 *
 * 背景（INC-03）：better-sqlite3 单个二进制只能挂一个 ABI —— Electron 33 要 130，
 * 本机 Node v24 要 137。历史上 `npm test` 的 pretest 守卫会把二进制切成 Node ABI，
 * 导致正在跑 app 的成员数据库崩、打包产物在干净机器上打不开库。
 *
 * 本脚本直接用 Electron 内置 Node（v20 / modules 130，与二进制天然匹配）跑 vitest，
 * 不切 ABI、不碰二进制、不需要先杀进程。
 *
 * 用法：
 *   npm test                         全量
 *   npm test -- tests/storage.test.ts 单文件
 *   node scripts/test-electron-node.js run tests/xxx.test.ts
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
// Electron's package resolves the executable on Windows, macOS and Linux.
const electron = require("electron");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");

if (!fs.existsSync(electron)) {
  console.error("[test-electron-node] 找不到 electron，请先 npm install");
  process.exit(1);
}
if (!fs.existsSync(vitest)) {
  console.error("[test-electron-node] 找不到 vitest，请先 npm install");
  process.exit(1);
}

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "run") cliArgs.shift();
const result = spawnSync(electron, [vitest, "run", ...cliArgs], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DSH_SECRET_TENCENT_ASR_SECRET_ID: "",
    DSH_SECRET_TENCENT_ASR_SECRET_KEY: "",
    DSH_SECRET_LLM_API_KEY: "",
    DSH_TENCENT_ASR_APP_ID: "",
    DSH_LLM_BASE_URL: "",
    DSH_LLM_MODEL: "",
  },
});

if (result.error) {
  console.error(`[test-electron-node] 启动失败: ${result.error.message}`);
}
process.exit(result.status ?? 1);
