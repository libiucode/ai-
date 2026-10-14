const path = "D:\\ai盯播工具\\app\\scripts\\probe-diag.cjs";
const r = require("node:child_process").spawnSync(process.execPath, [path], {
  encoding: "utf8",
  cwd: "D:\\ai盯播工具\\app",
});
console.log("STATUS:", r.status);
console.log("SIGNAL:", r.signal);
console.log("ERROR:", r.error);
console.log("STDOUT_BYTES:", r.stdout ? r.stdout.length : 0);
console.log("STDERR_BYTES:", r.stderr ? r.stderr.length : 0);
if (r.stdout) console.log("=== STDOUT ===\n" + r.stdout);
if (r.stderr) console.log("=== STDERR ===\n" + r.stderr);
