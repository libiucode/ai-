const fs = require("node:fs");
const p = "D:\\ai盯播工具\\app\\evidence\\session-profiles.json";
const raw = fs.readFileSync(p, "utf8");   // 按 UTF-8 读
const j = JSON.parse(raw);
console.log("generatedAt:", j.generatedAt, " sessions:", j.sessions.length);
console.log("\n=== 摘要表（含内容跳变点）===");
console.log("会话      片段  区间  最大空隙  位置           跳变  状态");
for(const s of j.sessions){
  const gap = (s.maxGapMs/1000).toFixed(1)+"s";
  const pos = `${(s.maxGapFrom/1000).toFixed(1)}→${(s.maxGapTo/1000).toFixed(1)}s`;
  console.log(`${s.id.slice(0,8)}  ${String(s.segments).padStart(4)}  ${String(s.intervals).padStart(4)}  ${gap.padStart(7)}  ${pos.padEnd(14)}  ${String((s.contentJumps||[]).length).padStart(3)}   ${s.status}`);
}
console.log("\n=== 关键样本文本（验证编码）===");
const b = j.sessions.find(s=>s.id.startsWith("b217299a"));
console.log("b217299a 首条:", b.headTexts[0].text.slice(0,40));
const m = j.sessions.find(s=>s.id.startsWith("2920b432"));
if(m){ console.log("2920b432 首条:", m.headTexts[0].text.slice(0,40)); console.log("2920b432 跳变:", JSON.stringify(m.contentJumps)); }