import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { BrowserWindow } from "electron";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  ScriptLoopState,
  computeStepCoverage,
  replayScriptPhases,
  type ReplayedPhase,
} from "../src/main/analysis/ruleEngine";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { Store } from "../src/main/storage/store";
import { buildReportSummary, buildHtmlReport } from "../src/main/report/reportBuilder";
import type { Framework, TranscriptSegment } from "../src/shared/contracts";

const framework: Framework = {
  id: "f1",
  name: "测试框架",
  productFacts: "",
  updatedAt: new Date().toISOString(),
  steps: [
    { id: "st1", frameworkId: "f1", name: "开场白", priority: 2, maxWaitMs: 120000 },
    { id: "st2", frameworkId: "f1", name: "福利预告", priority: 1, maxWaitMs: 60000 },
    { id: "st3", frameworkId: "f1", name: "收尾感谢", priority: 0, maxWaitMs: 300000 },
    { id: "st4", frameworkId: "f1", name: "不限时环节", priority: 1, maxWaitMs: 0 },
  ],
  rules: [],
};

let seqCounter = 0;
const seg = (id: string, text: string, startMs: number, endMs: number): TranscriptSegment => ({
  id,
  sessionId: "s1",
  connectionId: "c1",
  // transcript_segments 有 UNIQUE(connection_id, source_seq, is_final)，逐条递增避免去重
  sourceSeq: ++seqCounter,
  startMs,
  endMs,
  text,
  isFinal: true,
  createdAt: new Date().toISOString(),
});

describe("阶段重放（报告侧还原话术步骤覆盖）", () => {
  it("按触发词切分阶段区间，上一区间在切换点闭合", () => {
    const phases: ReplayedPhase[] = replayScriptPhases([
      { text: "大家好欢迎来到直播间", endMs: 5000 },
      { text: "今天给大家带来这款产品", endMs: 20000 },
      { text: "点击小黄车下单", endMs: 180000 },
    ]);
    expect(phases).toEqual([
      { phase: "opening", startMs: 5000, endMs: 20000 },
      { phase: "productIntro", startMs: 20000, endMs: 180000 },
      { phase: "cta", startMs: 180000, endMs: 180000 },
    ]);
  });

  it("无触发词时没有阶段（不虚构进度）", () => {
    expect(replayScriptPhases([{ text: "今天天气不错", endMs: 1000 }])).toEqual([]);
  });

  it("同一阶段重复触发只产生一个区间", () => {
    const phases = replayScriptPhases([
      { text: "新来的朋友扣个1", endMs: 1000 },
      { text: "欢迎来到直播间", endMs: 2000 },
      { text: "开始直播了", endMs: 3000 },
    ]);
    expect(phases).toEqual([{ phase: "opening", startMs: 1000, endMs: 3000 }]);
  });

  it("最后阶段持续到最后一条转写", () => {
    const phases = replayScriptPhases([
      { text: "大家好欢迎来到直播间", endMs: 1000 },
      { text: "继续聊", endMs: 90000 },
    ]);
    expect(phases).toEqual([{ phase: "opening", startMs: 1000, endMs: 90000 }]);
  });
});

describe("步骤覆盖计算", () => {
  const phases: ReplayedPhase[] = [
    { phase: "opening", startMs: 5000, endMs: 20000 },
    { phase: "productIntro", startMs: 20000, endMs: 180000 },
    { phase: "cta", startMs: 180000, endMs: 180000 },
  ];

  it("每个步骤只统计自己阶段的停留，不再共享同一个最大值", () => {
    const coverage = computeStepCoverage(framework, phases);
    const byName = Object.fromEntries(coverage.map((c) => [c.step.name, c]));
    // 开场白→opening(5s-20s=15s)；福利预告→interaction(无区间=0)；
    // 收尾感谢→cta(180s-180s=0)；不限时环节→无法映射=0
    expect(byName["开场白"].phase).toBe("opening");
    expect(byName["开场白"].maxStayMs).toBe(15000);
    expect(byName["开场白"].overdue).toBe(false); // 15s < 120s
    expect(byName["福利预告"].phase).toBe("interaction");
    expect(byName["福利预告"].maxStayMs).toBe(0); // 该阶段没有出现过
    expect(byName["福利预告"].overdue).toBe(false);
    expect(byName["收尾感谢"].phase).toBe("cta");
    expect(byName["收尾感谢"].overdue).toBe(false);
    expect(byName["不限时环节"].phase).toBeNull();
    expect(byName["不限时环节"].maxStayMs).toBe(0);
    expect(byName["不限时环节"].overdue).toBe(false);
    // 关键回归：不再所有步骤拿到同一个 160000
    const stays = coverage.map((c) => c.maxStayMs);
    expect(new Set(stays).size).toBeGreaterThan(1);
  });

  it("步骤超过自己阶段的等待时间才报超时（其他阶段再长也不牵连）", () => {
    const tight: Framework = {
      ...framework,
      steps: [
        { id: "t1", frameworkId: "f1", name: "开场白", priority: 2, maxWaitMs: 10000 },
        { id: "t2", frameworkId: "f1", name: "收尾感谢", priority: 0, maxWaitMs: 10000 },
      ],
    };
    const coverage = computeStepCoverage(tight, phases);
    const byName = Object.fromEntries(coverage.map((c) => [c.step.name, c]));
    // opening 15s > 10s → 超时；cta 0s → 不超时（旧算法会让它跟着超时）
    expect(byName["开场白"].overdue).toBe(true);
    expect(byName["收尾感谢"].overdue).toBe(false);
  });

  it("显式声明的 phase 优先于名称推断", () => {
    const explicit: Framework = {
      ...framework,
      steps: [{ id: "e1", frameworkId: "f1", name: "开场白", priority: 2, maxWaitMs: 10000, phase: "productIntro" } as never],
    };
    const coverage = computeStepCoverage(explicit, phases);
    expect(coverage[0].phase).toBe("productIntro");
    expect(coverage[0].maxStayMs).toBe(160000); // productIntro 20s-180s
  });

  it("无法映射阶段的步骤返回 phase=null 且不计超时（不猜测）", () => {
    const unknown: Framework = {
      ...framework,
      steps: [{ id: "u1", frameworkId: "f1", name: "随便一个环节", priority: 2, maxWaitMs: 1 }],
    };
    const coverage = computeStepCoverage(unknown, phases);
    expect(coverage[0].phase).toBeNull();
    expect(coverage[0].maxStayMs).toBe(0);
    expect(coverage[0].overdue).toBe(false);
  });

  it("没有识别到阶段时最长停留为 0、不超时", () => {
    const coverage = computeStepCoverage(framework, []);
    expect(coverage.every((c) => c.maxStayMs === 0 && !c.overdue)).toBe(true);
  });
});

describe("ScriptLoopState 实时语义", () => {
  it("idle 时 elapsedMs 为 0（不把会话总时长当阶段时长）", () => {
    const s = new ScriptLoopState();
    expect(s.elapsedMs(999999)).toBe(0);
  });

  it("阶段切换后 elapsedMs 为切换至当前的停留", () => {
    const s = new ScriptLoopState();
    expect(s.feed("大家好欢迎来到直播间", 1000)).toBe("opening");
    expect(s.elapsedMs(4000)).toBe(3000);
  });

  it("idle 时不做超时判定", () => {
    const s = new ScriptLoopState();
    expect(s.overdueSteps(framework, 999999)).toEqual([]);
  });
});

describe("报告的话术步骤覆盖章节", () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "script-cov-"));
    store = new Store(path.join(dir, "test.db"));
    store.createSession({
      id: "s1",
      startedAtIso: new Date().toISOString(),
      audioSource: "microphone",
      deviceId: null,
    });
  });

  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("有框架有转写时汇总阶段区间与步骤超时", () => {
    store.saveFramework(framework);
    store.insertSegment(seg("t1", "大家好欢迎来到直播间", 0, 5000));
    store.insertSegment(seg("t2", "今天给大家带来这款产品", 5000, 20000));
    store.insertSegment(seg("t3", "点击小黄车下单", 20000, 180000));

    const report = buildReportSummary(store, "s1");
    expect(report).not.toBeNull();
    expect(report!.script).not.toBeNull();
    expect(report!.script!.frameworkName).toBe("测试框架");
    expect(report!.script!.phases).toEqual([
      { phase: "opening", startMs: 5000, endMs: 20000 },
      { phase: "productIntro", startMs: 20000, endMs: 180000 },
      { phase: "cta", startMs: 180000, endMs: 180000 },
    ]);
    const byName = Object.fromEntries(report!.script!.steps.map((s) => [s.name, s]));
    // 开场白只统计自己的 opening 区间 5000→20000 = 15s，不再是所有阶段的最大值 160s
    expect(byName["开场白"].maxStayMs).toBe(15000);
    expect(byName["开场白"].overdue).toBe(false); // 15s < 120s
    expect(byName["收尾感谢"].maxStayMs).toBe(0); // cta 区间为 0 长度
    expect(byName["收尾感谢"].overdue).toBe(false);
    expect(byName["不限时环节"].overdue).toBe(false);
  });

  it("未配置话术框架时 script 为 null（不虚构数据）", () => {
    store.insertSegment(seg("t1", "大家好欢迎来到直播间", 0, 5000));
    const report = buildReportSummary(store, "s1");
    expect(report!.script).toBeNull();
    const html = buildHtmlReport(report!);
    expect(html).toContain("未配置话术框架");
  });

  it("HTML 报告包含步骤覆盖章节与超时标记", () => {
    store.saveFramework(framework);
    store.insertSegment(seg("t1", "大家好欢迎来到直播间", 0, 5000));
    store.insertSegment(seg("t2", "今天给大家带来这款产品", 5000, 180000));
    const html = buildHtmlReport(buildReportSummary(store, "s1")!);
    expect(html).toContain("话术步骤覆盖");
    expect(html).toContain("测试框架");
    expect(html).toContain("已超时");
    expect(html).toContain("产品介绍");
  });
});

describe("orchestrator 话术阶段事件", () => {
  let store: Store;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-script-"));
    store = new Store(path.join(dir, "test.db"));
  });

  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("阶段切换时推送结构化 script.status（含步骤与框架名）", async () => {
    store.saveFramework(framework);
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    } as unknown as BrowserWindow;

    const orch = new SessionOrchestrator(store);
    orch.setWindow(fakeWin);
    const started = await orch.start({ audioSource: "microphone" });
    expect(started.error).toBeNull();

    // 启动即推一次（idle 快照）
    const initial = sent.find((s) => s.channel === "script.status");
    expect(initial).toBeDefined();
    expect((initial!.payload as { phase: string }).phase).toBe("idle");

    (orch as unknown as { handleFinal(p: unknown): void }).handleFinal({
      id: "x1",
      sessionId: started.sessionId,
      connectionId: "c1",
      sourceSeq: 1,
      startMs: 0,
      endMs: 1000,
      text: "大家好欢迎来到直播间",
      isFinal: true,
      createdAt: new Date().toISOString(),
    });

    const phasePush = sent.filter((s) => s.channel === "script.status").pop();
    expect(phasePush).toBeDefined();
    const payload = phasePush!.payload as {
      phase: string;
      phaseElapsedMs: number;
      frameworkName: string | null;
      steps: Array<{ name: string; overdue: boolean }>;
    };
    expect(payload.phase).toBe("opening");
    expect(payload.frameworkName).toBe("测试框架");
    expect(payload.steps.map((s) => s.name)).toEqual(["开场白", "福利预告", "收尾感谢", "不限时环节"]);
    // 刚进入阶段远未超时
    expect(payload.steps.every((s) => !s.overdue)).toBe(true);

    // 不再向 analysis.status 塞 phase: 文本
    expect(sent.some((s) => s.channel === "analysis.status" &&
      String((s.payload as { lastRunStatus: unknown }).lastRunStatus).startsWith("phase:"))).toBe(false);

    await orch.stop();
  });
});
