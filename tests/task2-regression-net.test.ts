import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { matchRules } from "../src/main/analysis/ruleEngine";
import { issueDedupeKey } from "../src/main/analysis/deduplicate";
import { segmentsInWindow } from "../src/main/analysis/windowScheduler";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";
import type { Issue, TranscriptSegment } from "../src/shared/contracts";

/**
 * task-2 补测网（2026-10-16）：把「注入缺陷后仍然全绿」的四个洞钉住。
 *
 * 每条用例都做过变异验证：注入缺陷 → 该用例变红 → 还原 → git diff 确认无残留。
 * 变异注入位置与断言的关系写在每组注释里，方便后人复现。
 *
 * 口径：本文件全部离线，不发任何真实 ASR/LLM 请求（零额度铁律）。
 */

const stores: Array<{ store: Store; dir: string }> = [];
const sessions: SessionOrchestrator[] = [];

beforeEach(() => {
  for (const key of [
    "DSH_SECRET_LLM_API_KEY", "DSH_LLM_BASE_URL", "DSH_LLM_MODEL",
    "DSH_SECRET_TENCENT_ASR_SECRET_ID", "DSH_SECRET_TENCENT_ASR_SECRET_KEY",
    "DSH_TENCENT_ASR_APP_ID",
  ]) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  for (const orch of sessions.splice(0)) await orch.stop();
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task2-"));
  const store = new Store(path.join(dir, "test.db"));
  stores.push({ store, dir });
  return store;
}

function orchestrator(store: Store): SessionOrchestrator {
  const orch = new SessionOrchestrator(store);
  sessions.push(orch);
  return orch;
}

/** 每个数字夸大类别挑一条真实直播口语，断言它必须判 unverifiedClaim。 */
const UNVERIFIED_SAMPLES: Array<{ label: string; text: string }> = [
  { label: "原价", text: "这个平时卖399，今天原价299" },
  { label: "优惠/直降", text: "现在直降100块" },
  { label: "折扣", text: "今天全场3.5折" },
  { label: "百分比效果", text: "坚持用能提升80%的美白效果" },
  { label: "克重", text: "坚持喝能减重5斤" },
  { label: "使用天数", text: "坚持用7天就能看到变化" },
  { label: "续航/时长", text: "充满电可以保温25小时" },
  { label: "库存夸大", text: "只剩200单了" },
  { label: "比价夸大", text: "专柜平时都要580" },
  { label: "即时见效", text: "第3天就有效" },
  { label: "浓度百分比", text: "浓度5%的烟酰胺" },
];

describe("洞 1：默认 unverifiedClaim 规则族不能被整族丢弃", () => {
  /**
   * 变异：`ruleEngine.ts:156-158` 的
   *   for (const p of DEFAULT_UNVERIFIED_PATTERNS) { patterns.push({type:"unverifiedClaim",...}) }
   * 整段删掉 → 下面每条样本都返回 0 个 unverifiedClaim，11 条断言全红。
   *
   * 为什么这条要有网：数字夸大（原价/折扣/百分比/天数/克重）是直播合规里
   * 最高频也最容易出事的一类。整族被丢弃时用户拿到的是「0 问题」报告，
   * 而报告本身看起来完全正常——这是最危险的静默失效。
   */
  it("每个数字夸大类别都至少命中一条 unverifiedClaim", () => {
    for (const { label, text } of UNVERIFIED_SAMPLES) {
      const hits = matchRules(text, { framework: null, productFacts: "" });
      const unverified = hits.filter((h) => h.ruleType === "unverifiedClaim");
      expect(unverified.length, `${label} ← ${text}`).toBeGreaterThan(0);
    }
  });

  it("unverifiedClaim 与 absolutization 分家：数字类不算绝对化用语", () => {
    // 同一句里两类都要在，且各自归位——防止有人为了让数字命中而把类型改成
    // absolutization，或反过来把绝对化规则混进 unverifiedClaim 充数。
    const hits = matchRules("原价299，保证所有人满意", { framework: null, productFacts: "" });
    const kinds = new Set(hits.map((h) => h.ruleType));
    expect(kinds.has("unverifiedClaim")).toBe(true);
    expect(kinds.has("absolutization")).toBe(true);
    expect(hits.find((h) => h.ruleType === "absolutization")?.matchedText).toBe("保证");
  });

  it("默认规则在无框架配置时也生效（framework=null 是默认启动形态）", () => {
    // 回归 2026-10-16 早先的疑点：若规则族被挪进 `if (input.framework)` 分支，
    // 用户没配话术框架时数字夸大就一条都不报。这里显式钉住 null 也必须命中。
    expect(matchRules("今天5折", { framework: null, productFacts: "" })
      .some((h) => h.ruleType === "unverifiedClaim")).toBe(true);
  });
});

describe("洞 2：去重键必须用完整引文，不能只取前 2 字", () => {
  /**
   * 变异：`deduplicate.ts:18` 的 `quote` 改成 `quote.slice(0, 2)` → 下面全部变红。
   *
   * 现有 B2 用的是「保证所有人满意」vs「没有任何刺激」，前 2 字就不同，
   * 所以缺陷注入后 B2 照样绿——这正是它漏网的原因。这里专挑**前 2 字相同、
   * 后面才分叉**的引文对，B2 覆盖不到。
   */
  it("前 2 字相同的引文必须是两个键（截 2 字会把它们吞成一条）", () => {
    const base = { type: "unverifiedClaim" as const, segmentIds: ["seg-1"] };
    const pairs: Array<[string, string, string]> = [
      ["浓度5%", "浓度8%", "浓度百分比"],
      ["原价299", "原价599", "原价"],
      ["提升80%", "提升95%", "百分比效果"],
      ["坚持用7天", "坚持用30天", "天数"],
      ["保温25小时", "保温48小时", "时长"],
    ];
    for (const [a, b, label] of pairs) {
      expect(issueDedupeKey({ ...base, quote: a }), label)
        .not.toBe(issueDedupeKey({ ...base, quote: b }));
    }
  });

  it("只有前 2 字不同不能被误判成同一条（防反向过度区分）", () => {
    // 与上一条互为对照：引文**全部**不同时也不能因某种实现细节意外相等。
    const base = { type: "unverifiedClaim" as const, segmentIds: ["seg-1"] };
    expect(issueDedupeKey({ ...base, quote: "只剩200单" }))
      .not.toBe(issueDedupeKey({ ...base, quote: "只剩999单" }));
  });

  it("落库层同样不塌缩：同片段同类型的两条同前缀引文各自成条", () => {
    // 变异同款，但走真实 upsertIssue —— 保证不是只在纯函数层"看起来"区分开了。
    const store = tempStore();
    const mk = (id: string, quote: string): Issue => ({
      id,
      sessionId: "s1",
      analysisRunId: "run1",
      type: "unverifiedClaim",
      severity: "warning",
      startMs: 0,
      endMs: 1000,
      segmentIds: ["seg-1"],
      quote,
      basis: "命中规则 unverifiedClaim",
      recommendation: "改口播",
      suggestedScript: null,
      confidence: 0.95,
      needsReview: true,
      status: "open",
    });
    const a = mk("issue-a", "浓度5%");
    const b = mk("issue-b", "浓度8%");
    expect(store.upsertIssue(a, issueDedupeKey(a))).toBe("created");
    expect(store.upsertIssue(b, issueDedupeKey(b))).toBe("created");
    expect(store.listIssues("s1")).toHaveLength(2);
  });
});

describe("洞 3：分析窗口只取稳态片段（partial 不得进 LLM）", () => {
  /**
   * 变异：`windowScheduler.ts:72` 去掉 `&& s.isFinal` → 第一条变红
   * （isFinal:false 的重叠片段被纳入）。
   *
   * 为什么这条要有网：partial 是识别中间结果，会被后续修订甚至推翻。
   * 混进 LLM 后 F3 的逐段引文校验形同虚设——引文取自一段被推翻的临时文本，
   * 用户会拿到一条引用了错误原话的问题。
   */
  function seg(isFinal: boolean, id: string, startMs: number, endMs: number): TranscriptSegment {
    return {
      id,
      sessionId: "s1",
      connectionId: "c1",
      sourceSeq: 0,
      startMs,
      endMs,
      text: "临时字幕内容",
      isFinal,
      createdAt: new Date().toISOString(),
    };
  }

  it("isFinal=false 的片段即使完全落在窗口内也不得纳入", () => {
    const partial = seg(false, "p1", 1000, 5000);
    expect(segmentsInWindow([partial], 0, 60000)).toHaveLength(0);
  });

  it("稳态片段照常纳入（防止过度收紧把真片段也滤掉）", () => {
    const fin = seg(true, "f1", 1000, 5000);
    expect(segmentsInWindow([fin], 0, 60000)).toHaveLength(1);
  });

  it("混合输入只保留稳态那一条", () => {
    const mixed = [seg(false, "p1", 1000, 2000), seg(true, "f1", 2000, 9000), seg(false, "p2", 9000, 12000)];
    const out = segmentsInWindow(mixed, 0, 60000);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("f1");
  });

  it("partial 与跨边界条件同时成立时，仍以 isFinal 为准", () => {
    // 跨边界（endMs > startMs）本来就该纳入，是现有的「跨边界片段被纳入」用例；
    // 这条只补「跨边界 ∧ 非稳态」这一组合，确保修复不会把边界逻辑一起改坏。
    expect(segmentsInWindow([seg(false, "p1", 250000, 320000)], 300000, 600000)).toHaveLength(0);
    expect(segmentsInWindow([seg(true, "f1", 250000, 320000)], 300000, 600000)).toHaveLength(1);
  });
});

describe("洞 4：stop() 必须等 ASR 收尾，不等就是「会话已结束但还在重连」", () => {
  /**
   * 变异：`orchestrator.ts:429-434` 的 try{await flushAudio(); await asr.stop();}
   * 退化成 fire-and-forget（`void this.asr.stop()`）→ 下面两条变红：
   * stop() 先返回，DB 里会话已被标 stopped，而 ASR 还没断，
   * 于是适配器可能继续自动重连、继续烧腾讯云配额。
   *
   * 判定用「时序」而不是「有没有调用」：只断言 stop() 被调用过，
   * fire-and-forget 一样能满足；必须断言**在 asr.stop() resolve 之前
   * status 不得变成 stopped**。
   */
  it("ASR 收尾未完成前，会话状态不得落地为 stopped", async () => {
    const store = tempStore();
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "AKID-task2");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "task2-key");
    vi.spyOn(TencentAsrAdapter.prototype, "connect").mockImplementation(() => new Promise<void>(() => {}));

    let releaseAsr!: () => void;
    const asrStopping = new Promise<void>((r) => { releaseAsr = r; });
    const asrStop = vi.spyOn(TencentAsrAdapter.prototype, "stop").mockImplementation(async () => {
      await asrStopping;
    });

    const orch = orchestrator(store);
    const { sessionId } = await orch.start({ audioSource: "microphone" });

    let stoppedReturned = false;
    const stopPromise = orch.stop().then(() => { stoppedReturned = true; });

    // 让 flushAudio 那一步先过去，确认此刻 asr.stop 已被调用但仍未 resolve。
    await new Promise((r) => setTimeout(r, 20));
    expect(asrStop).toHaveBeenCalled();
    expect(stoppedReturned, "asr.stop() 未完成时 stop() 不得返回").toBe(false);
    expect(store.getSession(sessionId)?.status, "会话不得提前落 stopped").not.toBe("stopped");

    releaseAsr();
    await stopPromise;
    expect(stoppedReturned).toBe(true);
    expect(store.getSession(sessionId)?.status).toBe("stopped");
  });

  it("ASR 收尾抛错也不能跳过状态落地（best effort 不等于静默丢失）", async () => {
    // 变异同款但反向：即使 asr.stop() 抛异常，stop() 也必须把会话落成 stopped，
    // 否则用户界面永远停在「监听中」。这是现有 try/catch 的既有行为，钉住防回归。
    const store = tempStore();
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "AKID-task2");
    vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "task2-key");
    vi.spyOn(TencentAsrAdapter.prototype, "connect").mockImplementation(() => new Promise<void>(() => {}));
    vi.spyOn(TencentAsrAdapter.prototype, "stop").mockImplementation(async () => {
      throw new Error("unit: 模拟 ASR 收尾失败");
    });

    const orch = orchestrator(store);
    const { sessionId } = await orch.start({ audioSource: "microphone" });
    await orch.stop();
    expect(store.getSession(sessionId)?.status).toBe("stopped");
  });
});