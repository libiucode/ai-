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
 */

/** 支持的凭证键。值不落日志、不进报告。 */
export type CredentialKey =
  | "TENCENT_ASR_SECRET_ID"
  | "TENCENT_ASR_SECRET_KEY"
  | "LLM_API_KEY";

/** 存储键：与业务 settings 分开，避免误当公开配置回显。 */
const STORAGE_KEY = "credential_store_v1";

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

/** 是否有可用的系统级加密。不可用时禁止落盘。 */
export function credentialStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 写入凭证。系统加密不可用时返回 false 且**不落盘**（宁可不存，也不存明文）。
 * 空值视为清除该键。
 */
export function setCredential(
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string): void },
  key: CredentialKey,
  value: string,
): boolean {
  if (!credentialStorageAvailable()) return false;
  const next = readRaw(store);
  const trimmed = value.trim();
  if (!trimmed) {
    delete next[key];
  } else {
    try {
      next[key] = safeStorage.encryptString(trimmed).toString("base64");
    } catch {
      return false;
    }
  }
  writeRaw(store, next);
  return true;
}

/** 读取凭证。解密失败（换机器/换用户）返回空串，不抛错。 */
export function getCredential(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): string {
  if (!credentialStorageAvailable()) return "";
  const raw = readRaw(store)[key];
  if (!raw) return "";
  try {
    return safeStorage.decryptString(Buffer.from(raw, "base64"));
  } catch {
    return "";
  }
}

/** 该凭证是否已存在（用于界面显示「已配置」而不是回显明文）。 */
export function hasCredential(
  store: { getSetting(key: string): string | null },
  key: CredentialKey,
): boolean {
  return getCredential(store, key).length > 0;
}

/** 清空所有已存凭证（「清除本机凭证」按钮）。 */
export function clearCredentials(store: {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}): void {
  writeRaw(store, {});
}
