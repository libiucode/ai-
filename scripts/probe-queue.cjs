// 有界队列实测：BoundedPacketQueue（字节上限）与 orchestrator 的 pendingPackets
// （包数上限）两条路径都要验证上限、溢出策略、以及溢出后是否继续丢最旧。
const path = require("node:path");
const { BoundedPacketQueue, PACKET_MS, SAMPLE_RATE } = require(
  path.join("D:\\ai盯播工具\\app\\dist\\main\\main\\capture\\pcm.js"),
);

function mkPacket(startMs, bytes = SAMPLE_RATE * 2 * (PACKET_MS / 1000)) {
  return { pcm: new ArrayBuffer(bytes), startMs, durationMs: PACKET_MS };
}

console.log("=== 场景 1：BoundedPacketQueue 默认上限（320KB = 10s）===");
{
  const q = new BoundedPacketQueue();
  console.log("默认上限字节:", q.maxBytes ?? "(私有，用行为反推)");
  // 10s / 200ms = 50 包
  for (let i = 0; i < 50; i++) q.push(mkPacket(i * 200));
  console.log("推入 50 包后 size:", q.size, "overflowCount:", q.overflowCount);
  // 继续推 60 包，应持续溢出并丢最旧
  for (let i = 50; i < 110; i++) q.push(mkPacket(i * 200));
  console.log("再推 60 包后 size:", q.size, "overflowCount:", q.overflowCount);
  const drained = q.drain();
  console.log("drain 后 size:", q.size, "drain 包数:", drained.length);
  console.log("drain 首包 startMs:", drained[0]?.startMs, "末包 startMs:", drained[drained.length - 1]?.startMs);
  console.log("→ 首包为 110-50=60*200=12000 表示丢的是最旧包");
  console.log("溢出后是否仍能入队:", (() => { const q2 = new BoundedPacketQueue(1000); for (let i = 0; i < 100; i++) q2.push(mkPacket(i)); return q2.size; })());
}

console.log("\n=== 场景 2：单包超过上限时的行为 ===");
{
  const q = new BoundedPacketQueue(1000);
  const big = mkPacket(0, 5000);
  const ok = q.push(big);
  console.log("推入 5000B 包（上限 1000B）返回:", ok, "size:", q.size, "totalBytes:", q.totalBytes, "overflowCount:", q.overflowCount);
}

console.log("\n=== 场景 3：orchestrator pendingPackets 上限（10000/PACKET_MS = 50 包）===");
{
  // 复刻 orchestrator.ingestAudio 的队列逻辑做行为验证
  const PACKET_MS_ = PACKET_MS;
  const maxPackets = Math.floor(10000 / PACKET_MS_);
  console.log("maxPackets =", maxPackets);
  let pending = [];
  let overflowCount = 0;
  const nowMs = () => 0; // 冻结时钟，让排水不生效，专门看队列上限
  for (let i = 1; i <= 120; i++) {
    pending.push({ pcm: new ArrayBuffer(6400), startMs: i * 200, durationMs: 200 });
    if (pending.length > maxPackets) {
      pending = pending.slice(-maxPackets);
      overflowCount++;
    }
    const sendUntil = nowMs() - 500;
    while (pending.length && pending[0].startMs < sendUntil) pending.shift();
  }
  console.log("冻结时钟下推 120 包后: 队列长度 =", pending.length, "overflowCount =", overflowCount);
  console.log("队列首包 startMs =", pending[0].startMs, "（120-50=70 → 70*200=14000 表示保留最新 50 包）");
}

console.log("\n=== 场景 4：正常实时节奏下是否溢出（500ms 延迟排水）===");
{
  const maxPackets = Math.floor(10000 / PACKET_MS);
  let pending = [];
  let overflowCount = 0;
  // 模拟实时：每秒推 5 包，时钟同步前进，sendUntil = now-500 排掉 500ms 前的包
  let clock = 0;
  for (let sec = 0; sec < 60; sec++) {
    for (let k = 0; k < 5; k++) {
      clock = sec * 1000 + k * 200 + 200;
      pending.push({ pcm: new ArrayBuffer(6400), startMs: clock, durationMs: 200 });
      if (pending.length > maxPackets) {
        pending = pending.slice(-maxPackets);
        overflowCount++;
      }
      const sendUntil = clock - 500;
      while (pending.length && pending[0].startMs < sendUntil) pending.shift();
    }
  }
  console.log("60 秒实时推送后: overflowCount =", overflowCount, "队列长度 =", pending.length);
}
