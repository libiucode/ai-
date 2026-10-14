/**
 * 把探针 stdout 落成结构化 JSON 证据文件。
 * 解析 direct-probe2.js 的输出：RESULT 段是 JSON，FINAL 行是逐句记录。
 * 用法：node save-evidence.js <logfile> <outjson>
 */
const fs = require("node:fs");
const src = process.argv[2];
const dst = process.argv[3];
const text = fs.readFileSync(src, "utf8");
const lines = text.split(/\r?\n/);

const resultIdx = lines.findIndex((l) => l.includes("===== RESULT ====="));
let summary = null;
if (resultIdx >= 0) {
  const jsonStart = lines.slice(resultIdx).findIndex((l) => l.trim().startsWith("{"));
  const jsonLines = lines.slice(resultIdx + jsonStart);
  const braceEnd = jsonLines.findIndex((l) => l.trim() === "}");
  try {
    summary = JSON.parse(jsonLines.slice(0, braceEnd + 1).join("\n"));
  } catch (e) {
    summary = { parseError: e.message };
  }
}

const finals = [];
const partials = [];
for (const l of lines) {
  let m = l.match(/^FINAL conn=(\d+) seq=(\d+) \[(\d+)-(\d+)\] e2e=(\S+)ms ftl=(\S+)ms\s+(.*)$/);
  if (m) {
    finals.push({ conn: Number(m[1]), seq: Number(m[2]), startMs: Number(m[3]), endMs: Number(m[4]), e2eMs: m[5] === "null" ? null : Number(m[5]), firstTokenLatencyMs: m[6] === "null" ? null : Number(m[6]), text: m[7] });
    continue;
  }
  m = l.match(/^PARTIAL\((\d+)\) conn=(\d+) seq=(\d+)\s+(.*)$/);
  if (m) partials.push({ sliceType: Number(m[1]), conn: Number(m[2]), seq: Number(m[3]), text: m[4] });
}

const opens = [];
for (const l of lines) {
  const m = l.match(/^OPEN #(\d+) handshakeMs (\d+) connIdx (\d+)/);
  if (m) opens.push({ n: Number(m[1]), handshakeMs: Number(m[2]), connIdx: Number(m[3]) });
}
const events = [];
for (const l of lines) {
  if (/^(WS_ERROR|WS_CLOSE|SERVER_ERROR|>>> )/.test(l)) events.push(l);
}

const out = {
  credentials: { appId: "configured", secretId: "configured", secretKey: "configured" },
  measuredAtIso: new Date().toISOString(),
  source: src.replace(/\\/g, "/"),
  summary, opens, events, finals, partialSample: partials.slice(0, 50), partialCount: partials.length,
};
fs.mkdirSync(require("node:path").dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(out, null, 2));
console.log("written", dst, "finals", finals.length, "partials", partials.length);
