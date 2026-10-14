/**
 * 查混合会话里的「非 TTS」片段具体内容，判断是真污染还是 TTS 的碎片段。
 * 只读。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const fs = require("node:fs");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });
const scriptLines = fs.readFileSync("D:\\ai盯播工具\\app\\scripts\\asr-bench\\live-scripts.txt", "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const markers = scriptLines.map((l) => l.replace(/[，。！？、：；\s]/g, "").slice(0, 10)).filter((s) => s.length >= 6);
function isTts(t) {
  const c = String(t || "").replace(/[，。！？、：；\s]/g, "");
  if (c.length < 6) return false;
  return markers.some((m) => c.includes(m));
}

const targets = [
  ["ae85dc7c", "第①级（我跑的 TTS）"],
  ["190ba540", "第①级（TTS）"],
  ["ae6d96d7", "第③级（TTS，仍在挂）"],
  ["2920b432", "第②级（直播+TTS）"],
];

for (const [prefix, label] of targets) {
  const s = db.prepare("SELECT id, started_at_iso FROM sessions WHERE id LIKE ? LIMIT 1").get(prefix + "%");
  if (!s) continue;
  const segs = db.prepare("SELECT source_seq, start_ms, end_ms, text FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms").all(s.id);
  const nonTts = segs.filter((x) => !isTts(x.text));
  console.log("=".repeat(90));
  console.log(`[${prefix}] ${label} — 非TTS 片段 ${nonTts.length} 条（共 ${segs.length} 条）`);
  console.log("=".repeat(90));
  for (const x of nonTts) {
    const offMin = (x.start_ms / 60000).toFixed(1);
    console.log(`  seq=${String(x.source_seq).padStart(2)} [+${offMin}min] (${((x.end_ms - x.start_ms) / 1000).toFixed(1)}s) ${x.text}`);
  }
  console.log("");
}
db.close();
