const { execFileSync } = require("node:child_process");
const out = execFileSync(process.execPath, ["D:\\ai盯播工具\\app\\scripts\\probe-diag.cjs"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
console.log(out);
