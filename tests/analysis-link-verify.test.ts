import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { WindowScheduler, segmentsInWindow } from "../src/main/analysis/windowScheduler";
import { computeMetrics, detectSpeechIntervals } from "../src/main/analysis/metrics";
import { matchRules } from "../src/main/analysis/ruleEngine";
import { issueDedupeKey } from "../src/main/analysis/deduplicate";
import { verifyIssues, createAnalysisResultSchema, buildUserContent, LlmClient, type LlmAnalysisInput } from "../src/main/analysis/llmClient";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";
import { FrameworkEditSchema } from "../src/renderer/pages/frameworkSchema";
import type { TranscriptSegment, Issue, Framework } from "../src/shared/contracts";

let sequence = 0;
function seg(id: string, startMs: number, endMs: number, text: string): TranscriptSegment {
  return { id, sessionId: "s1", connectionId: "fixture-connection", sourceSeq: sequence++, startMs, endMs, text, isFinal: true, createdAt: new Date().toISOString() };
}
const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "demo/sample-framework.json"), "utf8"));
const framework: Framework = fixture.framework;
const segments = [seg("real-1", 1000, 5000, "这款保温杯是304不锈钢的"), seg("real-2", 5000, 9000, "保温效果可以达到十二小时")];
const input = (): LlmAnalysisInput => ({ windowStartMs: 0, windowEndMs: 60000, segments, rulesSummary: "", productFacts: framework.productFacts, previousSummary: "", metrics: computeMetrics(segments, [{ startMs: 1000, endMs: 9000 }], 0, 60000), framework });
const candidate = (patch: Record<string, unknown> = {}) => ({ type: "other" as const, severity: "info" as const, segmentIds: ["real-1"], quote: "304不锈钢", basis: "对应片段", recommendation: "补充材质来源", confidence: 0.9, needsReview: true, ...patch });
const response = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
function client(budget = 10, retries = 0, timeout = 20000) {
  const c = new LlmClient();
  c.configure({ base_url: "http://fixture.invalid/v1/", model: "fixture", api_key: "fixture-key", budget_limit: budget, max_retries: retries, request_timeout_ms: timeout });
  return c;
}
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const stores: Store[] = [];
const orchestrators: SessionOrchestrator[] = [];
beforeEach(() => {
  // Never inherit live provider credentials or make real ASR calls in a fixture test.
  for (const name of ["DSH_SECRET_LLM_API_KEY", "DSH_LLM_BASE_URL", "DSH_LLM_MODEL", "DSH_SECRET_TENCENT_ASR_SECRET_ID", "DSH_SECRET_TENCENT_ASR_SECRET_KEY"]) vi.stubEnv(name, "");
  vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
});
afterEach(async () => {
  for (const orch of orchestrators.splice(0)) await orch.stop();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
function makeStore() { const s = new Store(":memory:"); stores.push(s); return s; }
async function startOrch() {
  const store = makeStore(); store.saveFramework(framework);
  const orch = new SessionOrchestrator(store); orchestrators.push(orch);
  const events: Array<{ event: string; payload: unknown }> = [];
  orch.setWindow({ isDestroyed: () => false, webContents: { send: (event: string, payload: unknown) => events.push({ event, payload }) } } as never);
  const { sessionId } = await orch.start({ audioSource: "microphone" });
  return { store, orch, sessionId, events, run: (start: number, end: number) => (orch as unknown as { runAnalysis: (s: number, e: number) => Promise<void> }).runAnalysis(start, end) };
}

describe("A 窗口调度", () => {
  it("A1 正常异步tick：40分钟60秒节拍，冻结边界，5分钟窗口", async () => {
    const windows: Array<[number, number]> = [];
    const s = new WindowScheduler(60000, 300000, { getNow: () => 0, getWindow: async (a, b) => { windows.push([a, b]); } });
    s.start(0);
    for (let t = 1000; t <= 2400000; t += 1000) { s.tick(t); await drain(); }
    expect(windows).toHaveLength(40);
    expect(windows[0]).toEqual([0, 60000]);
    expect(windows[5]).toEqual([60000, 360000]);
    expect(windows[39]).toEqual([2100000, 2400000]);
    expect(s.skippedCount).toBe(0);
  });
  it("A2 延迟tick185秒仅产生过去的边界，积压合并最新", async () => {
    const windows: number[] = [];
    const s = new WindowScheduler(60000, 300000, { getNow: () => 0, getWindow: async (_, e) => { windows.push(e); } });
    s.start(0); s.tick(185000); await drain();
    expect(windows).toEqual([60000, 180000]);
    expect(s.skippedCount).toBe(1);
    expect(windows).not.toContain(240000);
  });
  it("A3 SQL与内存严格相交条件等价，保留跨边界完整文本", () => {
    const store = makeStore();
    const all = [seg("a", 0, 5000, "早于窗口"), seg("b", 250000, 320000, "跨左边界"), seg("c", 400000, 450000, "窗口内"), seg("d", 590000, 650000, "跨右边界"), seg("e", 700000, 750000, "晚于窗口"), seg("left-touch", 290000, 300000, "恰好左边界"), seg("right-touch", 600000, 610000, "恰好右边界")];
    for (const s of all) expect(store.insertSegment(s)).toBe(true);
    const expected = ["b", "c", "d"];
    expect(segmentsInWindow(all, 300000, 600000).map((s) => s.id)).toEqual(expected);
    expect(store.querySegments({ sessionId: "s1", finalOnly: true, startMs: 300000, endMs: 600000 }).map((s) => s.id)).toEqual(expected);
  });
  it.each([30000, 60000, 120000])("A4 interval=%i生效", async (interval) => {
    const ends: number[] = [];
    const s = new WindowScheduler(interval, 300000, { getNow: () => 0, getWindow: async (_, e) => { ends.push(e); } });
    s.start(0); s.tick(interval - 1); expect(ends).toEqual([]); s.tick(interval + 500); await drain(); expect(ends).toEqual([interval]);
  });
  it.each([180000, 300000, 600000])("A5 window=%i生效", async (window) => {
    const wins: number[][] = [];
    const s = new WindowScheduler(60000, window, { getNow: () => 0, getWindow: async (a, b) => { wins.push([a, b]); } });
    s.start(900000); s.tick(960000); await drain(); expect(wins).toEqual([[960000 - window, 960000]]);
  });
});

describe("B 真实调度/存储问题去重", () => {
  it("B1 orchestrator重放3个300秒重叠窗：各问题仅新增一次", async () => {
    vi.spyOn(LlmClient.prototype, "analyze").mockResolvedValue({ issues: [] });
    const { store, sessionId, events, run } = await startOrch();
    store.insertSegment({ ...seg("risk", 285000, 325000, "全网最低价，保证所有人满意"), sessionId });
    for (const end of [300000, 360000, 420000]) await run(Math.max(0, end - 300000), end);
    const rows = store.listIssues(sessionId);
    // Default absolutes have step=null; custom absolutes bind facts: three distinct keys.
    expect(rows).toHaveLength(3);
    for (const row of rows) { expect(row.occurrence_count).toBeGreaterThanOrEqual(3); expect(row.first_seen_ms).toBe(285000); expect(row.last_seen_ms).toBe(325000); }
    const shown = events.filter((e) => e.event === "analysis.issues").flatMap((e) => e.payload as Issue[]);
    expect(shown).toHaveLength(3);
  });
  it("B2 引文改写仍去重，不同步骤不互相吞掉", () => {
    const a = { type: "frameworkStep" as const, segmentIds: ["b", "a"] };
    expect(issueDedupeKey(a, "facts")).toBe(issueDedupeKey({ ...a, segmentIds: ["a", "b", "a"] }, "facts"));
    expect(issueDedupeKey(a, "facts")).not.toBe(issueDedupeKey(a, "offer"));
  });
});

describe("C 双语双分母和PCM VAD", () => {
  it("C1 40汉字+6英文词 / 2分钟讲话与3分钟总时长", () => {
    const text = "你好世界".repeat(5) + " hello world foo";
    const m = computeMetrics([seg("a", 0, 60000, text), seg("b", 60000, 120000, text)], [{ startMs: 0, endMs: 120000 }], 0, 180000);
    expect(m.chineseChars).toBe(40); expect(m.englishWords).toBe(6);
    expect(m.speechMs).toBe(120000); expect(m.totalMs).toBe(180000);
    expect(m.charsPerSpeechMinute).toBe(23); expect(m.charsPerTotalMinute).toBeCloseTo(46 / 3);
  });
  it("C2 区间裁剪、乱序重叠去重，最长静音不会NaN", () => {
    const m = computeMetrics([], [{ startMs: 30000, endMs: 70000 }, { startMs: -1000, endMs: 40000 }], 0, 60000);
    expect(m.speechMs).toBe(60000); expect(m.silenceMs).toBe(0); expect(m.longestSilenceMs).toBe(0);
  });
  it("C3 真实PCM数据流入orchestrator，讲话分母来自VAD而非ASR跨度", async () => {
    vi.spyOn(LlmClient.prototype, "analyze").mockResolvedValue({ issues: [] });
    const { orch, store, sessionId } = await startOrch();
    const audio = new Float32Array(6400); audio.fill(0.3, 0, 3200); // 200ms speech + 200ms silence at16k
    orch.ingestAudio(audio, 16000);
    const ivs = store.querySpeechIntervals(sessionId, 0, 60000);
    expect(ivs).toHaveLength(1); expect(ivs[0].startMs).toBe(0); expect(ivs[0].endMs).toBe(200);
    expect(computeMetrics([], ivs, 0, 1000).speechMs).toBe(200);
  });
  it("C4 VAD无讲话时speechMs=0而silenceMs=总时长", () => {
    const pcm = new Int16Array(3200);
    expect(detectSpeechIntervals([{ startMs: 0, durationMs: 200, pcm: pcm.buffer }])).toEqual([]);
    const m = computeMetrics([], [], 0, 60000); expect(m.speechMs).toBe(0); expect(m.longestSilenceMs).toBe(60000);
  });
});

describe("D 规则覆盖", () => {
  it.each(["保证", "绝对", "百分之百", "所有人", "七天见效"])("D1 绝对化：%s", (word) => {
    expect(matchRules(word, { framework: null, productFacts: "" }).some((h) => h.ruleType === "absolutization" && h.matchedText === word)).toBe(true);
  });
  it.each(["原价399.9", "优惠30", "只卖99", "3.5折", "改善80%", "减重5斤", "保温24小时"])("D2 数字风险：%s", (word) => {
    expect(matchRules(word, { framework: null, productFacts: "" }).some((h) => h.ruleType === "unverifiedClaim" && h.matchedText === word)).toBe(true);
  });
  it("D3 自定义禁词启停、步骤身份和非法/零长正则", () => {
    expect(matchRules("全网最低", { framework, productFacts: "" }).some((h) => h.ruleType === "bannedWord")).toBe(true);
    const disabled = { ...framework, rules: framework.rules.map((r) => ({ ...r, enabled: false })) };
    expect(matchRules("全网最低", { framework: disabled, productFacts: "" }).filter((h) => h.ruleType === "bannedWord")).toEqual([]);
    expect(matchRules("全网最低", { framework: { ...framework, rules: [{ ...framework.rules[0], pattern: "([" }] }, productFacts: "" }).some((h) => h.ruleType === "bannedWord")).toBe(false);
    expect(matchRules("文本", { framework: { ...framework, rules: [{ ...framework.rules[0], pattern: "^" }] }, productFacts: "" }).every((h) => !!h.matchedText)).toBe(true);
  });
});

describe("E/F 结构和幻觉防护", () => {
  it.each([
    { segmentIds: ["nonexistent"] },
    { segmentIds: ["real-2"], quote: "二十四小时" },
    { segmentIds: ["real-1", "real-2"], quote: "304不锈钢的保温效果可以达到十二小时" },
    { quote: "" }, { quote: "   " },
  ])("F1–F3 虚构ID/改数字/拼接/空引文被拒 %#", (patch) => {
    expect(verifyIssues({ issues: [candidate(patch)] }, segments).issues).toEqual([]);
    expect(createAnalysisResultSchema(input()).safeParse({ issues: [candidate(patch)] }).success).toBe(false);
  });
  it("F4 合法多ID引用且quote完整属于一段，保留", () => {
    const result = { issues: [candidate({ segmentIds: ["real-1", "real-2"] })] };
    expect(verifyIssues(result, segments).issues).toHaveLength(1);
    expect(createAnalysisResultSchema(input()).safeParse(result).success).toBe(true);
  });
  it.each([{ severity: "high" }, { type: "fake" }, { startMs: 10000, endMs: 9000 }, { startMs: 0, endMs: 999999 }, { stepId: "fake-step" }])("E1 非法枚举/时间/步骤被拒 %#", (patch) => {
    expect(createAnalysisResultSchema(input()).safeParse({ issues: [candidate(patch)] }).success).toBe(false);
  });
  it("E2 发实际框架步骤、双分母、数组片段、启用规则", () => {
    const payload = JSON.parse(buildUserContent(input()));
    expect(Array.isArray(payload.segments)).toBe(true); expect(payload.segments).toHaveLength(2);
    expect(payload.framework.steps).toEqual(framework.steps);
    expect(payload.objectiveMetrics.englishWords).toBeDefined(); expect(payload.objectiveMetrics.charsPerTotalMinute).toBeDefined();
  });
  it("E3 坏JSON修一次成功", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response("not JSON")).mockResolvedValueOnce(response(JSON.stringify({ issues: [candidate()] })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await client().analyze(input())).issues).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("E4 修复仍失败不因max_retries再次修，空问题无法逃过校验", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(JSON.stringify({ issues: [candidate({ quote: "虚构引文" })] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client(10, 3).analyze(input())).rejects.toMatchObject({ code: "LLM_BAD_JSON" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("F5 坏响应经过真实orchestrator后不落问题库、不发UI提醒，运行记录失败", async () => {
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "fixture-key"); vi.stubEnv("DSH_LLM_BASE_URL", "http://fixture.invalid/v1"); vi.stubEnv("DSH_LLM_MODEL", "fixture");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(JSON.stringify({ issues: [candidate({ quote: "虚构广告词" })] }))));
    const { store, sessionId, events, run } = await startOrch();
    for (const s of segments) store.insertSegment({ ...s, sessionId });
    await run(0, 60000);
    expect(store.listIssues(sessionId)).toEqual([]);
    expect(events.some((e) => e.event === "analysis.issues")).toBe(false);
    expect(store.analysisRunStats(sessionId)).toEqual({ total: 1, success: 0, failed: 1 });
    const row = store.db.prepare("SELECT error_message FROM analysis_runs WHERE session_id=?").get(sessionId) as { error_message: string };
    expect(row.error_message).toContain("LLM_BAD_JSON");
  });
});

describe("G 20秒超时与有界合并", () => {
  it("G1 原请求+重试+修复共用20秒预算；fetch忽略abort也不挂住", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetchMock);
    const promise = client(10, 3, 30000).analyze(input());
    const checked = expect(promise).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20000); await checked;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("G2 单运行+单待处理；失败后启动最新等待窗口，跳过次数准确", async () => {
    const windows: number[] = []; let rejectFirst!: (e: unknown) => void; let concurrency = 0; let maxConcurrency = 0;
    const s = new WindowScheduler(60000, 300000, { getNow: () => 0, getWindow: async (_, e) => {
      concurrency++; maxConcurrency = Math.max(maxConcurrency, concurrency); windows.push(e);
      try { if (windows.length === 1) await new Promise((_, reject) => { rejectFirst = reject; }); } finally { concurrency--; }
    } });
    s.start(0); s.tick(60000); s.tick(120000); expect(s.skippedCount).toBe(0); s.tick(180000); expect(s.skippedCount).toBe(1);
    rejectFirst(new Error("timeout fixture")); await drain();
    expect(windows).toEqual([60000, 180000]); expect(maxConcurrency).toBe(1);
  });
  it("G3 超时释放调度锁，下一轮真正LLM请求正常返回", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(response('{"issues":[]}')); vi.stubGlobal("fetch", fetchMock);
    const c = client(); const finished: number[] = []; const errors: unknown[] = [];
    const scheduler = new WindowScheduler(60000, 300000, { getNow: () => 0, getWindow: async (_, end) => { await c.analyze(input()); finished.push(end); }, onError: (e) => errors.push(e) });
    scheduler.start(0); scheduler.tick(60000); scheduler.tick(120000);
    await vi.advanceTimersByTimeAsync(20000); await drain();
    expect(errors).toHaveLength(1); expect(finished).toEqual([120000]); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("G 超时状态持久化", () => {
  it("G4 orchestrator记录timeout及错误码，不统一写failed", async () => {
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "fixture-key"); vi.stubEnv("DSH_LLM_BASE_URL", "http://127.0.0.1:3425/v1"); vi.stubEnv("DSH_LLM_MODEL", "group/auto-step-5-preview");
    vi.spyOn(LlmClient.prototype, "analyze").mockRejectedValue({ code: "LLM_TIMEOUT", message: "fixture timeout", retryable: true });    const { store, sessionId, events, run } = await startOrch();
    for (const s of segments) store.insertSegment({ ...s, sessionId });
    await run(0, 60000);
    const row = store.db.prepare("SELECT status,error_message FROM analysis_runs WHERE session_id=?").get(sessionId) as { status: string; error_message: string };
    expect(row.status).toBe("timeout"); expect(row.error_message).toContain("LLM_TIMEOUT");
    expect(events.filter((e) => e.event === "analysis.status").at(-1)?.payload).toMatchObject({ running: false, lastRunStatus: "timeout" });
  });
});

describe("H 单场请求预算", () => {
  it("H1 预算1：首次发送预留，修复请求不得越界", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("bad JSON")); vi.stubGlobal("fetch", fetchMock); const c = client(1);
    await expect(c.analyze(input())).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(c.budgetUsed).toBe(1);
  });
  it("H2 失败请求和重试均计数，预算0不发送", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fixture failure")); vi.stubGlobal("fetch", fetchMock);
    const c = client(2, 5); await expect(c.analyze(input())).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" }); expect(c.budgetUsed).toBe(2); expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(client(0).analyze(input())).rejects.toMatchObject({ code: "LLM_BUDGET_EXCEEDED" }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("H3 结束再启动会话使用新LLM实例，预算不跨场累积", async () => {
    const { orch } = await startOrch();
    const first = (orch as unknown as { llm: LlmClient }).llm;
    await orch.stop(); await orch.start({ audioSource: "microphone" });
    const next = (orch as unknown as { llm: LlmClient }).llm;
    expect(next).not.toBe(first); expect(next.budgetUsed).toBe(0);
  });
});

describe("问题1：LLM 未配置是配置态不是运行故障", () => {
  it("I1 未配置时多个窗口不重复弹同一错误，规则问题照常落库展示", async () => {
    for (const name of ["DSH_SECRET_LLM_API_KEY", "DSH_LLM_BASE_URL", "DSH_LLM_MODEL"]) vi.stubEnv(name, "");
    vi.spyOn(LlmClient.prototype, "analyze").mockRejectedValue(new Error("must not be called"));
    const { store, sessionId, events, run } = await startOrch();
    store.insertSegment({ ...seg("risk-i1", 0, 5000, "全网最低价，保证所有人满意"), sessionId });
    await run(0, 300000); await run(300000, 600000); await run(600000, 900000);
    // 配置态不产生 LLM 相关 app.error（ASR 未配置提示是另一条，本就该出现一次）
    expect(events.filter((e) => e.event === "app.error" && String((e.payload as { code?: string }).code ?? "").includes("LLM"))).toEqual([]);
    const statuses = events.filter((e) => e.event === "analysis.status").map((e) => e.payload as { llm?: string });
    expect(statuses.every((s) => s.llm === "not_configured")).toBe(true);
    // 本地规则问题照常落库并展示，LLM 没配不代表分析线全废
    expect(store.listIssues(sessionId).length).toBeGreaterThan(0);
    expect(events.filter((e) => e.event === "analysis.issues").length).toBeGreaterThan(0);
    expect(store.analysisRunStats(sessionId)).toEqual({ total: 3, success: 3, failed: 0 });
  });

  it("I2 同一错误码会话内只提示一次，不同错误码可各提示一次", async () => {
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "fixture-key"); vi.stubEnv("DSH_LLM_BASE_URL", "http://127.0.0.1:3425/v1"); vi.stubEnv("DSH_LLM_MODEL", "group/auto-step-5-preview");
    const { store, sessionId, events, run } = await startOrch();
    store.insertSegment({ ...seg("risk-i2", 0, 5000, "模拟片段"), sessionId });
    vi.spyOn(LlmClient.prototype, "analyze").mockRejectedValueOnce({ code: "LLM_BAD_JSON", message: "第一次", retryable: false }).mockRejectedValueOnce({ code: "LLM_BAD_JSON", message: "第二次同样错误码", retryable: false });
    await run(0, 300000); await run(300000, 600000);
    const errors = events.filter((e) => e.event === "app.error").map((e) => (e.payload as { code: string }).code).filter((c) => c.includes("LLM") || c === "ANALYSIS_LLM_FAILED");
    expect(errors).toEqual(["LLM_BAD_JSON"]);
    const last = events.filter((e) => e.event === "analysis.status").at(-1)?.payload as { lastErrorCode?: string };
    expect(last.lastErrorCode).toBe("LLM_BAD_JSON");
  });
});

describe("问题2：中文数字与阿拉伯数字归一化匹配（不破坏F3）", () => {
  const fw: Framework = {
    id: "fw-num", name: "数字归一", updatedAt: "", productFacts: "",
    steps: [],
    rules: [{ id: "hot-yeast", frameworkId: "fw-num", stepId: null, ruleType: "hotWord", pattern: "二裂酵母", enabled: true }],
  };
  it("N1 热词写中文数字，能匹配转写里的阿拉伯数字（convert_num_mode=1 场景）", () => {
    const hits = matchRules("这款精华里面有2裂酵母成分", { framework: fw, productFacts: "" });
    expect(hits.some((h) => h.ruleId === "hot-yeast")).toBe(true);
  });
  it("N2 规则写阿拉伯数字，也能匹配中文数字原文", () => {
    const cn = { ...fw, rules: [{ ...fw.rules[0], pattern: "12小时" }] };
    const hits = matchRules("保温可以达到十二小时", { framework: cn, productFacts: "" });
    expect(hits.some((h) => h.ruleId === "hot-yeast")).toBe(true);
  });
  it("N3 quote 逐字来自原文，绝不返回归一化文本", () => {
    const hits = matchRules("这款精华里面有2裂酵母成分", { framework: fw, productFacts: "" });
    for (const h of hits) expect("这款精华里面有2裂酵母成分").toContain(h.matchedText);
    const hitsCn = matchRules("这款精华里面有二裂酵母成分", { framework: fw, productFacts: "" });
    for (const h of hitsCn) expect("这款精华里面有二裂酵母成分").toContain(h.matchedText);
  });
  it("N4 同一规则同一位置只报一次，不双弹窗", () => {
    const hits = matchRules("这款精华里面有2裂酵母成分", { framework: fw, productFacts: "" });
    expect(hits.filter((h) => h.ruleId === "hot-yeast")).toHaveLength(1);
  });
  it("N5 归一化不产生假命中：无关数字不被误判", () => {
    const hits = matchRules("这款保温杯500毫升", { framework: fw, productFacts: "" });
    expect(hits.filter((h) => h.ruleId === "hot-yeast")).toEqual([]);
  });
  it("N6 归一化后的引文仍能通过F3证据校验（真实orchestrator落库）", async () => {
    const text = "这款精华里面有2裂酵母成分";
    const { store, sessionId, events, run } = await startOrch();
    store.saveFramework({ ...fw, rules: [{ ...fw.rules[0], ruleType: "bannedWord" }] });
    store.insertSegment({ ...seg("risk-n6", 0, 5000, text), sessionId });
    await run(0, 300000);
    const issues = store.listIssues(sessionId) as Array<{ quote: string; segment_ids: string }>;
    expect(issues.length).toBe(1);
    expect(text).toContain(issues[0].quote);
    const shown = events.filter((e) => e.event === "analysis.issues").flatMap((e) => e.payload as Issue[]);
    expect(shown).toHaveLength(1);
    expect(text).toContain(shown[0].quote);
  });
});

describe("话术示例导入", () => {
  it("真实前端schema可导入，步骤/规则关联一致且正则可编译", () => {
    const parsed = FrameworkEditSchema.safeParse(fixture.framework ?? fixture); expect(parsed.success).toBe(true);
    expect(fixture.simulated).toBe(true);
    if (!parsed.success) return;
    const ids = new Set(parsed.data.steps.map((s) => s.id));
    expect(parsed.data.steps).toHaveLength(8);
    for (const r of parsed.data.rules) { expect(r.frameworkId).toBe(parsed.data.id); expect(r.stepId === null || ids.has(r.stepId)).toBe(true); expect(() => new RegExp(r.pattern)).not.toThrow(); }
    for (const s of parsed.data.steps) expect(s.frameworkId).toBe(parsed.data.id);
  });
});
