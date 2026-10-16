import { safeStorage } from "electron";

/**
 * 凭证存储：把用户填的密钥加密后存本机，不存明文。
 *
 * 背景：早期版本为了"绝不落盘明文"，把密钥入口整个砍掉，只允许环境变量。
 *      结果普通用户双击图标启动后根本无从配置 —— 安全了但没法用。
 *      这里改成双通道：界面填（加密存本机） + 环境变量（CI/自动化，
 *      优先级更高），两者都能用，由 `runtimeConfig` 决定取值顺序。
 *
 * 加密方式：Electron `safeStorage`
 *      - Windows：DPAPI，密文绑定当前 Windows 用户账户
 *      - macOS：Keychain
 *      - Linux：系统密钥环，不可用时 `isEncryptionAvailable()` 返回 false
 *
 * 边界（诚实声明）：
 *      - 密文存在本机 SQLite，换机器/换 Windows 用户后无法解密（会当作未配置）
 *      - 同一台机器上的**其它程序**若以同一用户运行，理论上可调用同样的
 *        DPAPI 接口解密。这不是"防 root/防同用户恶意软件"的方案，
 *        它解决的是"明文落在磁盘上被随手看到/被全文检索到"这一层风险。
 *      - 因此：有密钥的环境仍**优先用环境变量**，界面存储只作为便利选项。
 *
 * ⚠️ 降级明文存储（2026-10-16 决策变更，**不再是红线**）
 *
 * 原策略（至 2026-10-16 止）：系统加密不可用时**拒绝落盘**，输入框禁用，
 * 提示用户「请改用环境变量启动本应用」。
 *
 * 该策略在客户现场被证伪：Windows 服务器 / 远程桌面会话 / 受限账户 /
 * 企业安全策略下 `safeStorage.isEncryptionAvailable()` 会返回 false，
 * 此时客户双击图标打开设置页，看到的是一排**灰掉的输入框**加一句
 * 「请改用环境变量启动本应用」——客户根本无从配置，工具等于不可用。
 *
 * 现策略：**加密可用则加密；不可用则降级为明文存储，但必须显式可识别**。
 *      - 降级密文在库里带 `plain:` 前缀，一眼可辨，不会与真密文混淆
 *      - 界面据 `storageMode()` 返回的 `"encrypted" | "plaintext" | "none"`
 *        显示醒目警告，如实告知用户「密钥以明文保存在本机」
 *      - 一旦系统加密恢复可用，下次写入会自动升格回加密密文（见 setCredential）
 *
 * 这是一次**有意识的取舍**：把「配置不了」的必然损失，
 * 换成「明文落盘」的可控风险，并且把风险如实告知用户，由用户决定。
 */

/** 支持的凭证键。值不落日志、不进报告。 */
export type CredentialKey =
  | "TENCENT_ASR_SECRET_ID"
  | "TENCENT_ASR_SECRET_KEY"
  | "LLM_API_KEY";

/** 存储键：与业务 settings 分开，避免误当公开配置回显。 */
const STORAGE_KEY = "credential_store_v1";

/**
 * 降级明文存储的前缀标记。
 *
 * 为什么要有前缀：库里可能同时存在「升级前用 DPAPI 存的老密文」和
 * 「降级后存的明文」。没有标记就无法区分——把明文当密文解会抛错（可捕获），
 * 但把密文当明文用会让 ASR 拿到一串 base64 而报「鉴权失败」，
 * 那是极难排查的故障。所以显式打标，两种形态各自可辨。
 */
const PLAIN_PREFIX = "plain:";

function readRaw(store: { getSetting(key: string): string | null }): Record<string, string> {
  try {
    const raw = store.getSetting(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeRaw(store: { setSetting(key: string, value: string): void }, next: Record<string, string>): void {
  store.setSetting(STORAGE_KEY, JSON.stringify(next));
}

/** 是否有可用的系统级加密。 */
export function credentialStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 本机凭证的实际存储形态，供界面如实告知用户。
 *
 * - `encrypted`：系统加密可用，写入的是密文（DPAPI / Keychain / 密钥环）
 * - `plaintext`：系统加密不可用，写入的是**明文**（带 `plain:` 前缀）
 * - `none`：保留态。降级明文保证了「总能写」，正常路径不会返回它
 */
export type CredentialStorageMode = "encrypted" | "plaintext" | "none";

export function storageMode(): CredentialStorageMode {
  return credentialStorageAvailable() ? "encrypted" : "plaintext";
}

/**
 * 写入凭证。
 *
 * 加密可用 → 存密文；不可用 → 降级存明文（带 `PLAIN_PREFIX` 标记），
 * **不再拒绝落盘**。详见文件头的「降级明文存储」说明。
 *
 * ## ⚠️ 不可逆降级保护（2026-10-16，由 DPAPI 调查结论触发）
 *
 * 若某次运行处于「加密不可用」（典型来源：**在 `app.whenReady()` 之前调用**——
 * 实测该状态下 `isEncryptionAvailable()` 恒为 false，见
 * `scripts/probe-dpapi-timing.js`；以及 `ELECTRON_RUN_AS_NODE=1` 的纯 Node 环境、
 * CI / 无头自动化），此时若用户重新保存，**明文会覆盖掉原本可用的密文**，
 * 且不可逆——用户以为「只是改了个 key」，实际把它从加密降级成了明文。
 *
 * 因生产环境库路径稳定（`app.getPath("userData")`），这会真实命中用户的库。
 * 故此处加一道闸：**旧值已是密文、而当前加密不可用时，拒绝用明文覆盖**，
 * 返回 false 并把原因交给调用方呈现。用户仍可通过「清除本机凭证」显式重来。
 *
 * 空值视为清除该键（清除不受此闸限制——用户显式要求删）。
 */
export function setCredential(
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void },
  key: CredentialKey,
  value: string,
): boolean {
  const next = readRaw(store);
  const trimmed = value.trim();
  if (!trimmed) {
    delete next[key];
    writeRaw(store, next);
    return true;
  }
  const existingRaw = next[key];
  const existingIsCiphertext = Boolean(existingRaw && !existingRaw.startsWith(PLAIN_PREFIX));
  if (credentialStorageAvailable()) {
    try {
      next[key] = safeStorage.encryptString(trimmed).toString("base64");
      writeRaw(store, next);
      return true;
    } catch {
      // 加密接口在但调用失败（DPAPI 被策略中途禁用等）。
      // 同样受降级保护约束：不覆盖已有密文。
      if (existingIsCiphertext) return false;
      next[key] = PLAIN_PREFIX + trimmed;
      writeRaw(store, next);
      return true;
    }
  }
  // 加密不可用。已有密文时拒绝降级覆盖（见上方注释）。
  if (existingIsCiphertext) return false;
  next[key] = PLAIN_PREFIX + trimmed;
  writeRaw(store, next);
  return true;
}

/**
 * 判断写入是否会被「不可逆降级保护」拒绝。
 *
 * 调用方（IPC / 界面）据此给出可执行的说明，而不是笼统的「保存失败」——
 * 用户需要知道的是「这会破坏你已有的加密凭证」，而不是「出错了」。
 */
export function wouldDowngradeCiphertext(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): boolean {
  if (credentialStorageAvailable()) return false;
  const raw = readRaw(store)[key];
  return Boolean(raw && !raw.startsWith(PLAIN_PREFIX));
}

/**
 * 读取凭证。解密失败（换机器 / 换用户）返回空串，不抛错。
 *
 * 明文（`PLAIN_PREFIX` 前缀）直接返回，不尝试解密。
 *
 * ⚠️ 不在这里前置判断 `isEncryptionAvailable()`：
 * 密文解密的成败由 `decryptString` 自己决定（换机器会抛错 → 返回空串）。
 * 若前置判断，一旦加密接口瞬时不可用，用户**已存好的密钥会突然变成「未配置」**，
 * 而且界面不会有任何解释——这种「静默变成没配置」比解密失败更难排查。
 */
export function getCredential(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): string {
  const raw = readRaw(store)[key];
  if (!raw) return "";
  if (raw.startsWith(PLAIN_PREFIX)) return raw.slice(PLAIN_PREFIX.length);
  try {
    return safeStorage.decryptString(Buffer.from(raw, "base64"));
  } catch {
    return "";
  }
}

/**
 * 该凭证是否已存在（用于界面显示「已配置」而不是回显明文）。
 *
 * 明文与密文都算「已配置」。同样不做加密可用性前置判断——理由见 getCredential。
 */
export function hasCredential(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): boolean {
  const raw = readRaw(store)[key];
  if (!raw) return false;
  if (raw.startsWith(PLAIN_PREFIX)) return raw.length > PLAIN_PREFIX.length;
  try {
    return safeStorage.decryptString(Buffer.from(raw, "base64")).length > 0;
  } catch {
    return false;
  }
}

/** 该键是否以明文形态存放（界面据此显示「明文存储」警告）。 */
export function isPlaintextCredential(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): boolean {
  const raw = readRaw(store)[key];
  return Boolean(raw && raw.startsWith(PLAIN_PREFIX));
}

/** 清空所有已存凭证（「清除本机凭证」按钮）。 */
export function clearCredentials(store: {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}): void {
  writeRaw(store, {});
}
