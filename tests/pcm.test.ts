import { describe, it, expect } from "vitest";
import { PcmResamplerSlicer, PACKET_SAMPLES } from "../src/main/capture/pcm";

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
