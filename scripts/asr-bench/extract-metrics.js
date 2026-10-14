/**
 * 从探针 stdout 里抽取关键指标（避免 PowerShell 引号转义踩坑）。
 * 用法：node extract-metrics.js <logfile>
 */
const fs = require("node:fs");
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\r?\n/);
const keep = [];
const pats = [
  /pinned /, /audio files:/, /OPEN #/, /handshakeMs/, /WS_ERROR/, /WS_CLOSE/,
  /SERVER_ERROR/, /SIMULATE_NETWORK_CUT/, /REOPEN/, /===== RESULT =====/,
  /"measuredAtIso"/, /"runSeconds"/, /"packetsSent"/, /"connections"/,
  /"partials"/, /"finals"/, /"errorCount"/, /"monotonic"/,
  /"e2eMs"/, /"firstTokenLatencyMs"/, /"n":/, /"mean"/, /"p50"/, /"p90"/, /"p95"/, /"max"/,
];
for (const l of lines) {
  if (pats.some((p) => p.test(l))) keep.push(l);
}
console.log(keep.join("\n"));
console.log("\n--- FINAL count / PARTIAL count ---");
console.log("FINAL lines:", lines.filter((l) => l.startsWith("FINAL ")).length);
console.log("PARTIAL lines:", lines.filter((l) => l.startsWith("PARTIAL")).length);
