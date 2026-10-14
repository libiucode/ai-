/**
 * 长时间运行资源观测：每 10 秒记录一次进程的 RSS、句柄数、活动连接数。
 * 用于判断 30 分钟长跑是否会在资源上出问题（方案第 16 节第 7 条：
 * 「至少运行两小时，队列不持续积压，内存无单调失控增长」）。
 *
 * 这个脚本本身不发音频、不连腾讯云，只观测一个空闲进程——真正的长跑
 * 要等第②级直播源就绪后再跑。这里先建立基线。
 *
 * 用法：node watch-resources.js <PID> [秒数]
 */
const { execSync } = require("node:child_process");
const PID = process.argv[2];
const SECONDS = Number(process.argv[3] || "60");
if (!PID) { console.error("need pid"); process.exit(1); }

function snapshot() {
  const ps = execSync(
    `powershell -NoProfile -Command "Get-Process -Id ${PID} | Select-Object -ExpandProperty WorkingSet64; (Get-Process -Id ${PID}).Handles"`,
    { encoding: "utf8" },
  ).trim().split(/\r?\n/).map((s) => Number(s.trim()));
  return { rssMB: Math.round((ps[0] || 0) / 1048576), handles: ps[1] || 0 };
}

const samples = [];
console.log("watching PID", PID, "for", SECONDS, "s");
const t0 = Date.now();
for (let i = 0; i < SECONDS / 10; i++) {
  const s = snapshot();
  samples.push({ at: Math.round((Date.now() - t0) / 1000), ...s });
  console.log(`+${samples.at(-1).at}s  rss=${s.rssMB}MB  handles=${s.handles}`);
  const { execSync: _ } = require("node:child_process");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
const rss = samples.map((s) => s.rssMB);
const handles = samples.map((s) => s.handles);
console.log("\n===== RESULT =====");
console.log(JSON.stringify({
  samples: samples.length,
  rss: { min: Math.min(...rss), max: Math.max(...rss), first: rss[0], last: rss[rss.length - 1], growthMB: rss[rss.length - 1] - rss[0] },
  handles: { min: Math.min(...handles), max: Math.max(...handles), first: handles[0], last: handles[handles.length - 1], growth: handles[handles.length - 1] - handles[0] },
}, null, 2));
