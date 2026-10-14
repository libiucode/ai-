import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseTencentMessage } from "../src/main/asr/tencentAdapter";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { verifyIssues, extractJson, CORE_PROMPT } from "../src/main/analysis/llmClient";
import { LlmAnalysisResultSchema } from "../src/shared/schemas";
import { matchRules, ScriptLoopState } from "../src/main/analysis/ruleEngine";
import type { TranscriptSegment } from "../src/shared/contracts";
import type { AsrFinalPayload } from "../src/main/asr/types";

const fx = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8"));

const seg = (id: string, text: string): TranscriptSegment => ({
  id,
  sessionId: "s",
  connectionId: "c",
  sourceSeq: 0,
  startMs: 0,
  endMs: 5000,
  text,
  isFinal: true,
  createdAt: new Date().toISOString(),
});

describe("fixture: asr-partial-final（模拟数据）", () => {
  it("临时字幕不显示为最终字幕：slice_type 0/1 → partial，2 → final", () => {
    const fixture = fx("asr-partial-final.json");
    let partialCount = 0;
    let finalCount = 0;
    let finalText = "";
    for (const m of fixture.messages) {
      const parsed = parseTencentMessage(m.raw);
      if (parsed.type === "final") {
        finalCount++;
        finalText = parsed.text ?? "";
      } else if (parsed.type === "partial") {
        partialCount++;
      }
    }
    expect(partialCount).toBe(fixture.expect.partialCount);
    expect(finalCount).toBe(fixture.expect.finalCount);
    expect(finalText).toBe(fixture.expect.finalText);
  });
});

describe("fixture: asr-reconnect（模拟数据）", () => {
  it("重连后新连接 index 从 0 计数，不与旧连接去重冲突", () => {
    const fixture = fx("asr-reconnect.json");
    const adapter = new TencentAsrAdapter();
    const finals: AsrFinalPayload[] = [];
    adapter.on("final", (p) => finals.push(p as AsrFinalPayload));

    // Simulate the per-connection state reset in openNewConnection.
    // Feed connA final index=0.
    (adapter as unknown as { connectionId: string }).connectionId = fixture.connectionA.connectionId;
    Object.assign(adapter, { lastSeqSeen: -1, lastFinalSeq: -1, lastPartialKey: null });
    for (const m of fixture.connectionA.messages) {
      (adapter as unknown as { handleMessage: (r: string) => void }).handleMessage(m.raw);
    }
    // simulate reconnect: new connection id, seq counter reset
    (adapter as unknown as { connectionId: string }).connectionId = fixture.connectionB.connectionId;
    Object.assign(adapter, { lastSeqSeen: -1, lastFinalSeq: -1, lastPartialKey: null });
    for (const m of fixture.connectionB.messages) {
      (adapter as unknown as { handleMessage: (r: string) => void }).handleMessage(m.raw);
    }
    expect(finals.length).toBe(fixture.expect.segmentsA + fixture.expect.segmentsB);
    expect(finals[0].connectionId).toBe("conn-A");
    expect(finals[1].connectionId).toBe("conn-B");
    // seq can repeat across connections
    expect(finals[0].sourceSeq).toBe(0);
    expect(finals[1].sourceSeq).toBe(0);
  });

  it("错误消息(code!=0) 不产生转写，产生 error", () => {
    const fixture = fx("asr-reconnect.json");
    const errMsg = fixture.connectionA.messages[1].raw;
    const parsed = parseTencentMessage(errMsg);
    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe(1006);
  });
});

describe("fixture: llm-valid（模拟数据）", () => {
  it("通过 Zod 校验且 quote 是原文子串", () => {
    const fixture = fx("llm-valid.json");
    const json = extractJson(fixture.responseText);
    const parsed = LlmAnalysisResultSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    const segments = fixture.inputSegments.map((s: { segmentId: string; text: string }) =>
      seg(s.segmentId, s.text),
    );
    const verified = verifyIssues(parsed.data!, segments);
    expect(verified.issues.length).toBe(fixture.expect.issueCount);
    expect(verified.issues[0].type).toBe(fixture.expect.issueType);
  });
});

describe("fixture: llm-invalid-json（模拟数据）", () => {
  it("第一轮校验失败、修复轮成功", () => {
    const fixture = fx("llm-invalid-json.json");
    const firstJson = extractJson(fixture.firstResponseText);
    const first = LlmAnalysisResultSchema.safeParse(firstJson);
    expect(first.success).toBe(false); // type 不在枚举、confidence 越界、空 quote/basis
    const repaired = LlmAnalysisResultSchema.safeParse(extractJson(fixture.repairResponseText));
    expect(repaired.success).toBe(true);
    expect(repaired.data!.issues.length).toBe(fixture.expect.finalIssueCount);
  });

  it("完全不是 JSON 的输出抛错（断线坏 JSON 场景）", () => {
    expect(() => extractJson("对不起，我无法完成这个任务")).toThrow();
  });
});

describe("fixture: llm-fake-evidence（模拟数据）", () => {
  it("不存在的 segmentId 与伪造 quote 全部被 verifyIssues 拒绝", () => {
    const fixture = fx("llm-fake-evidence.json");
    const json = extractJson(fixture.responseText);
    const parsed = LlmAnalysisResultSchema.safeParse(json);
    expect(parsed.success).toBe(true); // schema 形状对，但证据是假的
    const segments = fixture.inputSegments.map((s: { segmentId: string; text: string }) =>
      seg(s.segmentId, s.text),
    );
    const verified = verifyIssues(parsed.data!, segments);
    expect(verified.issues.length).toBe(fixture.expect.validIssueCount);
    expect(parsed.data!.issues.length).toBe(fixture.expect.droppedCount);
  });
});

describe("fixture: framework-sample（模拟数据）", () => {
  it("自定义禁用词命中、热词只提示不判违法", () => {
    const fixture = fx("framework-sample.json");
    const fw = fixture.framework;
    const hits = matchRules("这是全网最好的保温杯，304不锈钢", { framework: fw, productFacts: fw.productFacts });
    const banned = hits.filter((h) => h.ruleType === "bannedWord");
    const hot = hits.filter((h) => h.ruleType === "hotWord");
    expect(banned.length).toBeGreaterThanOrEqual(1); // "最好"
    expect(hot.length).toBeGreaterThanOrEqual(1); // "304不锈钢"
  });

  it("已核实事实中的说法不触发规则（除非出现在禁用词表）", () => {
    const fixture = fx("framework-sample.json");
    const fw = fixture.framework;
    // "实验室恒温测试12小时" 是已核实事实，不在任何禁用词/未核实模式中
    const hits = matchRules("我们做过实验室恒温测试12小时", { framework: fw, productFacts: fw.productFacts });
    expect(hits.length).toBe(0);
  });
});

describe("话术循环状态机", () => {
  it("只在触发词出现时推进，不随时间推进", () => {
    const st = new ScriptLoopState();
    expect(st.feed("随便聊聊今天的天气", 1000)).toBeNull();
    expect(st.feed("欢迎新来的朋友", 2000)).toBe("opening");
    expect(st.feed("继续聊天", 3000)).toBeNull();
    expect(st.feed("来看一下这款产品", 4000)).toBe("productIntro");
  });
});

describe("Prompt 防伪造约束", () => {
  it("核心 Prompt 明确要求引用原文子串", () => {
    expect(CORE_PROMPT).toMatch(/quote.*(?:某一个|单个).*片段.*连续子串/);
    expect(CORE_PROMPT).toContain("禁止改数字、拼接多段、引用摘要");
    expect(CORE_PROMPT).toContain("segmentIds必须存在于输入");
  });
});
