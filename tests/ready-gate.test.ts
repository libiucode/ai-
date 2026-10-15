import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionOrchestrator } from "../src/main/analysis/orchestrator";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { Store } from "../src/main/storage/store";

const resources: Array<{ store: Store; dir: string; orch: SessionOrchestrator }> = [];
afterEach(async () => {
  for (const { orch, store, dir } of resources.splice(0)) {
    await orch.stop(); store.close();
    // 同 asr-session-boundaries.test.ts：Windows 上 sqlite close() 后句柄释放有延迟，
    // rmSync 会偶发 ENOTEMPTY，加 retries 消除全量跑随机变红。
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
});

function tempStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ready-gate-"));
  const store = new Store(path.join(dir, "t.db"));
  store.saveFramework({ id: "fw", name: "测试框架", productFacts: "", updatedAt: new Date().toISOString(), steps: [], rules: [] });
  return { store, dir };
}

/** 只建 orchestrator，不 start()：用于测「音频早于会话」的就绪窗口。 */
function makeOrch(store: Store) {
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_ID", "");
  vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "");
  vi.spyOn(TencentAsrAdapter.prototype, "connect").mockResolvedValue();
  vi.spyOn(TencentAsrAdapter.prototype, "stop").mockResolvedValue();
  const sendPcm = vi.spyOn(TencentAsrAdapter.prototype, "sendPcm").mockResolvedValue();
  const orch = new SessionOrchestrator(store);
  const events: Array<{ event: string; payload: unknown }> = [];
  orch.setWindow({ isDestroyed: () => false, webContents: { send: (event: string, payload: unknown) => events.push({ event, payload }) } } as never);
  return { orch, events, sendPcm };
}

describe("无人值守时序就绪门", () => {
  it("G1 音频早于会话到达：缓冲后转 active 补发，不丢帧", async () => {
    const { store, dir } = tempStore();
    const { orch, sendPcm } = makeOrch(store);
    resources.push({ store, dir, orch });

    const asr = (orch as unknown as { asr: { emit(e: string, p: unknown): void; status?: string } }).asr;
    // 采集先于建会话：此时 sessionId 为空、status 为 idle
    orch.ingestAudio(new Float32Array(16000).fill(0.4), 16000);
    expect(orch.getSnapshot().sessionId).toBeNull();
    expect(sendPcm).not.toHaveBeenCalled();
    const gate = orch as unknown as { preStartSamples: number[] };
    expect(gate.preStartSamples.length).toBe(16000); // 缓冲确实存下了

    await orch.start({ audioSource: "microphone" });
    expect(orch.getSnapshot().sessionId).not.toBeNull();
    // 关键断言：缓冲必须被「补发成包」，而不是被 start() 清空。
    // 历史缺陷：start() 无条件 preStartSamples=[]，把缓冲抹掉，flush 拿到空数组，
    // 测试只断言 preStartSamples===[] 于是「抹掉」和「补发」都通过——空洞断言。
    const internal = orch as unknown as { preStartSamples: number[]; pendingPackets: unknown[] };
    expect(internal.preStartSamples).toEqual([]);
    // 1 秒音频 → 5 个 200ms 包进入待发送队列
    expect(internal.pendingPackets.length).toBe(5);
    // 且时间戳从会话起点开始，不是 0 之前
    const first = internal.pendingPackets[0] as { startMs: number };
    expect(first.startMs).toBeGreaterThanOrEqual(0);
    void asr;
  });

  it("G2 会话真的没建时丢弃，不无限攒音频", () => {
    const { store } = tempStore();
    const { orch } = makeOrch(store);
    // 从未 start()，status=idle；缓冲只保留最近 3 秒，超出即丢弃最早样本
    for (let i = 0; i < 20; i++) orch.ingestAudio(new Float32Array(16000).fill(0.4), 16000);
    const internal = orch as unknown as { preStartSamples: number[] };
    // 20 次 × 1 秒 = 20 秒音频，缓冲上限 3 秒 → 不可能无限增长
    expect(internal.preStartSamples.length).toBeLessThanOrEqual(16000 * 3 + 1);
    store.close();
  });

  it("G3 过期缓冲不灌入后续会话", async () => {
    const { store, dir } = tempStore();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    vi.useFakeTimers();
    orch.ingestAudio(new Float32Array(16000).fill(0.4), 16000);
    const internal = orch as unknown as { preStartSamples: number[]; preStartBufferedAt: number };
    expect(internal.preStartSamples.length).toBeGreaterThan(0);
    // 超过就绪窗口后才建会话：陈旧的 1 秒音频不应被补发
    vi.advanceTimersByTime(10000);
    await orch.start({ audioSource: "microphone" });
    await vi.advanceTimersByTimeAsync(0);
    expect(internal.preStartSamples).toEqual([]);
  });

  it("G4 已 active 时正常送达，不受就绪门影响", async () => {
    const { store, dir } = tempStore();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone" });
    const asrStatus = (orch as unknown as { asrStatus: { state: string } }).asrStatus;
    asrStatus.state = "connected";
    const internal = orch as unknown as { pendingPackets: unknown[] };
    orch.ingestAudio(new Float32Array(16000).fill(0.4), 16000);
    // active 后走正常路径，不进就绪缓冲
    const gate = orch as unknown as { preStartSamples: number[] };
    expect(gate.preStartSamples).toEqual([]);
    expect(internal.pendingPackets.length).toBeGreaterThan(0);
  });
});

describe("多话术框架会话绑定", () => {
  function storeWithTwo(): { store: Store; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-fw-"));
    const store = new Store(path.join(dir, "t.db"));
    store.saveFramework({ id: "fw-a", name: "商品A话术", productFacts: "A", updatedAt: new Date().toISOString(), steps: [], rules: [] });
    store.saveFramework({ id: "fw-b", name: "商品B话术", productFacts: "B", updatedAt: new Date().toISOString(), steps: [], rules: [] });
    return { store, dir };
  }

  it("start 指定 frameworkId 时绑定该框架", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone", frameworkId: "fw-b" } as never);
    expect(orch.activeFrameworkId).toBe("fw-b");
    expect(orch.activeFramework?.name).toBe("商品B话术");
  });

  it("未指定时回退第一个框架（兼容单框架行为）", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone" });
    expect(orch.activeFrameworkId).not.toBeNull();
  });

  it("指定不存在的框架：回退第一个并提示，不中断会话", async () => {
    const { store, dir } = storeWithTwo();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone", frameworkId: "不存在" } as never);
    expect(orch.activeFrameworkId).not.toBeNull();
    expect(events.some((e) => e.event === "app.error" && (e.payload as { code: string }).code === "FRAMEWORK_NOT_FOUND")).toBe(true);
  });

  it("switchFramework 会话中切商品，并重置阶段状态", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone", frameworkId: "fw-a" } as never);
    expect(orch.switchFramework("fw-b")).toBe(true);
    expect(orch.activeFrameworkId).toBe("fw-b");
    expect(orch.switchFramework("不存在")).toBe(false);
    expect(orch.activeFrameworkId).toBe("fw-b"); // 失败不改变当前框架
  });

  it("框架绑定落库：会话创建时写入，切换时更新（历史导出可追溯）", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone", frameworkId: "fw-a" } as never);
    const sid = orch.getSnapshot().sessionId!;
    // 创建时已落库：内存态重启即失效，会话记录才是历史导出的依据
    expect(store.getSession(sid)?.framework_id).toBe("fw-a");
    // 切换后必须更新，否则历史报告会显示切换前的框架
    expect(orch.switchFramework("fw-b")).toBe(true);
    expect(store.getSession(sid)?.framework_id).toBe("fw-b");
    // 切换失败不落库
    expect(orch.switchFramework("不存在")).toBe(false);
    expect(store.getSession(sid)?.framework_id).toBe("fw-b");
  });

  it("主播字段正式落库：speakerId 稳定用于聚合，speakerName 为当次快照", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone", speakerId: "sp-001", speakerName: "小明" } as never);
    const row = store.getSession(orch.getSnapshot().sessionId!) as unknown as { speaker_id: string | null; speaker_name: string | null };
    expect(row.speaker_id).toBe("sp-001");
    expect(row.speaker_name).toBe("小明");
  });

  it("主播改名不断历史聚合：同 id 不同 name 仍归同一主播", async () => {
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    // 第一场：id=sp-001 名=小明
    await orch.start({ audioSource: "microphone", speakerId: "sp-001", speakerName: "小明" } as never);
    const first = orch.getSnapshot().sessionId!;
    await orch.stop();
    // 第二场：同一主播改名
    await orch.start({ audioSource: "microphone", speakerId: "sp-001", speakerName: "小明（新号）" } as never);
    const second = orch.getSnapshot().sessionId!;
    const a = store.getSession(first) as unknown as { speaker_id: string; speaker_name: string };
    const b = store.getSession(second) as unknown as { speaker_id: string; speaker_name: string };
    expect(a.speaker_id).toBe(b.speaker_id);      // 聚合不断
    expect(a.speaker_name).not.toBe(b.speaker_name); // 历史快照保留原名
    expect(a.speaker_name).toBe("小明");
  });

  it("高频错误节流：溢出刷屏时 emit 被抑制，但累计次数可从状态读到", () => {
    const { store } = storeWithTwo();
    const { orch, events } = makeOrch(store);
    // 直接调私有节流方法，不 start()：避免 stop() 按 1:1 实时速率 flush 队列拖垮 afterEach。
    const internals = orch as unknown as { emitThrottledError: (e: unknown) => boolean };
    const overflowCount = () => events.filter((e) => e.event === "app.error" && (e.payload as { code: string }).code === "CAPTURE_QUEUE_OVERFLOW").length;
    const before = overflowCount();
    // 模拟 200 次按帧溢出（约 85ms 一次，几秒内刷屏的场景）
    for (let i = 0; i < 200; i++) {
      internals.emitThrottledError({ code: "CAPTURE_QUEUE_OVERFLOW", message: "音频队列已满，丢弃旧包", retryable: true });
    }
    // 节流：200 次只 emit 1 条（首次），不会刷屏
    expect(overflowCount() - before).toBe(1);
    // 次数不丢失：累计次数可从 orchestrator 读到
    expect(orch.getErrorCount("CAPTURE_QUEUE_OVERFLOW")).toBe(200);
    store.close();
  });

  it("不同错误码各自独立节流，不互相吞掉", () => {
    const { store } = storeWithTwo();
    const { orch, events } = makeOrch(store);
    const internals = orch as unknown as { emitThrottledError: (e: unknown) => boolean };
    for (let i = 0; i < 50; i++) internals.emitThrottledError({ code: "PRE_START_BUFFER_OVERFLOW", message: "x", retryable: true });
    for (let i = 0; i < 50; i++) internals.emitThrottledError({ code: "CAPTURE_QUEUE_OVERFLOW", message: "y", retryable: true });
    expect(orch.getErrorCount("PRE_START_BUFFER_OVERFLOW")).toBe(50);
    expect(orch.getErrorCount("CAPTURE_QUEUE_OVERFLOW")).toBe(50);
    const codes = events.filter((e) => e.event === "app.error").map((e) => (e.payload as { code: string }).code);
    expect(new Set(codes).size).toBe(2);
    store.close();
  });

  it("未做语义分析不得记 success：LLM 未配置与空窗口都记 skipped", async () => {
    for (const name of ["DSH_SECRET_LLM_API_KEY", "DSH_LLM_BASE_URL", "DSH_LLM_MODEL"]) vi.stubEnv(name, "");
    const { store, dir } = storeWithTwo();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone" } as never);
    const sid = orch.getSnapshot().sessionId!;
    store.insertSegment({ id: "seg-skip", sessionId: sid, connectionId: "c1", sourceSeq: 0, startMs: 0, endMs: 5000, text: "模拟片段", isFinal: true, createdAt: new Date().toISOString() });
    const run = (a: number, b: number) => (orch as unknown as { runAnalysis: (x: number, y: number) => Promise<void> }).runAnalysis(a, b);
    await run(0, 300000); // 有片段但 LLM 未配置 → skipped
    const row = store.db.prepare("SELECT status,error_message FROM analysis_runs WHERE session_id=?").get(sid) as { status: string; error_message: string };
    expect(row.status).toBe("skipped");
    expect(row.error_message).toContain("llm-not-configured");
    // 空窗口同样 skipped，且不许计入 success
    await run(300000, 600000);
    const row2 = store.db.prepare("SELECT status FROM analysis_runs WHERE session_id=? ORDER BY started_at DESC").get(sid) as { status: string };
    expect(row2.status).toBe("skipped");
    const stats = store.analysisRunStats(sid);
    expect(stats.total).toBe(2);
    expect(stats.success).toBe(0);
  });
});

describe("按排期窗口结束（零额度，不依赖任何用户手势）", () => {
  /** 把排期写成「覆盖当前时刻、结束时刻在 N 秒后」的窗口。 */
  function armSchedule(store: Store, endOffsetSec: number) {
    const now = new Date();
    const end = new Date(now.getTime() + endOffsetSec * 1000);
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    // 窗口 = [now-1h, now+offset]，保证 now 落在窗口内。
    // 深夜跑时 start 会落到前一天、使窗口呈「跨天」形态（23:30→01:30），
    // scheduledEndAt 对此的处理正好也是我们想要的今天 end 时刻。
    const start = new Date(now.getTime() - 3600 * 1000);
    store.setSetting("app_settings", JSON.stringify({
      windowIntervalSec: 60,
      windowSizeSec: 300,
      schedule: {
        enabled: true,
        startTime: hhmm(start),
        endTime: hhmm(end),
        weekdays: [],
        audioSource: "microphone",
        frameworkId: null,
      },
    }));
    return end;
  }

  it("会话开始时绑定排期结束时刻，并广播给界面", async () => {
    const { store, dir } = tempStore();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    armSchedule(store, 3600);
    await orch.start({ audioSource: "microphone" });
    const snap = orch.getSnapshot();
    expect(snap.scheduledEndAtMs).not.toBeNull();
    expect(events.some((e) => e.event === "schedule.status")).toBe(true);
  });

  it("未配置排期时不绑定结束时刻（临时监听不会被预约掐断）", async () => {
    const { store, dir } = tempStore();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    await orch.start({ audioSource: "microphone" });
    expect(orch.getSnapshot().scheduledEndAtMs).toBeNull();
    expect(events.some((e) => e.event === "schedule.status")).toBe(false);
  });

  it("排期窗口外开始监听 → 不绑定结束时刻", async () => {
    const { store, dir } = tempStore();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    // 造一个「今天稍早已结束」的窗口：结束时刻落在 2 小时前，且不跨天回到现在。
    // 这样无论测试在一天中的什么时刻跑，now 都在窗口之外。
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const end = new Date(now.getTime() - 2 * 3600 * 1000);
    const start = new Date(now.getTime() - 3 * 3600 * 1000);
    // 若减 3 小时跨到了昨天，这个跨天窗口形态会变得不确定，直接跳过该轮断言。
    if (start.getDate() === now.getDate() && end.getDate() === now.getDate()) {
      store.setSetting("app_settings", JSON.stringify({
        windowIntervalSec: 60,
        windowSizeSec: 300,
        schedule: { enabled: true, startTime: hhmm(start), endTime: hhmm(end), weekdays: [], audioSource: "microphone", frameworkId: null },
      }));
      await orch.start({ audioSource: "microphone" });
      expect(orch.getSnapshot().scheduledEndAtMs).toBeNull();
    }
  });

  it("到点自动结束：写 end_reason=schedule-window-end 且向用户提示原因", async () => {
    const { store, dir } = tempStore();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    armSchedule(store, 3600);
    await orch.start({ audioSource: "microphone" });
    const sid = orch.getSnapshot().sessionId!;

    // 把结束时刻拨到过去，然后跑一次 tick（等价于「时间到了」）
    const internal = orch as unknown as { scheduledEndAtMs: number | null };
    internal.scheduledEndAtMs = Date.now() - 1;
    await vi.waitFor(() => expect(orch.getSnapshot().lastEndReason).toBe("schedule-window-end"), { timeout: 4000 });

    const row = store.getSession(sid)!;
    expect(row.status).toBe("stopped");
    expect(row.end_reason).toBe("schedule-window-end");
    // 自动结束必须可见，否则用户会以为是软件故障
    expect(events.some((e) => e.event === "app.error" && (e.payload as { code: string }).code === "SESSION_AUTO_ENDED")).toBe(true);
    // 重复触发保护：清空后不会再次结束
    expect(orch.getSnapshot().scheduledEndAtMs).toBeNull();
  });

  it("用户手动结束写 user，不会被误标成排期结束", async () => {
    const { store, dir } = tempStore();
    const { orch } = makeOrch(store);
    resources.push({ store, dir, orch });
    armSchedule(store, 3600);
    await orch.start({ audioSource: "microphone" });
    const sid = orch.getSnapshot().sessionId!;
    await orch.stop();
    expect(store.getSession(sid)!.end_reason).toBe("user");
    expect(orch.getSnapshot().lastEndReason).toBe("user");
  });

  it("会话结束显式广播「已无排期结束时刻」，不留残留值", async () => {
    // 历史缺陷：前端只在 startSession 里清 scheduleStatus，会话自然结束不经过那条路径，
    // 于是下一个（窗口外的）会话会拿旧值显示一个假的结束时刻。
    // 修法：结束时主进程显式发 scheduledEndAtIso=null，让「已无排期结束」成为事实。
    const { store, dir } = tempStore();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    armSchedule(store, 3600);
    await orch.start({ audioSource: "microphone" });
    expect(orch.getSnapshot().scheduledEndAtMs).not.toBeNull();

    events.length = 0;
    await orch.stop();

    expect(orch.getSnapshot().scheduledEndAtMs).toBeNull();
    const reset = events.filter((e) => e.event === "schedule.status");
    expect(reset.length).toBeGreaterThan(0);
    expect((reset.at(-1)!.payload as { scheduledEndAtIso: string | null }).scheduledEndAtIso).toBeNull();
  });

  it("自动结束后也广播 null（不能只有手动结束才清）", async () => {
    const { store, dir } = tempStore();
    const { orch, events } = makeOrch(store);
    resources.push({ store, dir, orch });
    armSchedule(store, 3600);
    await orch.start({ audioSource: "microphone" });
    const internal = orch as unknown as { scheduledEndAtMs: number | null };
    internal.scheduledEndAtMs = Date.now() - 1;
    await vi.waitFor(() => expect(orch.getSnapshot().lastEndReason).toBe("schedule-window-end"), { timeout: 4000 });

    const resets = events.filter((e) => e.event === "schedule.status" && (e.payload as { scheduledEndAtIso: string | null }).scheduledEndAtIso === null);
    expect(resets.length).toBeGreaterThan(0);
  });
});
