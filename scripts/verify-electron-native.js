#!/usr/bin/env node
/** Read-only packaging gate: validate the exact local Windows x64 Electron runtime. */
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "..");

if (process.argv[2] === "--probe") {
  let db;
  try {
    const expectedVersion = process.argv[3];
    if (!expectedVersion || process.versions.electron !== expectedVersion) {
      throw new Error("打包 Electron 版本与本地验证运行时不一致");
    }
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("此打包配置仅验证本机 Windows x64，其他平台或架构尚未验收");
    }
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    const result = db.prepare("SELECT sqlite_version() AS version").get();
    console.log(`[native-gate] PASS Electron ${process.versions.electron}, ABI ${process.versions.modules}, ${process.platform}/${process.arch}, SQLite ${result.version}`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[native-gate] FAIL ${error.message}`);
    console.error("[native-gate] 仅校验，不修改二进制。若ABI不符，请结束自己负责的采集并协调 npm run abi:electron 后重试。");
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
} else {
  const pkg = require(path.join(root, "package.json"));
  const expectedVersion = pkg.build?.electronVersion;
  if (!expectedVersion || pkg.build?.npmRebuild !== false) {
    console.error("[native-gate] 必须显式锁定build.electronVersion并关闭npmRebuild，避免打包改写共享native文件。");
    process.exit(1);
  }
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("DSH_SECRET_")) delete childEnv[key];
  }
  const child = spawnSync(require("electron"), [__filename, "--probe", expectedVersion], {
    cwd: root,
    stdio: "inherit",
    env: childEnv,
  });
  if (child.error) console.error(`[native-gate] 无法启动校验进程: ${child.error.message}`);
  process.exit(child.status ?? 1);
}
