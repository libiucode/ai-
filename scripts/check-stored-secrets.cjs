// 只读安全检查：本机真实库里是否残留明文凭证（只判断形态，绝不打印任何值）。
// 背景：settings 表历史上有 llm_api_key 与 asr_config（含 secretId/secretKey）明文。
// runtimeConfig 已改为只读环境变量、不再读它们，但历史数据仍可能留在库里。
const path = require("node:path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

const db = new Database(path.join(process.env.APPDATA, "ai-live-monitor", "live-monitor.db"), { readonly: true });

/** 判断一个字符串是否像真实凭证：有足够长度、且不是占位符。 */
function shape(v) {
  if (typeof v !== "string" || v.length === 0) return "空";
  if (/^[xX*\-_.]+$/.test(v)) return "占位符（全 x/*/-/_）";
  if (v === "undefined" || v === "null") return "字面量 null/undefined";
  if (v.length < 8) return `过短(${v.length})，不构成凭证`;
  return `像真实值（长度 ${v.length}，含大写${/[A-Z]/.test(v) ? "是" : "否"}，含小写${/[a-z]/.test(v) ? "是" : "否"}，含数字${/[0-9]/.test(v) ? "是" : "否"}）`;
}

const rows = db.prepare("SELECT key, value FROM settings").all();
console.log("=== settings 表凭证残留检查（不打印任何值）===\n");
for (const r of rows) {
  if (r.key === "llm_api_key") {
    console.log(`[llm_api_key] ${shape(r.value)}`);
  } else if (r.key === "asr_config") {
    let p = null;
    try { p = JSON.parse(r.value); } catch { /* ignore */ }
    console.log("[asr_config]");
    if (p && typeof p === "object") {
      for (const k of ["secretId", "secretKey", "appId", "provider"]) {
        console.log(`  ${k}: ${shape(p[k])}`);
      }
      console.log(`  其余字段: ${Object.keys(p).filter((k) => !["secretId", "secretKey", "appId", "provider"].includes(k)).join(", ")}`);
    } else {
      console.log(`  非 JSON，${shape(r.value)}`);
    }
  } else {
    console.log(`[${r.key}] 非凭证键（长度 ${r.value.length}）`);
  }
}

console.log("\n=== 结论 ===");
const llm = rows.find((r) => r.key === "llm_api_key");
const asr = rows.find((r) => r.key === "asr_config");
const concerns = [];
if (llm && shape(llm.value).startsWith("像真实值")) concerns.push("llm_api_key 含疑似真实值");
if (asr) {
  let p = null;
  try { p = JSON.parse(asr.value); } catch { /* ignore */ }
  for (const k of ["secretId", "secretKey"]) {
    if (p && shape(p[k]).startsWith("像真实值")) concerns.push(`asr_config.${k} 含疑似真实值`);
  }
}
if (concerns.length) {
  console.log("⚠ 需要处理：");
  for (const c of concerns) console.log("  - " + c);
  console.log("  （runtimeConfig 已不读它们，所以不影响运行；但明文留在磁盘上仍是风险，");
  console.log("    建议清空这两个键——它们已被环境变量取代，清掉不会影响功能。）");
} else {
  console.log("✓ 未发现明文凭证：两个历史键要么是占位符、要么是空/过短值。");
}
db.close();
