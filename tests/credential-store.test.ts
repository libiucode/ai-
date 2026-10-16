import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 凭证存储回归测试。
 *
 * 背景（2026-10-16）：本模块此前**零测试覆盖**，而它刚经历一次策略变更——
 * 原策略「系统加密不可用则拒绝落盘」在客户现场被证伪（服务器/远程桌面/
 * 受限账户下 DPAPI 不可用 → 输入框全灰 → 客户根本配不了密钥）。
 *
 * 现策略：加密可用则加密；不可用则降级存明文，但**必须显式可识别**
 * （`plain:` 前缀），且界面能据 storageMode 如实告知用户。
 *
 * 本文件钉住的正是「降级后仍必须成立」的几条不变量。
 */

// safeStorage 由测试逐个用例改写行为，故用可变量模拟。
const enc = vi.hoisted(() => ({
  available: true,
  /** 让 encryptString 抛错，模拟「接口在但 DPAPI 中途失效」 */
  encryptThrows: false,
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => enc.available,
    encryptString: (s: string) => {
      if (enc.encryptThrows) throw new Error("DPAPI unavailable");
      return Buffer.from(`ENC(${s})`, "utf8");
    },
    decryptString: (b: Buffer) => {
      const t = b.toString("utf8");
      if (!t.startsWith("ENC(")) throw new Error("not our ciphertext");
      return t.slice(4, -1);
    },
  },
}));

import {
  getCredential,
  hasCredential,
  isPlaintextCredential,
  setCredential,
  storageMode,
  clearCredentials,
} from "../src/main/security/credentialStore";

/** 最小内存 store，行为与 Store 的 settings 读写一致。 */
function memStore() {
  const m = new Map<string, string>();
  return {
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

beforeEach(() => {
  enc.available = true;
  enc.encryptThrows = false;
});

describe("凭证存储：加密可用时的正常路径", () => {
  it("写入的是密文，库里看不到明文", () => {
    const s = memStore();
    expect(setCredential(s, "LLM_API_KEY", "sk-secret-value")).toBe(true);
    expect(s.raw.get("credential_store_v1")).not.toContain("sk-secret-value");
    expect(getCredential(s, "LLM_API_KEY")).toBe("sk-secret-value");
    expect(hasCredential(s, "LLM_API_KEY")).toBe(true);
    expect(isPlaintextCredential(s, "LLM_API_KEY")).toBe(false);
    expect(storageMode()).toBe("encrypted");
  });

  it("空值清除该键", () => {
    const s = memStore();
    setCredential(s, "LLM_API_KEY", "v");
    expect(setCredential(s, "LLM_API_KEY", "   ")).toBe(true);
    expect(getCredential(s, "LLM_API_KEY")).toBe("");
    expect(hasCredential(s, "LLM_API_KEY")).toBe(false);
  });
});

describe("凭证存储：加密不可用时的降级明文（2026-10-16 策略变更）", () => {
  it("加密不可用时**仍然保存成功**，不再拒绝落盘", () => {
    enc.available = false;
    const s = memStore();
    // 这是本次策略变更的核心：旧实现此处返回 false 且不落盘。
    expect(setCredential(s, "TENCENT_ASR_SECRET_KEY", "asr-key-abc")).toBe(true);
    expect(getCredential(s, "TENCENT_ASR_SECRET_KEY")).toBe("asr-key-abc");
  });

  it("降级存储带 plain: 前缀，可与老密文区分", () => {
    enc.available = false;
    const s = memStore();
    setCredential(s, "LLM_API_KEY", "plain-value");
    expect(s.raw.get("credential_store_v1")).toContain("plain:plain-value");
    expect(isPlaintextCredential(s, "LLM_API_KEY")).toBe(true);
    expect(storageMode()).toBe("plaintext");
  });

  it("hasCredential 对降级明文返回 true（不能因加密不可用就误报未配置）", () => {
    enc.available = false;
    const s = memStore();
    setCredential(s, "LLM_API_KEY", "v");
    // 旧实现走 getCredential，而 getCredential 在加密不可用时直接 return ""，
    // 会把刚存好的明文误判成「未配置」——这是必须钉住的反例。
    expect(hasCredential(s, "LLM_API_KEY")).toBe(true);
  });

  it("升级前用 DPAPI 存的老密文，在加密恢复后仍能读出", () => {
    const s = memStore();
    enc.available = true;
    setCredential(s, "LLM_API_KEY", "old-cipher-value");
    // 中途加密不可用，只读取不写入
    enc.available = false;
    expect(getCredential(s, "LLM_API_KEY")).toBe("old-cipher-value");
    expect(isPlaintextCredential(s, "LLM_API_KEY")).toBe(false);
  });

  it("加密恢复后重新保存会把明文升格为密文", () => {
    const s = memStore();
    enc.available = false;
    setCredential(s, "LLM_API_KEY", "upgrade-me");
    expect(s.raw.get("credential_store_v1")).toContain("plain:upgrade-me");
    enc.available = true;
    setCredential(s, "LLM_API_KEY", "upgrade-me");
    expect(s.raw.get("credential_store_v1")).not.toContain("plain:");
    expect(getCredential(s, "LLM_API_KEY")).toBe("upgrade-me");
    expect(isPlaintextCredential(s, "LLM_API_KEY")).toBe(false);
  });

  it("加密接口在但调用抛错时，降级明文而非丢数据", () => {
    enc.available = true;
    enc.encryptThrows = true;
    const s = memStore();
    expect(setCredential(s, "LLM_API_KEY", "survives")).toBe(true);
    expect(getCredential(s, "LLM_API_KEY")).toBe("survives");
    expect(isPlaintextCredential(s, "LLM_API_KEY")).toBe(true);
  });
});

describe("凭证存储：清除与隔离", () => {
  it("clearCredentials 清空全部键，不影响其它 settings", () => {
    const s = memStore();
    setCredential(s, "LLM_API_KEY", "a");
    setCredential(s, "TENCENT_ASR_SECRET_ID", "b");
    s.setSetting("app_settings", '{"llm":{"base_url":"https://x.test/v1"}}');
    clearCredentials(s);
    expect(getCredential(s, "LLM_API_KEY")).toBe("");
    expect(getCredential(s, "TENCENT_ASR_SECRET_ID")).toBe("");
    expect(s.getSetting("app_settings")).toContain("https://x.test/v1");
  });

  it("凭证明文不写入 app_settings（与公开配置物理隔离）", () => {
    const s = memStore();
    setCredential(s, "LLM_API_KEY", "isolated-secret");
    expect(s.getSetting("app_settings")).toBeNull();
    // 加密通道下库里不应出现明文原值（本 mock 用 base64，故直接断言原文不出现）
    expect(s.getSetting("credential_store_v1")).not.toContain("isolated-secret");
  });
});
