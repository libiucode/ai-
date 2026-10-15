// 在**真实库的副本**上干跑一次迁移，验证 v1 → v4 不会丢数据、不会报错。
//
// 为什么必须做：用户真实库 C:\Users\...\live-monitor.db 实测 schema_version=1、
// sessions 表没有 framework_id / speaker_id / end_reason —— 说明迁移代码写完后
// app 还没启动过，迁移**从未在真实数据上执行**。等用户下次开机才第一次跑，
// 出问题就是「打开软件直接崩」。
//
// 本脚本只操作副本，绝不碰原库（原库以 readonly 打开仅用于复制）。
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const realDb = path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-dryrun-"));
const copyDb = path.join(tmpDir, "copy.db");

fs.copyFileSync(realDb, copyDb);
// WAL 模式下还有 -wal/-shm，一并复制才是完整快照
for (const suffix of ["-wal", "-shm"]) {
  const f = realDb + suffix;
  if (fs.existsSync(f)) fs.copyFileSync(f, copyDb + suffix);
}
console.log("原库:", realDb);
console.log("副本:", copyDb);
console.log("副本大小:", fs.statSync(copyDb).size, "bytes\n");

// 用编译后的 Store 跑迁移（ts 源不能直接 require，走 electron 内置 node + tsx 不现实；
// 这里直接用 sqlite3 CLI 语义等价地手动执行迁移，再对比数据）。
// 更可靠的做法：调用 dist 里编译后的 store。若 dist 不存在则明确报错，不假装通过。
const distStore = path.join(__dirname, "..", "dist", "main", "main", "storage", "store.js");
if (!fs.existsSync(distStore)) {
  console.log("⚠ dist/main/main/storage/store.js 不存在，无法用真实 Store 跑迁移。");
  console.log("  请先 npm run build。本脚本不会用「手写 SQL 等价替代」冒充验证。");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
}

const driver = `
const path = require("node:path");
const Database = require(path.join("D:\\\\ai盯播工具\\\\app", "node_modules", "better-sqlite3"));
const { Store } = require(${JSON.stringify(distStore)});
const dbPath = ${JSON.stringify(copyDb)};

// 迁移前快照
const before = new Database(dbPath, { readonly: true });
const beforeVersion = before.prepare("SELECT MAX(version) AS v FROM schema_version").get().v;
const beforeCols = before.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
const counts = {};
for (const t of ["sessions","transcript_segments","speech_intervals","issues","frameworks"]) {
  counts[t] = before.prepare("SELECT COUNT(*) AS c FROM " + t).get().c;
}
const beforeRows = before.prepare("SELECT id, started_at_iso, status FROM sessions ORDER BY id").all();
before.close();

// 用真实 Store 触发迁移
let openError = null;
try {
  const store = new Store(dbPath);
  store.close();
} catch (e) {
  openError = e.message;
}

const after = new Database(dbPath, { readonly: true });
const afterVersion = after.prepare("SELECT MAX(version) AS v FROM schema_version").get().v;
const afterCols = after.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
const countsAfter = {};
for (const t of ["sessions","transcript_segments","speech_intervals","issues","frameworks"]) {
  countsAfter[t] = after.prepare("SELECT COUNT(*) AS c FROM " + t).get().c;
}
const afterRows = after.prepare("SELECT id, started_at_iso, status FROM sessions ORDER BY id").all();
after.close();

console.log(JSON.stringify({
  beforeVersion, afterVersion, beforeCols, afterCols, counts, countsAfter,
  rowsEqual: JSON.stringify(beforeRows) === JSON.stringify(afterRows),
  rowDelta: beforeRows.length - afterRows.length,
  openError,
}, null, 2));
`;

const driverPath = path.join(tmpDir, "driver.cjs");
fs.writeFileSync(driverPath, driver, "utf8");

const electron = "D:\\ai盯播工具\\app\\node_modules\\electron\\dist\\electron.exe";
try {
  const out = execFileSync(electron, [driverPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  console.log("=== 干跑结果 ===");
  console.log(out);
} catch (e) {
  console.log("=== 干跑失败 ===");
  console.log("exit:", e.status);
  console.log(String(e.stdout || ""));
  console.log(String(e.stderr || "").slice(0, 2000));
}

console.log("副本保留在:", tmpDir, "（可手动复查；不自动删除，避免掩盖问题）");
