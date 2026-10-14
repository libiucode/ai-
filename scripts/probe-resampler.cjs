// 重采样器独立实测脚本：直接 require 编译产物 dist/main/main/capture/pcm.js，
// 绕开 vitest，验证 44100→16000 与 48000→16000 的时间基、残余保留与累积漂移。
const path = require("node:path");
const { PcmResamplerSlicer, PACKET_SAMPLES, SAMPLE_RATE } = require(
  path.join("D:\\ai盯播工具\\app\\dist\\main\\main\\capture\\pcm.js"),
);

function sine(rate, freq, seconds) {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function report(name, rate, blockSamples, blocks, blockMs) {
  const slicer = new PcmResamplerSlicer();
  let emitted = 0;
  let packets = 0;
  let maxEnd = 0;
  let minStart = Infinity;
  let maxStart = -Infinity;
  let sumAbs = 0;
  let count = 0;
  let clipped = 0;
  let zeros = 0;
  let gaps = [];
  let prevEnd = 0;
  for (let b = 0; b < blocks; b++) {
    const input = sine(rate, 1000, blockSamples / rate);
    for (const p of slicer.push(input, rate, b * blockMs)) {
      packets++;
      emitted += p.pcm.byteLength / 2;
      const end = p.startMs + p.durationMs;
      maxEnd = Math.max(maxEnd, end);
      minStart = Math.min(minStart, p.startMs);
      maxStart = Math.max(maxStart, p.startMs);
      if (packets > 1) gaps.push(+(p.startMs - prevEnd).toFixed(2));
      prevEnd = end;
      const s = new Int16Array(p.pcm);
      for (let i = 0; i < s.length; i++) {
        const v = Math.abs(s[i]);
        sumAbs += v;
        count++;
        if (v >= 32767) clipped++;
        if (s[i] === 0) zeros++;
      }
    }
  }
  const expectedMs = blocks * blockMs;
  const ratio = (maxEnd / expectedMs).toFixed(4);
  const driftPct = (((maxEnd - expectedMs) / expectedMs) * 100).toFixed(3);
  console.log(
    JSON.stringify(
      {
        场景: name,
        源采样率: rate,
        输入块样本: blockSamples,
        块数: blocks,
        预期时长ms: expectedMs,
        实际覆盖ms: maxEnd,
        时间基比值: Number(ratio),
        漂移百分比: Number(driftPct),
        产出包数: packets,
        产出16k样本数: emitted,
        预期16k样本数: Math.floor((expectedMs / 1000) * SAMPLE_RATE),
        样本丢失率:
          Number(
            (
              100 *
              (1 - emitted / Math.floor((expectedMs / 1000) * SAMPLE_RATE))
            ).toFixed(2),
          ),
        包起点范围: [minStart, maxStart],
        平均幅度: Number((sumAbs / count).toFixed(1)),
        全零样本占比: Number(((zeros / count) * 100).toFixed(3)),
        削波样本数: clipped,
        连续包间隔集合: [...new Set(gaps)],
      },
      null,
      2,
    ),
  );
}

// 模拟真实设备：ScriptProcessor 4096 帧回调
// 44100Hz → 4096/44100 = 92.88ms；48000Hz → 85.33ms
report("44.1kHz 模拟 60 秒", 44100, 4096, 645, 4096 / 44100 * 1000);
report("48kHz 模拟 60 秒", 48000, 4096, 704, 4096 / 48000 * 1000);
report("44.1kHz 单次大块 5 秒", 44100, 44100 * 5, 1, 5000);
report("48kHz 单次大块 5 秒", 48000, 48000 * 5, 1, 5000);

// 零输入：静音场景，验证不会产出垃圾包
{
  const slicer = new PcmResamplerSlicer();
  let packets = 0;
  for (let b = 0; b < 100; b++) {
    packets += slicer.push(new Float32Array(4096), 48000, b * 85).length;
  }
  console.log(JSON.stringify({ 场景: "48kHz 全零输入 100 块", 产出包数: packets, 结论: packets > 0 ? "仍按节拍出包（内容全 0，属预期）" : "不出包" }, null, 2));
}
