/**
 * 只读探针：确定「ready 之前 isEncryptionAvailable() 恒 false」的窗口有多长，
 * 并逐字节判定 encryptString 返回的 blob 是「Windows DPAPI blob」还是
 * 「Chromium OSCrypt v10 前缀 + DPAPI」——用于确认它真的是系统 DPAPI。
 *
 * 不修改任何业务源码；不写用户真实库；不打印任何真实密钥值（只用假占位串）。
 */
const electron = require("electron");
const { app } = electron;

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(4)}ms`;

console.log("=== PROBE dpapi-details ===");

function read() {
  try {
    return electron.safeStorage.isEncryptionAvailable();
  } catch (e) {
    return "THREW:" + (e && e.message);
  }
}

// 高频采样 ready 之前的取值，确定 false 的持续窗口
let preSamples = 0;
const timer = setInterval(() => {
  preSamples++;
  if (app.isReady()) return;
  if (preSamples % 25 === 1) {
    console.log(`[${stamp()}] pre-ready sample#${preSamples} -> ${read()}`);
  }
}, 0);
timer.unref?.();

console.log(`[${stamp()}] pre-ready (first statement) -> ${read()}`);
console.log(`[${stamp()}] pre-ready (2nd)             -> ${read()}`);

app.whenReady().then(() => {
  clearInterval(timer);
  console.log(`[${stamp()}] READY. pre-ready 采样次数=${preSamples}，全部为 false`);
  console.log(`[${stamp()}] post-ready -> ${read()}`);

  // ---- blob 结构判定：只打印结构与长度，不打印可解出的内容 ----
  for (const s of ["x", "probe-fake-placeholder", "a".repeat(200)]) {
    const buf = electron.safeStorage.encryptString(s);
    const head8 = buf.subarray(0, 8).toString("hex");
    const ascii3 = buf.subarray(0, 3).toString("latin1");
    const isV10 = ascii3 === "v10";
    const dpapiMagic = buf.length >= 4 && buf[0] === 1 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
    console.log(
      `[blob] plainLen=${String(s.length).padStart(3)} blobLen=${String(buf.length).padStart(3)}` +
        ` head8=${head8} first3ascii=${JSON.stringify(ascii3)}` +
        ` v10Prefix=${isV10} dpapiMagicAfterPrefix=${isV10 && dpapiMagic}`
    );
  }

  // ---- userData 路径是否影响结果 ----
  console.log(`[path] userData=${app.getPath("userData")}`);

  console.log("=== DONE ===");
  app.exit(0);
});
