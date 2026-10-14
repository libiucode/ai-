import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage/store";
import { verifyRealWindow } from "../src/main/analysis/verifyRealWindow";

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("DSH_SECRET_LLM_API_KEY", "fixture-script-secret");
  vi.stubEnv("DSH_LLM_BASE_URL", "http://127.0.0.1:3425/v1");
  vi.stubEnv("DSH_LLM_MODEL", "group/auto-step-5-preview");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("真实窗口验证脚本（以下来源库与服务均为模拟）", () => {
  it("读取来源库不写回，实际分析与报告使用隔离库，凭据不落盘", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-window-harness-fixture-")); dirs.push(dir);
    const dbPath = path.join(dir, "source.db"); const outputPath = path.join(dir, "verification.json");
    const source = new Store(dbPath);
    source.createSession({ id: "source-fixture", startedAtIso: "2026-10-14T13:00:00Z", audioSource: "microphone", deviceId: null });
    source.saveFramework({ id: "fw", name: "模拟材质框架", productFacts: "模拟500mL杯", updatedAt: "2026-10-14T13:00:00Z", steps: [{ id: "facts", frameworkId: "fw", name: "材质和容量", priority: 2, maxWaitMs: 120000 }], rules: [] });
    source.insertSegment({ id: "source-seg", sessionId: "source-fixture", connectionId: "source-connection", sourceSeq: 0, startMs: 0, endMs: 5000, text: "这是500毫升的杯子", isFinal: true, createdAt: "2026-10-14T13:00:05Z" });
    source.insertSpeechInterval({ id: "speech", sessionId: "source-fixture", startMs: 0, endMs: 5000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ issues: [{ type: "other", severity: "info", segmentIds: ["source-seg"], quote: "500毫升", basis: "fixture only", recommendation: "fixture only", confidence: 0.9, needsReview: true }] }) } }] }) }));
    const result = await verifyRealWindow({ dbPath, outputPath, sessionId: "source-fixture", windowEndMs: 60000, confirmedRealAsr: true, sourceLabel: "脚本单测模拟来源，非真实录音" });
    expect(result).toMatchObject({ status: "success", issueCount: 1, allEvidenceValid: true, requestCount: 1, transcriptSegmentCount: 1 });
    expect(source.analysisRunStats("source-fixture").total).toBe(0);
    expect(source.listIssues("source-fixture")).toEqual([]);
    const report = fs.readFileSync(outputPath, "utf8"); expect(report).not.toContain("fixture-script-secret");
    expect(fs.existsSync(`${outputPath}.html`)).toBe(true);
    expect(JSON.parse(report).reviewStatus.reviewedRealCandidates).toBe(0);
    source.close();
  });
  it("没有来源确认或正整数窗口时不发送请求", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const opts = { dbPath: "absent.db", outputPath: "absent.json", sessionId: "unknown", windowEndMs: 60000, confirmedRealAsr: false, sourceLabel: "" };
    await expect(verifyRealWindow(opts)).rejects.toThrow("真实ASR来源");
    await expect(verifyRealWindow({ ...opts, confirmedRealAsr: true, sourceLabel: "模拟测试", windowEndMs: -1 })).rejects.toThrow("正的会话相对毫秒数");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("目标与Chief锁定口径不一致时拒绝发送，绝不隐式发密钥到别处", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    // 环境已是锁定端点；这里让公开设置指向另一个端点，模拟配置漂移。
    vi.stubEnv("DSH_LLM_BASE_URL", "https://api.example.invalid/v1");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-window-lock-fixture-")); dirs.push(dir);
    const dbPath = path.join(dir, "source.db"); const outputPath = path.join(dir, "v.json");
    const source = new Store(dbPath);
    source.createSession({ id: "lock-fixture", startedAtIso: "2026-10-14T13:00:00Z", audioSource: "microphone", deviceId: null });
    source.saveFramework({ id: "fw", name: "模拟框架", productFacts: "模拟事实", updatedAt: "2026-10-14T13:00:00Z", steps: [{ id: "facts", frameworkId: "fw", name: "卖点", priority: 2, maxWaitMs: 120000 }], rules: [] });
    source.insertSegment({ id: "lock-seg", sessionId: "lock-fixture", connectionId: "lock-connection", sourceSeq: 0, startMs: 0, endMs: 5000, text: "模拟片段", isFinal: true, createdAt: "2026-10-14T13:00:05Z" });
    source.insertSpeechInterval({ id: "lock-speech", sessionId: "lock-fixture", startMs: 0, endMs: 5000 });
    // 公开设置里是另一个端点，安全密钥属于锁定端点：必须先确认，不得发送。
    source.setSetting("app_settings", JSON.stringify({ llm: { base_url: "https://api.example.invalid/v1", model: "some-other-model" } }));
    await expect(verifyRealWindow({ dbPath, outputPath, sessionId: "lock-fixture", windowEndMs: 60000, confirmedRealAsr: true, sourceLabel: "模拟测试来源" })).rejects.toThrow(/不一致/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
    source.close();
  });
});
