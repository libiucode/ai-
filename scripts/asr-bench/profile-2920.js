const Database = require("D:\\ai盯播工具\\app\\node_modules\\better-sqlite3");
const db = new Database("C:\\Users\\libiu\\AppData\\Roaming\\ai-live-monitor\\live-monitor.db", { readonly: true });
const s = db.prepare("SELECT id, started_at_iso, ended_at_iso FROM sessions WHERE id LIKE '2920b432%'").get();
const segs = db.prepare("SELECT source_seq,start_ms,end_ms,text FROM transcript_segments WHERE session_id=? AND is_final=1 ORDER BY start_ms").all(s.id);
const si = db.prepare("SELECT start_ms,end_ms FROM speech_intervals WHERE session_id=? ORDER BY start_ms").all(s.id);
const epoch = new Date(s.started_at_iso).getTime();

console.log("=== 精确边界 ===");
console.log(`会话起止: ${(new Date(s.ended_at_iso).getTime()-epoch)/1000}s`);
// 最后一条干净片段（前4条）
const clean = segs.slice(0,4);
console.log(`\n前 4 条（干净广告口播）:`);
for(const x of clean) console.log(`  seq=${x.source_seq} [${(x.start_ms/1000).toFixed(1)}s-${(x.end_ms/1000).toFixed(1)}s] ${x.text.slice(0,45)}`);
console.log(`  → 干净段结束于 ${(clean[clean.length-1].end_ms/1000).toFixed(1)}s`);

// TTS 第一条
const ttsFirst = segs.find(x => /王炸|家人们|谁懂|回购/.test(x.text));
if(ttsFirst) console.log(`\nTTS 首条: seq=${ttsFirst.source_seq} [${(ttsFirst.start_ms/1000).toFixed(1)}s-${(ttsFirst.end_ms/1000).toFixed(1)}s] ${ttsFirst.text.slice(0,45)}`);

// 音频包停止/恢复
const merged=[]; for(const x of si){ const l=merged[merged.length-1]; if(!l||x.start_ms>l.end) merged.push({start:x.start_ms,end:x.end_ms}); else l.end=Math.max(l.end,x.end_ms); }
console.log(`\n音频包覆盖: ${(merged[0].start/1000).toFixed(1)}s ~ ${(merged[merged.length-1].end/1000).toFixed(1)}s`);
for(let i=1;i<merged.length;i++){ const g=merged[i].start-merged[i-1].end; if(g>10000) console.log(`  大空隙: ${(merged[i-1].end/1000).toFixed(1)}s → ${(merged[i].start/1000).toFixed(1)}s (${(g/1000).toFixed(1)}s)`); }

// 分区片段数
const dirty = segs.filter(x => x.start_ms >= 125000 && !/王炸|家人们|谁懂|回购/.test(x.text));
console.log(`\n分区片段数: 干净 ${clean.length} 条 / 污染段 ${segs.length-clean.length} 条（共 ${segs.length}）`);
db.close();