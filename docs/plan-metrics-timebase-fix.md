# 方案二：语速时间基修复（plan-metrics-timebase-fix）

- 时间：2026-10-16
- 审计基线：HEAD `407c01d`，**378/378 通过（33 文件）**（本轮实测复现）
- ⚠️ **行进中的并发改动（重要）**：审计期间另一名实现者正在同一工作树上改 `src/`（新增「框架一致性比对」通道，见 `src/main/analysis/factCheck.ts`，插入位置在 `orchestrator.ts:786` 之后）。
  - 我在 21:49–21:50 读取时工作树是干净的；该改动落盘于 21:51:45。
  - 影响：`orchestrator.ts` 因新增一行 import 导致 **786 行以下的行号整体 +1**。**本文档已按「+1 后的当前行号」标注**，并在 §1 给出对照。
  - **未受影响的锚点**（语义未变）：`insertSpeechInterval` 三处 = `481 / 546 / 599`；`asrAudioStartMs` 赋值 = `587`；`querySpeechIntervals` 调用 = `748`；severity = `770`；needsReview = `779`。
  - **实现者动手前请重新 `Select-String` 核对一次行号**，因为并发改动可能继续。
- 目标：消除 `computeMetrics` 里「墙钟窗口 × 音频轴区间」的混用，让 `speechMs` / `silenceMs` / `charsPerSpeechMinute` / `longestSilenceMs` 不再失真
- 纪律：所有结论带文件:行号 + 实际读到的代码。**未实测的标注「不确定」。**

---

## 0. 一句话结论（与任务书假设不同，请先看这条）

**❌ 方案 A（在 3 处 `insertSpeechInterval` 加 `asrAudioStartMs` 换算）在算术上不成立，不能采用。**

理由（`orchestrator.ts:587` 实测读到）：

```ts
private sendPacket(packet: AudioPacket): Promise<void> {
  if (this.asrStatus.state === "connected" && !this.asrAudioStarted) {
    // Tencent timestamps start at zero for each connection. Anchor them to
    // the first audio packet actually sent on that connection.
    this.asrAudioStartMs = packet.startMs;      // ← 音频轴值，不是墙钟
    this.asrAudioStarted = true;
  }
  return this.asr.sendPcm(packet.pcm);
}
```

**`asrAudioStartMs` 被赋的是 `packet.startMs`，而 `packet.startMs` 来自 `PcmResamplerSlicer.nextStartMs`——正是音频轴本身**（`pcm.ts:87, 134-137`）。它不是墙钟锚。
因此 `iv.startMs + asrAudioStartMs` 是 **音频轴 + 音频轴 = 音频轴**，只是**平移**了一个音频轴量，**方向、量级都没变**。而失真本质是**缩放型**误差（双份音频 → 累加量翻倍）。**平移消不掉缩放。**

> ⚠️ **任务书里写「`orchestrator.ts` 里已有锚点 `asrAudioStartMs`（`sendPacket()` 里把首个音频包钉到墙钟）」——这句话与代码不符。** 第 107 行确实有一处 `this.asrAudioStartMs = this.nowMs()`（墙钟）：
> ```ts
> :106  if (st.state === "connected") {
> :107    this.asrAudioStartMs = this.nowMs();   // ← 这里是墙钟
> :108    this.asrAudioStarted = false;
> ```
> **但它在第 587 行被 `packet.startMs` 覆盖**（因为 `asrAudioStarted` 被重置为 false，首个包发出时必然走进 583 的分支）。所以 `handleFinal` 用的 `asrAudioStartMs + p.startMs`（`:635`）里那个 `asrAudioStartMs`，**实际是音频轴值**。

**推荐方案：B+（读取端统一 + 时间基显式标注 + 历史数据隔离）**，见 §3。

---

## 1. 现状核实（逐行）

### 1.1 `computeMetrics` 的两处混用（源码已就地标注）

`src/main/analysis/metrics.ts:87-108`：

```ts
export function computeMetrics(
  segments: TranscriptSegment[],
  speechIntervals: Array<{ startMs: number; endMs: number }>,
  windowStartMs: number,
  windowEndMs: number,
): WindowMetrics {
  const totalMs = Math.max(0, windowEndMs - windowStartMs);
  // 窗口裁剪：截断到墙钟窗口。
  // ⚠️ 这里是两条时间轴的交汇点——`speech_intervals` 是音频轴、
  // 窗口边界是墙钟。
  const intervals = speechIntervals
    .map((iv) => ({ startMs: Math.max(iv.startMs, windowStartMs), endMs: Math.min(iv.endMs, windowEndMs) }))
    ...
```

`metrics.ts:147-153`（第二处）：

```ts
  let longestSilenceMs = 0;
  let cursorMs = windowStartMs;              // ← 墙钟
  for (const iv of merged) {
    longestSilenceMs = Math.max(longestSilenceMs, iv.startMs - cursorMs);  // iv 是音频轴
    cursorMs = iv.endMs;
  }
  longestSilenceMs = Math.max(longestSilenceMs, windowEndMs - cursorMs);
```

### 1.2 音频轴是怎么产生并被存进去的

`pcm.ts:87` — `private nextStartMs = 0;`（**按样本数累加**，与墙钟无关）
`pcm.ts:134-137`：
```ts
        packets.push({ pcm: out.buffer.slice(0), startMs: this.nextStartMs, durationMs: PACKET_MS });
        this.nextStartMs += PACKET_MS;
```

`orchestrator.ts:477-481`（写入点 1）：
```ts
    const packets = this.slicer.push(float32, sourceRate, this.nowMs());  // nowMs() 只传给 inputStartMs，push() 内部未使用它决定 startMs
    for (const p of packets) {
      for (const iv of detectSpeechIntervals([p])) {
        this.store.insertSpeechInterval({ id: crypto.randomUUID(), sessionId: this.sessionId!, ...iv });
      }
```

> **实测确认**：`pcm.ts:111` 的签名是 `push(input, sourceRate, inputStartMs)`，函数体内**从未使用 `inputStartMs`**（我通读了 `pcm.ts:111-146`）。`startMs` 完全由 `nextStartMs` 累加得出。**所以 `nowMs()` 传进去也没用——音频轴确实是「独立自走」的。**

`orchestrator.ts:543-547`（写入点 2）、`orchestrator.ts:597-601`（写入点 3）同理。

### 1.3 `slicer` 的重置点

- `orchestrator.ts:286` — `start()` 里 `this.slicer = new PcmResamplerSlicer();` → `nextStartMs` 归 0
- `orchestrator.ts:410` — `resume()` 里 `this.slicer.reset(this.nowMs());` → **`nextStartMs` 被设为墙钟值！**

> ⚠️ **这是一个既有的额外缺陷，任务书没提**：`resume()` 之后音频轴**起点变成墙钟值**（例如 120000ms），此后 `speech_intervals` 存的是「墙钟偏移 + 音频累加」的**第三种混合量**。也就是说，**同一条会话里，暂停前和暂停后的 `speech_intervals` 时间基不一样。** 这是 §3.4 必须处理的情况。

### 1.4 转写时间戳（对照，确认它才是正确的）

`orchestrator.ts:629-639`：
```ts
    const seg = {
      ...
      startMs: this.asrAudioStartMs + p.startMs,
      endMs: this.asrAudioStartMs + p.endMs,
```
这里的 `p.startMs` 是**腾讯云返回的服务端相对时间**（`AsrFinalPayload`），**不是**本地音频轴。服务端按真实收到的音频计时，不受本地切片器双份影响。

**实测佐证**（本轮查库）：会话 `5970a6d6` 的 `speech_intervals` 最大 `end_ms = 551000`，而 `transcript_segments` 最大 `end_ms = 8420` —— 相差 65 倍。**说明转写确实没跟着音频轴漂。**（`metrics.ts:120-122` 的注释也是这个判断。）

---

## 2. 关键事实核实：历史数据到底有多少

> ⚠️ **更正任务书**：任务书说「库里已有 25 场历史会话的 `speech_intervals` 全是音频轴」。
> **实测：25 是会话总数，其中只有 10 场有 `speech_intervals`。**

本轮只读查库结果（`better-sqlite3` readonly，脚本 `audit-db-q.cjs`，未写入）：

```
sessions total = 25
sessions with intervals = 10
intervals total = 8968
segments total = 68
```

| 会话 | 墙钟跨度 | 音频轴跨度 | 比值 | 区间数 | 转写尾 |
|---|---|---|---|---|---|
| `ae85dc7c` | 82757 | 58800 | 0.711 | 196 | 62780 |
| `190ba540` | 79736 | 53800 | 0.675 | 183 | 60120 |
| `e0624009` | 458222 | 358600 | 0.783 | 1793 | (无) |
| `a83d2607` | 158124 | 103457.5 | 0.654 | 518 | (无) |
| `2920b432` | 900630 | 742400 | 0.824 | 2632 | 742840 |
| **`5970a6d6`** | 325615 | **551000** | **1.692** | 2225 | 8420 |
| `b217299a` | 260910 | 245000 | 0.939 | 1218 | 245220 |
| **`d61e4b32`** | 29708 | **37400** | **1.259** | 144 | 19308 |
| `dceb425f` | 40849 | 11663.75 | 0.286 | 55 | (无) |
| `9df419b4` | 18067 | 800 | 0.044 | 4 | (无) |

**两个重要发现**：

1. **漂移不是单向「音频轴偏快」**：10 场里 **8 场比值 < 1**（0.044 ~ 0.939），只有 2 场 > 1（1.259 / 1.692，正是 `audio-clock-anomaly.md` 定案的双管线会话）。**多数会话音频轴反而「慢于」墙钟**——因为音频在会话起止、暂停期没有被送（`nextStartMs` 只在有音频时累加）。
2. **`9df419b4` 比值 0.044（墙钟 18 秒，音频轴只有 0.8 秒）**：这是「音频轴严重落后」的极端例子。**在这种会话上，方案 A 的「加锚点」会把区间推到会话末尾之外。**

---

## 3. 方案推荐：**B+（读取端换算 + 显式时间基 + 历史隔离）**

### 3.1 三个方案的评估

| 方案 | 可行性 | 判定 |
|---|---|---|
| **A. 3 处写入端加 `asrAudioStartMs`** | ❌ `asrAudioStartMs` 本身是音频轴值（`orchestrator.ts:587`），相加仍是音频轴；且它是**平移**，无法纠正**缩放型**漂移 | **否决**。附带：`resume()` 后 `nextStartMs` 已被设为墙钟（`:410`），加锚点会二次叠加 |
| **B. `metrics.ts` 读取端统一换算** | ✅ 可行，且是唯一能同时处理「新旧数据」的位置 | **采纳（作为 B+ 的核心）** |
| **C. `speech_intervals` 显式标注时间基** | ✅ 方向正确（解决新旧混用），但**单独用不够**——它只标了「是什么」，没解决「怎么换算」 | **采纳（作为 B+ 的配套）** |

**B+ = C 的显式标注 + B 的读取端换算 + 历史数据的显式隔离。**

### 3.2 为什么 B+ 是唯一正确的层次

1. **`computeMetrics` 是两条轴唯一的交汇点**（`metrics.ts:94-99`、`:142-153`），修正必须发生在这里，因为它同时知道窗口（墙钟）和区间（音频轴）。
2. **写入端无法自证时间基**：`insertSpeechInterval` 的调用方（`orchestrator.ts:481/546/599`）拿到的 `iv` 来自 `detectSpeechIntervals([p])`，而 `p.startMs` 是音频轴。**写入端要换算，必须知道「音频轴 → 墙钟」的映射函数——而这个映射恰恰就是待修的漂移本身**（`nextStartMs` 与实际墙钟的比值）。**用被污染的输入去修正它自己，是不可能的。**
3. **读取端可以「标定」**：`computeMetrics` 收到的是「区间集合」+「窗口」，可以用**区间总跨度与窗口的比值**做归一化，或（更保守）**直接不用音频轴**。

### 3.3 具体改动点（B+ 三件套）

#### 改动 1：`speech_intervals` 增加时间基列（迁移）

`src/main/storage/migrations.ts:93-99` 现状：
```sql
CREATE TABLE IF NOT EXISTS speech_intervals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
```

**建议新增一个 migration（v?，按现有文件里最后一个版本号 +1）**：
```sql
ALTER TABLE speech_intervals ADD COLUMN timebase TEXT NOT NULL DEFAULT 'audio';
```
- **`DEFAULT 'audio'` 是历史数据的正确标注**（既有 8968 条全是音频轴）。
- 新写入的行显式写 `'wall'`（若走 §3.3 改动 2）或保持 `'audio'` 但在读取端标定。
- ⚠️ SQLite 的 `ALTER TABLE ... ADD COLUMN` 支持 `NOT NULL DEFAULT`，**不需要重建表**。

#### 改动 2：写入端**分流**（关键）

在 `orchestrator.ts:479-481` / `:544-546` / `:597-599` 三处，**不要**去算墙钟，而是**改用 packet 发出时的墙钟快照**——这需要给 `AudioPacket` 加一个字段。

**当前 `AudioPacket`（`pcm.ts:3-9`）：**
```ts
export interface AudioPacket {
  pcm: ArrayBuffer;
  startMs: number;      // session-relative ms of packet start —— 注释没说是哪条轴
  durationMs: number;
}
```

**建议（改动 2a）**：在 `orchestrator.ts` 的 `drainPendingPackets()`（`:574-579`）**发送那一刻**记录墙钟：

```ts
    while (this.pendingPackets.length && this.pendingPackets[0].startMs < sendUntil) {
      const p = this.pendingPackets.shift()!;
      void this.sendPacket(p).catch(...);
    }
```

`drainPendingPackets` 已经有 `const sendUntil = this.nowMs() - 500;`（`:573`）——**这里就是墙钟**。可以在发送时把 `nowMs()` 记进一个并行结构。

> **理由**：`pendingPackets` 的排水是**按墙钟节奏**的（`:572-574` 的注释写着 `real-time pace: send packets older than now-500ms`）。所以「包被发出的时刻」是真实墙钟，也是唯一可信的锚。**这与 `handleFinal` 用服务端相对时间的道理一致。**

**但这不是必须的**。更简单、风险更低的做法是 **改动 2b**：

#### 改动 2b（推荐，最小改动）：**写入端不动，读取端标定**

`metrics.ts` 里把音频轴区间**按比例映射到墙钟窗口**：

```ts
export function computeMetrics(
  segments: TranscriptSegment[],
  speechIntervals: Array<{ startMs: number; endMs: number; timebase?: "wall" | "audio" }>,
  windowStartMs: number,
  windowEndMs: number,
): WindowMetrics {
```

**标定逻辑**（仅对 `timebase === "audio"` 的区间生效）：

```
音频轴总跨度 = max(endMs) - min(startMs)
墙钟总跨度 = windowEndMs - windowStartMs
k = 墙钟总跨度 / 音频轴总跨度        // 比如 5970a6d6 是 325615/551000 = 0.591
映射：(iv, ) => ({ startMs: windowStart + (iv.startMs - audioMin) * k, ... })
```

**优点**：不动写入端、不动 DB、不动 `orchestrator`，改动集中在 `metrics.ts` 一个函数内。
**缺点（必须承认）**：`k` 是**用整个会话的比值**做的**线性假设**。真实漂移是「同一份音频被送两遍」造成的**成段双份**，不是全局均匀缩放——所以标定后仍有残留误差。**这是估计值，不能宣称精确。**
**且**：`windowStartMs`/`windowEndMs` 可能不等于整个会话（实时分析窗口是 60s 而会话是 300s），此时用「窗口跨度」当分母会让 `k` 失真。

> **⚠️ 因此改动 2b 有一个必须解决的边界**：`computeMetrics` 在实时链路里收到的是**子窗口**（`orchestrator.ts:748` 的 `querySpeechIntervals(sessionId, startMs, endMs)`），但在报告链路里收到的是**全会话**（`reportBuilder.ts:45` 的 `querySpeechIntervals(sessionId, 0, Number.MAX_SAFE_INTEGER)`）。**两条链路的 `k` 会不一样，同一场会话在实时窗口和报告里会给出不同的语速。** 这是**不可接受**的。

**⇒ 结论：标定必须基于「整个会话的锚」，而不是当前窗口。** 所以 B+ 最终形态是：

#### 改动 2c（最终推荐）：会话级标定因子，在会话开始时算一次并落库

1. `sessions` 表加一列 `audio_clock_ratio REAL`（迁移）。
2. 会话结束时（`orchestrator.ts:423` `stop()` 里，`flushAudio()` 之后）计算：
   `ratio = (音频轴最大 end_ms) / (会话墙钟跨度)`，存入该列。
3. `computeMetrics` 增加一个可选参数 `audioClockRatio?: number`：
   - 缺省（undefined / 1.0）→ 行为**与今天完全一致**（保证既有测试不变红）。
   - 传入时 → 把音频轴区间**先乘 `1/ratio` 再裁剪**。

**这个设计的三个好处**：
- **实时链路与报告链路用同一个 `ratio`**（报告时从 `sessions` 读，实时时从内存读），`k` 一致；
- **缺省参数保证既有测试零影响**（§4 的变红清单因此大幅缩短）；
- **历史数据自动兼容**：老的 10 场会话 `audio_clock_ratio` 为 `NULL`，按今天的（失真）行为处理，**且可以在报告里显式标注「本场语速未标定」**——不假装修好了。

### 3.4 历史数据怎么处理（任务书特别要求）

**结论：不迁移、不重算、显式标注为「未标定」。**

理由：
1. **无法重算**：要换算音频轴 → 墙钟，需要当初的漂移函数；而漂移是「同一份音频被送两遍」的产物，**送了几份、哪几段是双份，没有任何记录**。`audio-clock-anomaly.md:70` 的定量闭合是靠探针自己的 chunk 计数文件（`evidence/persist10-*.json`）才做到的，**产品链路没有这个记录**。
2. **重算会造假**：用「整场比值」去缩放，会得到看起来合理但实际是猜的数字——正是 `known-limitations.md:6` 纪律所禁止的。
3. **正确做法**：报告里对 `audio_clock_ratio IS NULL` 的会话，在「有效讲话/语速/最长静音」三行**显式标注「本场未标定，数值可能失真」**（HTML 与 JSON 都要标）。

> ⚠️ **对「25 场」的更正要写进文档**：实际只有 **10 场**有 `speech_intervals`，且其中 **8 场比值 < 1**。`known-limitations.md:130` 与 `metrics-timebase.md:63-65` 的四个场景是**构造输入**，真实分布与构造假设不同。

### 3.5 顺带必须修的既有缺陷：`resume()` 污染音频轴

`orchestrator.ts:410`：
```ts
    this.slicer.reset(this.nowMs());     // ← nextStartMs 被设为墙钟值
```

**这使得 `resume()` 之后的 `speech_intervals` 混进了墙钟量**（例如 120000ms 起步），而暂停前的是从 0 起步的音频轴。**同一条会话里两种量纲。**

**建议**：改为 `this.slicer.reset(0)` 之外的方案都不理想（复位到 0 会和暂停前的区间重叠）。**最小正确修法**：让 `reset()` 接受「音频轴续点」，即暂停时记录 `slicer.nextStartMs`，恢复时 `reset(暂停时的 nextStartMs)`。这样音频轴在整场会话内**单调连续**，`ratio` 标定才有意义。

> ⚠️ **此项我未实测 `reset(this.nowMs())` 的实际后果**（需要有暂停+恢复的真实会话）。**标注为「不确定，需实测」。** 但代码上 `reset(startMs)` 确实把 `nextStartMs` 设成了传入值（`pcm.ts:94-97`），这一点是确定的。

---

## 4. 既有测试变红清单（逐个列出）

### 4.1 如果采用 §3.3 改动 2c（`audioClockRatio` 可选参数，缺省行为不变）

**预计：零个既有测试变红。** 因为缺省 `undefined` 时行为与今天逐字节一致。

**要新增的测试**（`tests/metrics-timebase.test.ts` 内追加 describe）：
| 用例 | 断言 |
|---|---|
| `audioClockRatio 缺省时行为与今天一致` | 直接复用 `:96-117` 场景 A 的输入，断言不变 |
| `audioClockRatio = 1.692 时 speechMs 被拉回` | 构造区间 `[8450,92950]`，ratio=1.692 → 标定后 `[4994,54935]` |
| `ratio 为 0 或负数时按 1 处理（不产生 NaN/Infinity）` | 边界 |
| `ratio 为 null（历史会话）时标注未标定` | |

### 4.2 如果采用 §3.1 的「直接统一换算」（即改 `computeMetrics` 语义，不引入可选参数）

**以下测试会变红**（逐个列出，均已读到）：

| # | 文件 | 行号 | 用例名 | 为什么会红 |
|---|---|---|---|---|
| 1 | `tests/metrics-timebase.test.ts` | `:96` | 场景 A：讲话集中在中段 —— speechMs 反而下降（被窗口裁掉） | 该用例**故意断言失真后的值** `toBe(25350)`（`:109`）。修好后不再是 25350 → **红** |
| 2 | `tests/metrics-timebase.test.ts` | `:119` | 场景 B：讲话均匀铺满窗口 —— speechMs 上涨但没有 1.69 倍 | 断言 `greaterThan(base.speechMs)`（`:128`），修好后应相等 → **红** |
| 3 | `tests/metrics-timebase.test.ts` | `:134` | 场景 C（最危险）：讲话在窗口尾部 —— 全部被裁，语速报 0 | 断言 `toBe(0)`（`:144`）、`longestSilenceMs toBe(60000)`（`:147`）→ **红** |
| 4 | `tests/metrics-timebase.test.ts` | `:150` | 场景 D（隔离裁剪）：窗口也随音频轴放大时，speechMs 才正好是 1.69 倍 | 断言 `ratio toBeCloseTo(RATIO, 6)`（`:161`）→ **红** |
| 5 | `tests/metrics-timebase.test.ts` | `:53/:61/:70/:78` | 四个「安全字段不变」用例 | **预计不变红**（这些字段本来就安全） |
| 6 | `tests/metrics-timebase.test.ts` | `:166/:173` | 契约回归两个用例 | **预计不变红**（`:179-181` 是 ratio=1 的对比） |
| 7 | `tests/analysis-link-verify.test.ts` | `:129` | C2 区间裁剪、乱序重叠去重，最长静音不会NaN | 输入 `[30000,70000]` + `[-1000,40000]`、窗口 `[0,60000]`。若换算语义改变 → **可能红** |
| 8 | `tests/analysis-link-verify.test.ts` | `:122` | C1 40汉字+6英文词 / 2分钟讲话与3分钟总时长 | 区间 `[0,120000]`、窗口 `[0,180000]`。**预计不变红**（无漂移时换算=恒等） |
| 9 | `tests/analysis-link-verify.test.ts` | `:133` | C3 真实PCM数据流入orchestrator，讲话分母来自VAD而非ASR跨度 | ⚠️ **重点**：`:139` 断言 `ivs[0].startMs === 0`、`endMs === 200`。**若改写入端（方案 A）此用例必红**；若只改读取端则不变红 |
| 10 | `tests/analysis-link-verify.test.ts` | `:142` | C4 VAD无讲话时speechMs=0而silenceMs=总时长 | `computeMetrics([], [], 0, 60000)`，空区间 → **预计不变红** |
| 11 | `tests/report-speech-timing.test.ts` | `:9` | 返回camelCase时段，双语分子除以讲话/全时段两个不同分母 | 断言 `speechMs toBe(60000)`（`:25`）、`charsPerSpeechMinute toBe(6)`（`:29`）。区间 `[0,60000]`、窗口 `[0,120000]`（由 `:47-51` 的 max 推出 120000）。**无漂移时换算=恒等 → 预计不变红**，但**若比值算法用「窗口/区间跨度」而窗口是 120000、区间是 60000，k=2 → 会把 speechMs 算成 120000 → 必红**。⚠️ **这正是 §3.3 改动 2b 的坑，见下** |
| 12 | `tests/analysis.test.ts` | `:31` | （断言 `silenceMs toBe(48000)`） | 若换算语义改变 → **需实现者确认**（我只读到 `:31` 一行，**未读全该文件**，「不确定」） |

**⚠️ 第 11 条是最重要的警告**：`report-speech-timing.test.ts` 的输入里，**区间是 `[0,60000]` 而窗口是 `[0,120000]`**（因为 `endMs` 取 `segments`/`intervals` 的最大值，而片段 `t1` 是 `0..120000`）。**如果用「窗口跨度 / 区间跨度」做标定因子，k = 120000/60000 = 2，会把正常的 60000 放大成 120000，这个测试立刻变红——而且这是真实缺陷，不是测试太严。** 这说明**任何基于「跨度比」的在线标定都是错的**，必须用 §3.3 改动 2c 的**会话级显式 ratio**。

### 4.3 如果采用方案 A（改写入端）

| 文件 | 行号 | 用例名 | 结果 |
|---|---|---|---|
| `tests/analysis-link-verify.test.ts` | `:133` | C3 真实PCM数据流入orchestrator | **✅ 必红**（`:139` 断言 `ivs[0].startMs === 0`，加了锚点后变成锚点值） |
| 其余 | | | 若锚点在测试里恒为 0 则不变红，**但取决于 mock 的 `nowMs()`**，「不确定」 |

### 4.4 处理原则（改断言 vs 不该改）

- **`tests/metrics-timebase.test.ts:96-162` 的四个场景：不该删，应该「转换语义」。**
  它们现在钉的是「**失真长什么样**」（文档 `metrics-timebase.md` 的实测依据）。修好之后，正确的做法是：
  1. **保留**这些用例但**重命名 + 改断言**为「修复后不再失真」（即期望值变成未失真的值）；
  2. **同时保留一份「未修复行为」的用例**，把 `audioClockRatio` 显式传 `1.0`（或 `undefined`），断言仍然是 25350 / 0 / 60000 —— **这样文档里的四个实测场景仍然可复现**，`metrics-timebase.md` 不用重写。
  > 这正是「不该改断言」的那一面：**这四个数字是文档的实测支撑，删了就失去证据**。用参数把它们保留在「ratio=1 路径」上，是唯一不丢证据的改法。
- **`tests/analysis-link-verify.test.ts:139` 的 `startMs === 0`：不该改。**
  它钉的是「VAD 区间从会话起点算」，是正确契约。**若方案 A 让它变红，说明方案 A 错了**，而不是测试错了。

---

## 5. `paceThreshold` / `silenceThresholdMs` 是否顺手接通

### 5.1 现状核实（实测 grep 全树）

`contracts.ts:425-426`：
```ts
  paceThreshold?: number;
  silenceThresholdMs?: number;
```

`schemas.ts:106-107`：
```ts
  paceThreshold: z.number().optional(),
  silenceThresholdMs: z.number().optional(),
```

**全树 grep 结果**：`src/` 下只有这 **2 个文件 4 处**（定义处）。此外只在文档里出现：
- `docs/known-limitations.md:109`（「有 schema 无 UI 入口」）
- `docs/desktop-verification.md:99`、`:241`
- `docs/主要工作说明.md:373`

**确认：`src/` 全树无任何读取点。是死字段。**

### 5.2 建议：**不接通。分开做，且优先级低于时间基修复。**

理由（逐条）：

1. **与本任务无因果**：这两个字段影响的是「**判定**」（语速变化超过多少算突变、静音超过多少算异常），而时间基修复影响的是「**测量**」。**测量不准时调判定阈值是没意义的**——把阈值从 0.5 调到 0.3，只是让失真的数字触发得更频繁。
   - 佐证：`metrics.ts:135` 的 `Math.abs(delta) >= 0.5` 是硬编码的语速突变阈值；`metrics.ts:105` 的 `< 200` 是区间合并阈值。**这两个才是 `paceThreshold`/`silenceThresholdMs` 语义上该接管的地方**，但它们作用在**已经算出来的字段**上。

2. **接通会引入新的失真面**：`paceChanges` 用的是 `transcript_segments.startMs`（`metrics.ts:125`），**是墙钟锚、安全的**。一旦让用户可配阈值，用户会以为调的是「可靠的语速」，而实际报告里另有三行（`speechMs`/`charsPerSpeechMinute`/`longestSilenceMs`）仍是失真的。**这会让「哪些数字可信」的边界变模糊**——而 `metrics-timebase.md §4` 整节都在强调这个边界。

3. **接通需要 UI + 校验 + 测试，是一个独立任务**：`FrameworkPage` 的表单（`src/renderer/pages/FrameworkPage.tsx`）是一套，`app_settings` 是另一套——需要先决定这两个字段属于**框架级**还是**设置级**。看 `contracts.ts:425-426` 的位置（在 `Framework` 附近还是 `Settings` 附近）才能定，**我未读到其所属 interface 的声明行**，标注「不确定」。

4. **接通顺序建议**：
   - 第一步：修时间基（本方案）。
   - 第二步：在 `metrics-timebase.md §4` 的边界**收紧之后**（即失真字段被修好或被显式标注），再接通阈值。
   - 第三步：**或者**——直接把这两个死字段**从 schema 删除**，作为「减少未实现承诺」的清理项。这也是合理选项：留着一个永远不生效的配置项，比删掉更糟（用户以为配了就有用）。

### 5.3 若一定要在本任务里接通，最小正确做法

- 只接 `paceThreshold` → `metrics.ts:135` 的 `0.5`；
- 只接 `silenceThresholdMs` → 需要先定义「多长的间隙算静默」，即 `metrics.ts:105` 的 `200`（区间合并）**不是**这个语义——`silenceThresholdMs` 更可能指「报告里算作『异常静默』的最短时长」，那属于 `reportBuilder` 的判定层，**我未找到对应代码，标注「不确定」**。
- **结论：语义未定，不建议在本次顺手接通。**

---

## 6. 实施顺序（给实现者）

1. **先落「显式时间基」**：加 migration（`speech_intervals.timebase DEFAULT 'audio'`）。
2. **再加会话级 `ratio`**：`sessions.audio_clock_ratio`，`stop()` 时计算落库。
3. **改 `computeMetrics` 签名**：加**可选** `audioClockRatio?: number`，缺省 = 今天行为。跑全量 → 必须 **378/378**。
4. **在 `orchestrator.ts:748` 与 `reportBuilder.ts:52` 两个调用点传入 ratio**。
5. **加新测试**（§4.1 的四条）。
6. **报告侧标注**：`audio_clock_ratio IS NULL` 的历史会话，在三行指标旁标「未标定」。
7. **最后**修 `resume()` 的 `slicer.reset`（§3.5）——**需要先实测确认影响**。
8. **更新文档**：`metrics-timebase.md` 与 `known-limitations.md §3b.1` 需写明「已标定 / 未标定」两态，并**更正「25 场」为「10 场」**。

---

## 7. 不确定项汇总（缺什么证据）

| # | 事项 | 缺的证据 |
|---|---|---|
| 1 | `resume()` 后 `slicer.reset(nowMs())` 的实际后果 | 需要一次「暂停 → 恢复」的真实会话，看 `speech_intervals` 是否出现墙钟量级的跳变 |
| 2 | `tests/analysis.test.ts:31` 的完整上下文 | 我只读到该行断言 `silenceMs toBe(48000)`，未读全文件，无法判断改动是否影响 |
| 3 | `tests/report.test.ts` 对 `bySeverity` 的断言 | 未逐字读（本方案 §2.3 涉及 severity 时会用到） |
| 4 | `paceThreshold`/`silenceThresholdMs` 所属 interface | 未读到 `contracts.ts:425-426` 所在 interface 的声明行 |
| 5 | 真实会话的漂移**分布**（不只是整场比值） | 需要逐区间的时间戳 + 当时的墙钟快照；当前只有整场比值 |
| 6 | `drainPendingPackets` 排水节奏与真实发包时刻的偏差 | `:573` 的 `sendUntil = nowMs() - 500` 意味着包延迟最多 500ms+ 才发；**未实测实际延迟分布** |
