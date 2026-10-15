// 只读：查 5970a6d6 / d61e4b32 的「ASR 时间轴超出会话墙钟」异常根因。
// 现象：会话墙钟 326s，但 speech_intervals 的 end_ms 到 551s（超出 226s）。
const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true });

for (const short of ["5970a6d6", "d61e4b32", "2920b432"]) {
  const s = db.prepare("SELECT id, started_at_iso, ended_at_iso, status FROM sessions WHERE id LIKE ?").get(short + "%");
  if (!s) continue;
  const wall = (new Date(s.ended_at_iso) - new Date(s.started_at_iso)) / 1000;
  const iv = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id = ? ORDER BY start_ms").all(s.id);
  const seg = db.prepare("SELECT start_ms, end_ms FROM transcript_segments WHERE session_id = ? ORDER BY start_ms").all(s.id);

  console.log(`\n=== ${short} ===`);
  console.log(`墙钟 ${wall.toFixed(0)}s | 区间数 ${iv.length} | 片段数 ${seg.length}`);
  if (iv.length) {
    console.log(`  区间时间轴: ${iv[0].start_ms} → ${iv[iv.length - 1].end_ms} ms`);
    // 区间是否单调
    let back = 0;
    for (let i = 1; i < iv.length; i++) if (iv[i].start_ms < iv[i - 1].start_ms) back++;
    console.log(`  非单调次数: ${back}`);
    // 区间是否重叠/重复
    let dup = 0;
    for (let i = 1; i < iv.length; i++) if (iv[i].start_ms === iv[i - 1].start_ms && iv[i].end_ms === iv[i - 1].end_ms) dup++;
    console.log(`  完全重复区间数: ${dup}`);
    // 前 5 条与后 5 条
    console.log("  前5:", iv.slice(0, 5).map((r) => `${r.start_ms}-${r.end_ms}`).join(" "));
    console.log("  后5:", iv.slice(-5).map((r) => `${r.start_ms}-${r.end_ms}`).join(" "));
    // 区间总长 vs 跨度
    const spanSum = iv.reduce((a, r) => a + (r.end_ms - r.start_ms), 0);
    console.log(`  区间累加时长 ${(spanSum / 1000).toFixed(1)}s（若远大于跨度 ${(iv[iv.length - 1].end_ms / 1000).toFixed(1)}s 说明区间重叠）`);
  }
  if (seg.length) {
    console.log(`  片段时间轴: ${seg[0].start_ms} → ${seg[seg.length - 1].end_ms} ms`);
  }
  // 是否有超过墙钟的区间
  const over = iv.filter((r) => r.end_ms / 1000 > wall + 5);
  console.log(`  超过墙钟的区间数: ${over.length} / ${iv.length}`);
}

db.close();
