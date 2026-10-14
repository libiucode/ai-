/**
 * 核对时间锚定：对比 app 写入的 created_at（真实墙上时间）与 start_ms（会话相对时间），
 * 判断 asrAudioStartMs 锚定是否存在系统性偏移。
 * 只读。
 */
const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });

const sessionId = process.argv[2] || "2920b432";
const s = db.prepare("SELECT id, started_at_iso FROM sessions WHERE id LIKE ? ORDER BY started_at_iso DESC LIMIT 1").get(sessionId + "%");
if (!s) { console.log("session not found"); process.exit(1); }
const epoch = new Date(s.started_at_iso).getTime();
console.log("session:", s.id);
console.log("started_at_iso:", s.started_at_iso);

const segs = db.prepare(
  "SELECT source_seq, start_ms, end_ms, text, created_at, connection_id FROM transcript_segments WHERE session_id = ? AND is_final = 1 ORDER BY start_ms"
).all(s.id);

console.log("\nseq  start_ms  end_ms   created_at(+ms)  误差(created-start)  conn");
for (const x of segs) {
  const createdRel = new Date(x.created_at).getTime() - epoch;
  const delta = createdRel - x.end_ms;
  console.log(
    `${String(x.source_seq).padEnd(4)} ${String(x.start_ms).padStart(8)}  ${String(x.end_ms).padStart(7)}  ${String(createdRel).padStart(8)}        ${String(delta).padStart(8)}         ${String(x.connection_id).slice(0, 8)}`
  );
}

// 语音间隔粒度：验证是否 200ms 细粒度
const si = db.prepare("SELECT start_ms, end_ms FROM speech_intervals WHERE session_id = ? ORDER BY start_ms").all(s.id);
const durations = si.map((x) => x.end_ms - x.start_ms);
const uniq = [...new Set(durations)];
console.log("\nspeech_intervals:", si.length, "条");
console.log("间隔时长取值:", uniq.slice(0, 10).join(", "), uniq.length > 10 ? "..." : "");
const spanMs = si.length ? si[si.length - 1].end_ms - si[0].start_ms : 0;
console.log("覆盖时长:", (spanMs / 1000).toFixed(1), "s  平均每条:", (spanMs / si.length).toFixed(0), "ms");
db.close();
