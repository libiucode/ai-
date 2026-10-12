#!/usr/bin/env node
/**
 * pretest 守卫：确保 better-sqlite3 原生模块与当前 Node ABI 匹配。
 *
 * 背景：better-sqlite3 的二进制只能对应一个运行时——
 *   - 跑 `npm test`（vitest 在 Node 下）需要 Node ABI；
 *   - Electron 运行/打包需要 Electron ABI。
 * 两者靠 `npm run abi:node` / `npm run abi:electron` 手动切换，
 * 历史上出现过"打包后忘了切回，换台机器或换个 Node 版本，
 * 存储类测试一次性全红"的事故。本脚本把切换自动化：
 * 每次 `npm test` 前自动探测，不匹配就地重建，失败则给出明确的手动命令。
 *
 * 被 package.json 的 pretest 自动调用；也可手动执行：
 *   node scripts/ensure-sqlite-abi.js
 */
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pkgDir = path.join(root, "node_modules", "better-sqlite3");

function fail(message, hint) {
  console.error(`[sqlite-abi] ${message}`);
  if (hint) {
    console.error(`[sqlite-abi] 请手动执行：\n  ${hint}`);
  }
  process.exit(1);
}

if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
  fail("未找到 node_modules/better-sqlite3，请先执行 npm install");
}

/**
 * 清理 @electron/rebuild 留下的 .forge-meta。
 * 该文件记录它上次为 Electron 重建的 ABI（如 x64--130）。
 * 若二进制已被切回 Node ABI 而 meta 没更新，下次 npm run package 时
 * @electron/rebuild 的 alreadyBuiltByRebuild() 会误判"已重建过"直接跳过，
 * 把 Node ABI 的二进制打进安装包——应用一启动打开数据库就崩。
 * 确认 Node ABI 就绪后必须清掉它，让下次打包老老实实重建。
 */
function clearStaleForgeMeta() {
  const metaPath = path.join(pkgDir, "build", "Release", ".forge-meta");
  if (fs.existsSync(metaPath)) {
    try {
      fs.unlinkSync(metaPath);
      console.warn("[sqlite-abi] 已清理过期的 .forge-meta（否则下次打包会跳过 Electron 重建）");
    } catch {
      /* 清理失败不阻塞测试，README 有手动兜底说明 */
    }
  }
}

let Database;
try {
  // 注意：不能 import store 里的 Database——这里只做探测，保持零依赖
  Database = require(require.resolve("better-sqlite3", { paths: [root] }));
} catch (err) {
  fail(`加载 better-sqlite3 失败: ${err instanceof Error ? err.message : err}`,
    "删除 node_modules/better-sqlite3 后重新 npm install");
}

// ABI 探测：能否在当前 Node 下真正打开一个内存库
// （better-sqlite3 在 new Database() 时才 dlopen 原生二进制，错误信息带 NODE_MODULE_VERSION）
try {
  const db = new Database(":memory:");
  db.close();
  clearStaleForgeMeta();
  process.exit(0); // 匹配：快速返回，不给测试增加可感知开销
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/NODE_MODULE_VERSION|compiled against a different Node/i.test(msg)) {
    // 不像 ABI 问题（文件损坏等）：不拦截，交给测试本身暴露
    console.warn(`[sqlite-abi] 打开 SQLite 失败但不像 ABI 不匹配，继续跑测试: ${msg}`);
    process.exit(0);
  }
  console.warn(`[sqlite-abi] 检测到 ABI 不匹配（当前 ${process.version}）：${msg.split("\n")[0]}`);
}

// 自动重建：拉取当前 Node 版本的预编译二进制（无需 VS 编译环境）
console.warn(`[sqlite-abi] 正在为 ${process.version} 重建 better-sqlite3 …`);
try {
  execFileSync(process.execPath, ["../prebuild-install/bin.js", "-r", "node"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
} catch {
  fail("自动重建失败（无网络，或该 Node 版本没有预编译包）",
    "cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js -r node\n  或： npm run abi:node");
}

// 复验：重建后必须能在当前 Node 下打开
try {
  const db = new Database(":memory:");
  db.close();
  clearStaleForgeMeta();
  console.warn(`[sqlite-abi] 重建完成，better-sqlite3 已匹配 ${process.version}`);
  process.exit(0);
} catch (err) {
  fail(`重建后仍不匹配: ${err instanceof Error ? err.message : err}`, "npm run abi:node");
}
