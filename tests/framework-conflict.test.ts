import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";

/**
 * 框架「一致性比对」端到端测试（走真实 SessionOrchestrator 窗口分析路径）。
 *
 * 单元测试（tests/fact-check.test.ts）只证明**比对函数**正确，
 * 不能证明它被接进了分析管线、能落库、能被报告读出来。
 * 本文件补的是这一段：转写 → 窗口分析 → 问题落库。
 *
 * 领导原话「和给定的话术框架进行比对，找出问题」的直接验收点。
 */

const resources: Array<{ store: Store; dir: string; orch: SessionOrchestrator }> = [];
afterEach(async () => {
  for (const { orch, store, dir } of resources.splice(0)) {
    await orch.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup(productFacts: string, segments: Array<{ id: string; text: string; startMs: number; endMs: number }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "framework-conflict-"));
  const store = new Store(path.join(dir, "t.db"));
  store.saveFramework({
    id: "fw-fact",
    name: "事实核对框架",
    productFacts,
    updatedAt: new Date().toISOString(),
    steps: [],
    rules: [],
  });
  const sessionId = store.createSession({
    id: "sess-fact",
    startedAtIso: new Date().toISOString(),
    audioSource: "systemLoopback",
    deviceId: null,
  }) as unknown as string;
  for (const s of segments) {
    store.insertSegment({ ...s, sessionId: "sess-fact", connectionId: "conn-1", sourceSeq: 0, isFinal: true, createdAt: new Date().toISOString() });
    store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: "sess-fact", startMs: s.startMs, endMs: s.endMs });
  }
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
  vi.stubEnv("DSH_SECRET_LLM_API_KEY", "");
  vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(TencentAsrAdapter.prototype, "stop").mockResolvedValue();
  vi.spyOn(TencentAsrAdapter.prototype, "sendPcm").mockResolvedValue();
  const orch = new SessionOrchestrator(store);
  const events: Array<{ event: string; payload: unknown }> = [];
  orch.setWindow({ isDestroyed: () => false, webContents: { send: (e: string, p: unknown) => events.push({ event: e, payload: p }) } } as never);
  // `runAnalysis` 的两道前置条件，测试必须显式满足（否则静默 return，产生假阴性）：
  //  1) `this.sessionId` 非空 —— 第一行就 `if (!this.sessionId) return`
  //  2) `this.framework` 非空 —— 由 start() → resolveFramework 设置，直接调 runAnalysis 会绕过
  (orch as unknown as { sessionId: string | null }).sessionId = "sess-fact";
  (orch as unknown as { status: string }).status = "active";
  (orch as unknown as { framework: unknown }).framework = store.listFrameworks()[0] ?? null;
  return { store, dir, orch, sessionId, events };
}

/** 直接调私有 runAnalysis，绕开 30/60/120 秒调度器等待。 */
async function runWindow(orch: SessionOrchestrator, startMs: number, endMs: number) {
  await (orch as unknown as { runAnalysis(a: number, b: number): Promise<void> }).runAnalysis(startMs, endMs);
}

describe("框架事实冲突：从转写到问题落库（端到端）", () => {
  it("E1 框架写「保温12小时」，主播说「保温24小时」→ 产出 frameworkConflict 问题", async () => {
    const { store, orch, events } = setup("实验室恒温测试12小时", [
      { id: "seg-1", text: "咱们这个杯子可以保温24小时，非常耐用", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir: "", orch } as never);
    await runWindow(orch, 0, 60000);

    const issues = store.listIssues("sess-fact");
    const conflicts = issues.filter((i) => i.type === "frameworkConflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe("warning");
    expect(conflicts[0].quote).toBe("24小时");
    expect(conflicts[0].basis).toContain("12小时");
    expect(conflicts[0].basis).toContain("24小时");
    // ⚠️ listIssues 返回的是数据库原始行（SELECT *），字段为 snake_case。
    // 这里刻意用真实字段名断言——用 camelCase 会得到 undefined 而「假通过」。
    expect(conflicts[0].needs_review).toBe(1);
    // 证据必须可溯源到片段
    expect(JSON.parse(conflicts[0].segment_ids as string)).toEqual(["seg-1"]);
    // 必须通过 issues 事件推给 UI（否则前端看不到）
    const pushed = events.filter((e) => e.event === "analysis.issues");
    expect(pushed.length).toBeGreaterThan(0);
  });

  it("E1b 已知重叠：框架已声明该参数时，既有 unverifiedClaim 规则仍会重复报一条", async () => {
    // ⚠️ 这是一个**已确认的产品问题，本测试用来钉住现状**，不是认可该行为。
    // 框架声明「实验室恒温测试12小时」，主播说「保温24小时」：
    //   - 本通道报 frameworkConflict（「与框架声明不符」）—— 准确
    //   - 既有规则 `(?:保温|保冷)...\d+小时` 报 unverifiedClaim（「未核实宣称」）—— 口径错误，
    //     因为框架**确实声明了**该参数，只是数值不同。
    // 用户会看到两条针对同一事实的警告，其中一条定性错误。
    // 待决策：是否让规则引擎在「该参数已被框架声明」时让位给本通道。
    const { store, orch, dir } = setup("实验室恒温测试12小时", [
      { id: "seg-1", text: "咱们这个杯子可以保温24小时", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    const types = store.listIssues("sess-fact").map((i) => i.type).sort();
    expect(types).toEqual(["frameworkConflict", "unverifiedClaim"]);
  });

  it("E2 数值一致 → 框架比对通道不报（既有规则可能另有命中，只断言本通道）", async () => {
    const { store, orch, dir } = setup("实验室恒温测试12小时", [
      { id: "seg-1", text: "咱们这个杯子可以保温12小时", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    expect(store.listIssues("sess-fact").filter((i) => i.type === "frameworkConflict")).toHaveLength(0);
  });

  it("E3 服务条款「7天无理由退换货」不报（这是误报的典型来源）", async () => {
    const { store, orch, dir } = setup("坚持使用14天", [
      { id: "seg-1", text: "我们现在做的是7天无理由退换货，而且赠送运费险", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    expect(store.listIssues("sess-fact").filter((i) => i.type === "frameworkConflict")).toHaveLength(0);
  });

  it("E4 框架没有可核对事实时，本通道不产出任何问题", async () => {
    const { store, orch, dir } = setup("304不锈钢内胆", [
      { id: "seg-1", text: "咱们这个杯子可以保温24小时", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    expect(store.listIssues("sess-fact").filter((i) => i.type === "frameworkConflict")).toHaveLength(0);
  });

  it("E5 同一冲突跨窗口重复出现 → 去重合并，不重复新增", async () => {
    const { store, orch, dir } = setup("实验室恒温测试12小时", [
      { id: "seg-1", text: "可以保温24小时", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    await runWindow(orch, 0, 60000);
    const conflicts = store.listIssues("sess-fact").filter((i) => i.type === "frameworkConflict");
    expect(conflicts).toHaveLength(1);
    // occurrence_count 同样是数据库字段名；两次窗口分析后应累加
    expect(conflicts[0].occurrence_count as number).toBeGreaterThanOrEqual(2);
  });

  it("E6 事实冲突与规则命中可共存（性质不同，各自产出）", async () => {
    const { store, orch, dir } = setup("实验室恒温测试12小时", [
      { id: "seg-1", text: "所有肤质都可以放心用，而且能保温24小时", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    const types = store.listIssues("sess-fact").map((i) => i.type);
    expect(types).toContain("frameworkConflict");
    expect(types).toContain("absolutization"); // 「所有肤质」触发既有规则
  });

  it("E7 法定违规表述（statutory）落库为 critical + needs_review", async () => {
    // 「假一赔十」是完整固定短语，误报风险为零（见 tests/ruleEngine-confidence.test.ts），
    // 故与禁用词同级定级 critical；但仍不认定违法，保留人工复核。
    const { store, orch, dir } = setup("", [
      { id: "seg-1", text: "今天这场是品牌专场，支持专柜验货，假一赔十。", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    const issues = store.listIssues("sess-fact");
    const hit = issues.find((i) => i.quote === "假一赔十");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("critical");
    expect(hit!.needs_review).toBe(1);
  });

  it("E8 宽泛模式（broad）仍为 warning + 不强制复核（避免淹没真正该改的）", async () => {
    const { store, orch, dir } = setup("", [
      { id: "seg-1", text: "这款产品保证有效", startMs: 0, endMs: 5000 },
    ]);
    resources.push({ store, dir, orch });
    await runWindow(orch, 0, 60000);
    const hit = store.listIssues("sess-fact").find((i) => i.quote === "保证");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
    expect(hit!.needs_review).toBe(0);
  });
});
