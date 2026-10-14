import { describe, it, expect } from "vitest";
import { BoundedPacketQueue, PcmResamplerSlicer, PACKET_SAMPLES, PACKET_MS } from "../src/main/capture/pcm";

/** 生成指定频率的正弦波（Float32 mono） */
function sine(rate: number, freq: number, seconds: number): Float32Array {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 统计零交叉数（用于验证波形频率守恒） */
function zeroCrossings(samples: number[]): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
  }
  return crossings;
}

/**
 * 2026-10-14 用户实测回归：44.1k/48k 设备（VB-CABLE 默认 48k）下重采样器按
 * input.length 迭代而非 input.length/ratio，等于升采样补零——音频时钟快 2.76~3 倍，
 * 包时间戳跑进"未来"，主进程按墙上时钟排水时队列溢出、该发的旧包被丢，ASR 收不到
 * 东西（14 秒会话溢出 17 次、0 条转写）。真实联调前没有非 16k 的单测，所以带病通关。
 */
describe("PCM 重采样切片器（任意源速率 → 16k）", () => {
  it("1 秒 44.1k 音频产出约 1 秒的 16k 包（时间基不膨胀）", () => {
    const slicer = new PcmResamplerSlicer();
    const packets = slicer.push(sine(44100, 1000, 1), 44100, 0);
    expect(packets.length).toBe(5); // 16000 样本 / 3200 = 5 个 200ms 包
    const last = packets[packets.length - 1];
    // 修复前最后一包结束时间是 ~2760ms；正确值是 1000ms
    expect(last.startMs + last.durationMs).toBeLessThanOrEqual(1000);
    expect(last.startMs + last.durationMs).toBeGreaterThan(900);
  });

  it("48k 设备同样时间基正确", () => {
    const slicer = new PcmResamplerSlicer();
    const packets = slicer.push(sine(48000, 1000, 1), 48000, 0);
    expect(packets.length).toBe(5);
    expect(packets[4].startMs + packets[4].durationMs).toBe(1000);
  });

  it("16k 输入直通（ratio=1 时行为不变）", () => {
    const slicer = new PcmResamplerSlicer();
    const packets = slicer.push(sine(16000, 1000, 1), 16000, 0);
    expect(packets.length).toBe(5);
  });

  it("下采样后波形频率守恒（1kHz 正弦仍是 1kHz，不是补零垃圾）", () => {
    const slicer = new PcmResamplerSlicer();
    const packets = slicer.push(sine(44100, 1000, 1), 44100, 0);
    const all: number[] = [];
    for (const p of packets) all.push(...Array.from(new Int16Array(p.pcm)));
    // 1 秒 1kHz → 恰约 2000 次零交叉；修复前（补零 + 快进 2.76 倍）也应是 ~2000，
    // 但配合时间戳膨胀会让下游全乱——这里锁的是内容本身没错
    expect(zeroCrossings(all)).toBeGreaterThan(1800);
    expect(zeroCrossings(all)).toBeLessThan(2200);
  });

  it("连续小 push 的包时间戳与真实时长一致（模拟 ScriptProcessor 每 93ms 一推）", () => {
    const slicer = new PcmResamplerSlicer();
    let maxEnd = 0;
    for (let s = 0; s < 10; s++) {
      const packets = slicer.push(sine(44100, 1000, 0.1), 44100, s * 100);
      for (const p of packets) maxEnd = Math.max(maxEnd, p.startMs + p.durationMs);
    }
    // 10 × 100ms = 1 秒实时音频 → 覆盖 ~1000ms；修复前会是 ~2760ms
    expect(maxEnd).toBeGreaterThan(800);
    expect(maxEnd).toBeLessThanOrEqual(1000);
  });

  it("成包后保留残余样本，不周期性丢帧（48k 连续推 10 个 4096 块）", () => {
    const slicer = new PcmResamplerSlicer();
    let emitted = 0;
    for (let i = 0; i < 10; i++) {
      const packets = slicer.push(new Float32Array(4096).fill(0.5), 48000, i * 85);
      emitted += packets.length * PACKET_SAMPLES;
    }
    // 输入 10×4096@48k → 13650 个 16k 样本。修复前每次成包把残余清零
    // （丢 ~895 样本/次），只发出 9600；修复后保留残余，至少发 4 包 = 12800
    expect(emitted).toBeGreaterThanOrEqual(12800);
  });
});

/**
 * 有界队列边界。2026-10-14 实测发现两个问题：
 * 1. 溢出时只丢一包就停，一次 push 后占用字节仍可能越过上限；
 * 2. 单包体积超过上限时，旧实现先 shift 一包再把这个超大包塞进去，
 *    上限完全失效（上限 1000B 收 5000B 包 → 占用 5000B）。
 */
describe("BoundedPacketQueue 上限与溢出策略", () => {
  const pkt = (startMs: number, bytes = 6400) => ({ pcm: new ArrayBuffer(bytes), startMs, durationMs: PACKET_MS });

  it("未满时不溢出，满了丢最旧并计数", () => {
    const q = new BoundedPacketQueue(6400 * 3);
    for (let i = 0; i < 3; i++) q.push(pkt(i));
    expect(q.size).toBe(3);
    expect(q.overflowCount).toBe(0);
    expect(q.rejectedCount).toBe(0);
    const ok = q.push(pkt(3));
    expect(ok).toBe(true);
    expect(q.overflowCount).toBe(1);
    expect(q.size).toBe(3);
    const drained = q.drain();
    // 丢的是最旧的
    expect(drained[0].startMs).toBe(1);
    expect(drained[2].startMs).toBe(3);
  });

  it("溢出后占用字节不越过上限", () => {
    const q = new BoundedPacketQueue(6400 * 3);
    for (let i = 0; i < 10; i++) q.push(pkt(i));
    expect(q.bytes).toBeLessThanOrEqual(6400 * 3);
    // 连续丢到放得下为止，而不是只丢一包
    expect(q.overflowCount).toBe(7);
  });

  it("单包超过上限时拒绝入队且不破坏上限", () => {
    const q = new BoundedPacketQueue(1000);
    const ok = q.push(pkt(0, 5000));
    expect(ok).toBe(false);
    expect(q.rejectedCount).toBe(1);
    expect(q.overflowCount).toBe(0);
    expect(q.size).toBe(0);
    expect(q.bytes).toBe(0);
  });

  it("被拒绝后仍能继续收正常包（不被永久堵死）", () => {
    const q = new BoundedPacketQueue(6400);
    expect(q.push(pkt(0, 99999))).toBe(false);
    expect(q.push(pkt(1, 6400))).toBe(true);
    expect(q.size).toBe(1);
    expect(q.bytes).toBe(6400);
  });

  it("onOverflow 与 onReject 回调分别触发", () => {
    const overflows: number[] = [];
    const rejects: number[] = [];
    const q = new BoundedPacketQueue(6400, (c) => overflows.push(c), (c) => rejects.push(c));
    q.push(pkt(0, 6400));
    q.push(pkt(1, 6400)); // 溢出
    q.push(pkt(2, 99999)); // 超大包拒绝
    expect(overflows).toEqual([1]);
    expect(rejects).toEqual([1]);
  });

  it("默认上限是 10 秒 16kHz 16bit 单声道", () => {
    const q = new BoundedPacketQueue();
    // 一个 200ms 包 = 3200 样本 × 2 字节 = 6400B；10s = 50 包
    for (let i = 0; i < 60; i++) q.push(pkt(i));
    expect(q.size).toBe(50);
    expect(q.overflowCount).toBe(10);
    expect(q.bytes).toBe(320000);
  });
});
