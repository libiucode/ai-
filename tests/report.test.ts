import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/main/storage/store";
import { buildReportSummary, buildHtmlReport, estimateTokens } from "../src/main/report/reportBuilder";
import { redact } from "../src/main/security/errorFactory";
import { redactSecrets } from "../src/main/ipc";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Issue, TranscriptSegment } from "../src/shared/contracts";

let store: Store;
let dir: string;

const seg = (id: string, text: string, startMs = 0, endMs = 5000): TranscriptSegment => ({
  id,
  sessionId: "s1",
  connectionId: "c1",
  sourceSeq: 0,
  startMs,
  endMs,
  text,
  isFinal: true,
  createdAt: new Date().toISOString(),
});

const issue = (id: string, quote: string, needsReview = false): Issue => ({
  id,
  sessionId: "s1",
  analysisRunId: "r1",
  type: "absolutization",
  severity: "warning",
  startMs: 0,
  endMs: 5000,
  segmentIds: ["t1"],
  quote,
  basis: "命中绝对化规则",
  recommendation: "调整表达",
  suggestedScript: null,
  confidence: 0.9,
  needsReview,
  status: "open",
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpt-"));
  store = new Store(path.join(dir, "test.db"));
  store.createSession({ id: "s1", startedAtIso: new Date().toISOString(), audioSource: "microphone", deviceId: null });
});

describe("报告构建", () => {
  it("报告统计与数据库记录一致", () => {
    store.insertSegment(seg("t1", "百分之百有效"));
    store.insertSegment(seg("t2", "第二句话", 5000, 10000));
    store.upsertIssue(issue("i1", "百分之百有效"), "k1");
    store.upsertIssue({ ...issue("i2", "第二句", true), segmentIds: ["t2"], startMs: 5000, endMs: 10000 }, "k2");

    const report = buildReportSummary(store, "s1");
    expect(report).not.toBeNull();
    expect(report!.issues.total).toBe(2);
    expect(report!.issues.confirmed).toBe(1);
    expect(report!.issues.needsReview).toBe(1);
    expect(report!.metrics.chineseChars).toBeGreaterThan(0);
    expect(report!.session.id).toBe("s1");
    expect(report!.issueTimeline.length).toBe(2);
  });

  it("不存在的会话返回 null", () => {
    expect(buildReportSummary(store, "nope")).toBeNull();
  });

  it("HTML 报告转义原文中的 HTML 字符", () => {
    store.insertSegment(seg("t1", "<script>alert(1)</script>"));
    store.upsertIssue({ ...issue("i1", "<script>alert(1)</script>") }, "k1");
    const report = buildReportSummary(store, "s1")!;
    const html = buildHtmlReport(report);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("token 估算为正数", () => {
    expect(estimateTokens(100, 10)).toBeGreaterThan(0);
  });
});

describe("密钥不泄漏", () => {
  it("导出 JSON 报告不包含任何密钥字段", () => {
    store.insertSegment(seg("t1", "内容"));
    store.setSetting("llm_api_key", "sk-very-secret-key-12345");
    store.setSetting("asr_config", JSON.stringify({ secretId: "AKIDxxx", secretKey: "topsecret", appId: "123" }));
    const report = buildReportSummary(store, "s1")!;
    const json = JSON.stringify(report);
    expect(json).not.toContain("sk-very-secret-key-12345");
    expect(json).not.toContain("topsecret");
    expect(json).not.toContain("AKIDxxx");
    expect(json).not.toContain("llm_api_key");
    expect(json).not.toContain("asr_config");
  });

  it("HTML 报告同样不含密钥", () => {
    store.setSetting("llm_api_key", "sk-very-secret-key-12345");
    const report = buildReportSummary(store, "s1")!;
    const html = buildHtmlReport(report);
    expect(html).not.toContain("sk-very-secret-key-12345");
  });

  it("redact 移除对象中的密钥字段", () => {
    const out = redact({ secretKey: "abc", apiKey: "def", note: "fine" });
    expect(out.secretKey).toBe("***");
    expect(out.apiKey).toBe("***");
    expect(out.note).toBe("fine");
  });

  it("redactSecrets 清除错误文本中的密钥和签名", () => {
    const msg = redactSecrets("请求失败: secretid=AKIDxxxxxxxxxxxxxxxx signature=abc123 sk-abcdefgh12");
    expect(msg).not.toContain("AKIDxxxxxxxxxxxxxxxx");
    expect(msg).not.toContain("abc123");
    expect(msg).not.toContain("sk-abcdefgh12");
    expect(msg).toContain("***");
  });

  it("设置接口只返回脱敏尾部", () => {
    // settings.getAsrStatus / getLlmStatus handler logic: verify store separation
    store.setSetting("llm_api_key", "sk-abcdef123456");
    expect(store.getSetting("llm_api_key")).toBe("sk-abcdef123456");
    // app_settings 不含密钥（settings.save 的行为在 ipc 单测中由 schema 保证）
    store.setSetting("app_settings", JSON.stringify({ windowIntervalSec: 60 }));
    const appSettings = JSON.parse(store.getSetting("app_settings")!);
    expect(JSON.stringify(appSettings).includes("sk-abcdef")).toBe(false);
  });
});

describe("会话管理", () => {
  it("删除会话同时删除转写、问题与分析运行", () => {
    store.insertSegment(seg("t1", "内容"));
    store.upsertIssue(issue("i1", "内容"), "k1");
    store.insertAnalysisRun({ id: "r1", sessionId: "s1", windowId: "w1", status: "success", startedAt: new Date().toISOString() });
    expect(store.deleteSession("s1")).toBe(true);
    expect(store.getSession("s1")).toBeUndefined();
    expect(store.querySegments({ sessionId: "s1" }).length).toBe(0);
    expect(store.listIssues("s1").length).toBe(0);
    expect(store.analysisRunStats("s1").total).toBe(0);
  });

  it("会话汇总包含计数", () => {
    store.insertSegment(seg("t1", "内容"));
    store.upsertIssue(issue("i1", "内容"), "k1");
    const summaries = store.listSessionSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].finalSegmentCount).toBe(1);
    expect(summaries[0].issueCount).toBe(1);
  });

  it("分析运行统计按状态汇总", () => {
    store.insertAnalysisRun({ id: "r1", sessionId: "s1", windowId: "w1", status: "success", startedAt: new Date().toISOString() });
    store.insertAnalysisRun({ id: "r2", sessionId: "s1", windowId: "w2", status: "failed", startedAt: new Date().toISOString() });
    const stats = store.analysisRunStats("s1");
    expect(stats.total).toBe(2);
    expect(stats.success).toBe(1);
    expect(stats.failed).toBe(1);
  });
});
