import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TencentAsrAdapter } from "../src/main/asr/tencentAdapter";
import { AsrConfigSchema } from "../src/shared/schemas";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static instances: Socket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    sent: unknown[] = [];
    constructor() { super(); Socket.instances.push(this); }
    send(data: unknown, cb?: (error?: Error) => void) { this.sent.push(data); cb?.(); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  return { default: Socket };
});

type Socket = EventEmitter & { readyState: number; sent: unknown[]; close(): void };
const sockets = () => (WebSocket as unknown as { instances: Socket[] }).instances;
const config = AsrConfigSchema.parse({ provider: "tencent", appId: "test", secretId: "test", secretKey: "test" });
function open(socket: Socket) { socket.readyState = 1; socket.emit("open"); }
function final(socket: Socket, text: string) {
  socket.emit("message", JSON.stringify({ code: 0, result: { index: 0, slice_type: 2, voice_text_str: text, start_time: 0, end_time: 1000 } }));
}
beforeEach(() => { vi.useFakeTimers(); sockets().length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("ASR connection lifecycle", () => {
  it("continues retrying when the initial handshake and a retry both fail", async () => {
    const adapter = new TencentAsrAdapter();
    const connecting = adapter.connect(config).catch(error => error);
    sockets()[0].close();
    await connecting;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets()).toHaveLength(2);
    sockets()[1].close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets()).toHaveLength(3);
    const stopping = adapter.stop();
    await vi.runAllTimersAsync();
    await stopping;
  });

  it("stopping during handshake never sends an end frame to a connecting socket", async () => {
    const adapter = new TencentAsrAdapter();
    const connecting = adapter.connect(config).catch(error => error);
    const socket = sockets()[0];
    const stopping = adapter.stop();
    await vi.advanceTimersByTimeAsync(2100);
    await stopping;
    await connecting;
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(sockets()).toHaveLength(1);
  });

  it("late events from an old connection cannot overwrite a new socket or produce subtitles", async () => {
    const adapter = new TencentAsrAdapter();
    const finals: unknown[] = [];
    adapter.on("final", p => finals.push(p));
    const connecting = adapter.connect(config);
    const first = sockets()[0];
    open(first); await connecting;
    final(first, "first sentence");
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = sockets()[1];
    open(second);
    first.emit("close");
    final(first, "late old sentence");
    final(second, "new sentence");
    await adapter.sendPcm(new ArrayBuffer(6400));
    expect(finals).toHaveLength(2);
    expect((finals[1] as { text: string }).text).toBe("new sentence");
    expect(second.sent).toHaveLength(1);
    const stopping = adapter.stop();
    second.close(); await stopping;
  });

  it("a new connection resets the sentence dedupe state", async () => {
    const adapter = new TencentAsrAdapter();
    const finals: Array<{ connectionId: string; sourceSeq: number }> = [];
    adapter.on("final", p => finals.push(p as typeof finals[number]));
    const connecting = adapter.connect(config);
    open(sockets()[0]); await connecting;
    final(sockets()[0], "before reconnect");
    sockets()[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    open(sockets()[1]);
    final(sockets()[1], "after reconnect");
    expect(finals).toHaveLength(2);
    expect(finals[0].sourceSeq).toBe(0);
    expect(finals[1].sourceSeq).toBe(0);
    expect(finals[0].connectionId).not.toBe(finals[1].connectionId);
    const stopping = adapter.stop();
    sockets()[1].close(); await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });
});
