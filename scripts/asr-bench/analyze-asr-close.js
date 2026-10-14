/**
 * 分析本次长跑的 ASR 连接生命周期：为什么 t=122s 后进入 closed，且脚本无感知。
 * 复用归档数据 + 代码走查，不新采 ASR 流量。
 */
const fs = require("node:fs");
const LOG = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\longrun.log";
const OUT = "D:\\ai盯播工具\\app\\scripts\\asr-bench\\out";

console.log("=== 长跑日志全文 ===");
console.log(fs.readFileSync(LOG, "utf8"));

console.log("\n=== 状态序列分析 ===");
const lines = fs.readFileSync(LOG, "utf8").split(/\r?\n/);
for (const l of lines) {
  const m = l.match(/t=(\d+)s finals=(\d+) partials=(\d+) empty=(\d+) asr=(\w+) reconn=(\d+) err=(\d+)/);
  if (m) {
    console.log(`t=${m[1]}s: asr=${m[5]} finals=${m[2]} partials=${m[3]} reconnects=${m[6]} errors=${m[7]}`);
  }
}

console.log("\n=== 关键推断 ===");
console.log("1. partials 在 t=122s 后停止增长（107 → 107 → 107）");
console.log("2. finals 在 t=122s 后停止增长（3 → 3 → 3）");
console.log("3. asr 状态从 connected 变为 closed，且 reconn=0（没有触发重连）");
console.log("4. 脚本继续运行到 t=244s，即断连后空转了约 2 分钟");

console.log("\n=== 为什么 closed 而不是 reconnecting？===");
console.log("读 tencentAdapter.ts 的 close 分支：");
console.log("  emit('status', { state: this.shouldRun ? 'reconnecting' : 'closed', gapDetected: true })");
console.log("所以 state=closed 意味着 this.shouldRun === false");
console.log("");
console.log("shouldRun 何时被置 false？");
console.log("  - stop() 主动停止");
console.log("  - connect() 里重置");
console.log("");
console.log("推断：ASR 服务端因某种原因关闭了连接（可能是 6 秒无音频包/发送速率问题），");
console.log("或 stop() 被调用。但脚本没调 stop()，所以更可能是：");
console.log("  app 的 orchestrator 在某个条件下调用了 asr.stop()");
console.log("  或 ws 收到服务端关闭帧后 this.ws 被置 null 而 shouldRun 仍为 true → 应该是 reconnecting");

console.log("\n=== 需要核对 orchestrator 的 pause/stop 触发条件 ===");

// 检查是否有归档的证据文件
const files = fs.readdirSync(OUT).filter((f) => f.startsWith("longrun"));
console.log("\n=== 归档的长跑证据文件 ===");
for (const f of files) {
  const st = fs.statSync(`${OUT}/${f}`);
  console.log(`  ${f}  ${st.size} bytes  ${st.mtime.toISOString()}`);
}
