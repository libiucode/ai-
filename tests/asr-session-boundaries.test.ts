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
    // Windows 上 better-sqlite3 的 close() 之后，文件句柄/索引器可能尚未完全释放，
    // rmSync 会偶发 ENOTEMPTY（已在 10-15 00:32 的全量跑中实测到一次，单独复跑通过）。
    // 这不是被测行为的问题，加 retries 让清理具备可重试性，避免全量结果随机变红。
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-boundary-"));
  const store = new Store(path.join(dir, "test.db"));
  const orch = new SessionOrchestrator(store);
  const asr = (orch as unknown as { asr: TencentAsrAdapter }).asr;
  vi.spyOn(asr, "stop").mockResolvedValue();
  const send = vi.spyOn(asr, "sendPcm").mockResolvedValue();
  const events: Array<[string, unknown]> = [];
  orch.setWindow({ isDestroyed: () => false, webContents: { send: (event: string, payload: unknown) => events.push([event, payload]) } } as never);
  await orch.start({ audioSource: "microphone" });
  resources.push({ store, dir, orch });
  const emit = (event: string, payload: unknown) => (asr as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
  return { orch, store, asr, send, emit, events };
}

describe("ASR session audio boundaries", () => {
  it("flushes queued packets and a sub-packet tail before ending recognition", async () => {
    vi.useFakeTimers();
    const { orch, send, asr } = await setup();
    const internal = orch as unknown as { asrStatus: { state: string } };
    internal.asrStatus.state = "connected";
    orch.ingestAudio(new Float32Array(4000).fill(0.5), 16000);
    expect(send).not.toHaveBeenCalled();
    const stopping = orch.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(send.mock.calls.map(([pcm]) => pcm.byteLength)).toEqual([6400, 1600]);
    expect(send.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(asr.stop).mock.invocationCallOrder[0]);
  });

  it("resume resets packet timing so paused wall time does not cause an audio burst", async () => {
    vi.useFakeTimers();
    const { orch, send } = await setup();
    orch.ingestAudio(new Float32Array(3200), 16000);
    await orch.pause(); send.mockClear();
    await vi.advanceTimersByTimeAsync(120000);
    await orch.resume();
    orch.ingestAudio(new Float32Array(3200), 16000);
    expect(send).not.toHaveBeenCalled();
  });

  it("reconnected sentence timestamps refer to the session's actual audio position", async () => {
    vi.useFakeTimers();
    const { orch, store, emit } = await setup();
    await vi.advanceTimersByTimeAsync(10000);
    emit("status", { state: "connected", connectionId: "new-connection" });
    // First accepted packet is buffered at session time 9000ms.
    (orch as unknown as { pendingPackets: unknown[] }).pendingPackets = [{ pcm: new ArrayBuffer(6400), startMs: 9000, durationMs: 200 }];
    orch.ingestAudio(new Float32Array(0), 16000);
    emit("final", { connectionId: "new-connection", sourceSeq: 0, text: "重新连接后", startMs: 100, endMs: 900, voiceId: "v" });
    const segments = store.querySegments({ sessionId: orch.getSnapshot().sessionId! });
    expect(segments[0]).toMatchObject({ startMs: 9100, endMs: 9900 });
  });

  it("late LLM responses remain in their original session and do not update a new session's UI", async () => {
    // LLM 需处于已配置态，否则本测试验证的"迟到响应仍归旧场"链路不会执行。
    vi.stubEnv("DSH_SECRET_LLM_API_KEY", "fixture-boundary-key");
    vi.stubEnv("DSH_LLM_BASE_URL", "http://127.0.0.1:3425/v1");
    vi.stubEnv("DSH_LLM_MODEL", "group/auto-step-5-preview");
    const { orch, store, events } = await setup();
    const originalSession = orch.getSnapshot().sessionId!;
    store.insertSegment({ id: "old-segment", sessionId: originalSession, connectionId: "old-connection", sourceSeq: 0, startMs: 0, endMs: 900, text: "直播测试", isFinal: true, createdAt: new Date().toISOString() });
    const internal = orch as unknown as {
      llm: { analyze(...args: unknown[]): Promise<unknown> };
      runAnalysis(start: number, end: number): Promise<void>;
      previousSummary: string;
    };
    let finish!: (value: unknown) => void;
    vi.spyOn(internal.llm, "analyze").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const analysis = internal.runAnalysis(0, 1000);
    await orch.stop();
    await orch.start({ audioSource: "microphone" });
    const newSession = orch.getSnapshot().sessionId!;
    events.length = 0;
    finish({ issues: [{ segmentIds: ["old-segment"], quote: "直播测试", type: "other", severity: "warning", basis: "test", recommendation: "test", confidence: 0.9, needsReview: false }], frameworkStateSummary: "old summary" });
    await analysis;
    expect(store.listIssues(originalSession)).toHaveLength(1);
    expect(store.listIssues(newSession)).toHaveLength(0);
    expect(internal.previousSummary).toBe("");
    expect(events).toEqual([]);
  });

  it("ASR errors update the visible status and recovery clears the old error", async () => {
    const { orch, emit, events } = await setup();
    emit("error", { error: { code: "ASR_WS_ERROR", message: "offline", retryable: true } });
    expect(events.filter(([event]) => event === "asr.status").at(-1)?.[1]).toMatchObject({ state: "error" });
    emit("status", { state: "connected", connectionId: "recovered" });
    expect(orch.getSnapshot().asr.lastError).toBeNull();
  });
});
