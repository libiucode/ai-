# 指标时间基契约（metrics timebase contract）

- 时间：2026-10-15 09:5x
- 范围：`src/main/analysis/metrics.ts` 的 `WindowMetrics`
- 起因：`docs/audio-clock-anomaly.md` 定案的「音频轴快于墙钟」异常，
  需要回答「哪些指标会失真、失真成什么样」
- 状态：**本文档的失真方向由构造输入实测得出，不是推理**（见 §3）

---

## 1. 两条时间轴

| 轴 | 来源 | 谁写它 | 异常时会漂 |
|---|---|---|---|
| **墙钟** | `Date.now() - sessionStartEpoch` | `orchestrator.nowMs()` | ❌ 不会 |
| **音频轴** | `PcmResamplerSlicer.nextStartMs`，**本地按样本数累加** | `src/main/capture/pcm.ts` | ✅ 会 |

墙钟锚在真实时刻，永远可信（除非系统时钟被改）。

音频轴是「我送了多少样本」推出来的时刻，**它假设每份音频只被送一遍**。
同一份音频被送两遍时，累加出的时长翻倍——实测 1.27 / 1.69 倍
（`docs/audio-clock-anomaly.md` §1，两个异常会话）。

**第三条时间轴（不要混淆）**：`transcript_segments` 的时间戳来自
`asrAudioStartMs + p.startMs`，`asrAudioStartMs` 锚在墙钟，
服务端相对时间不受本地切片器影响。所以它属于**墙钟锚**，不是音频轴。

---

## 2. 逐字段契约

| 字段 | 时间基 | 漂移时 | 判定 |
|---|---|---|---|
| `totalMs` | 墙钟（`windowEndMs - windowStartMs`） | 不变 | ✅ 安全 |
| `chineseChars` / `englishWords` | 无时间基（纯计数） | 不变 | ✅ 安全 |
| `speechMs` | **音频轴** | 失真 | ⚠️ 失真 |
| `silenceMs` | 音频轴（`totalMs - speechMs`） | 失真，**与 speechMs 反向** | ⚠️ 失真 |
| `charsPerSpeechMinute` | 字数 / 音频轴分母 | 失真 | ⚠️ 失真 |
| `charsPerTotalMinute` | 字数 / **墙钟**分母 | 不变 | ✅ 安全 |
| `longestSilenceMs` | **音频轴** | 失真 | ⚠️ 失真 |
| `paceChanges` | **墙钟锚**（`transcript_segments.startMs`） | 不变 | ✅ 安全 |
| `maxRepeatSimilarity` / `repeatCandidate` | 无时间基 | 不变 | ✅ 安全 |

> **同一个函数里两种时间基混用**，这是本模块的结构性特征，不是偶然。
> 混用点有两处，都在 `computeMetrics` 里，源码已就地标注：
> 1. 窗口裁剪（`:94-97`）——音频轴区间被墙钟窗口截断
> 2. 静默间隙（`:142-149`）——音频轴游标夹在墙钟首尾之间

---

## 3. 失真方向：**不是简单乘一个系数**（实测）

⚠️ **这一节修正一个直觉错误。**

直觉会说「音频轴快 1.69 倍 → `speechMs` 也涨 1.69 倍」。**实测不成立**，
因为窗口是墙钟、区间是音频轴，**越界的讲话会被整段裁掉**。

构造输入：60 秒墙钟窗口，1.69 倍音频轴漂移，逐字段对比：

| 场景 | `speechMs` | `charsPerSpeechMinute` | `charsPerTotalMinute` | `longestSilenceMs` |
|---|---|---|---|---|
| A：讲话集中在中段，两段各 15s | 30000 → **25350（0.845×）** | 120 → 142 | 60 → **60（不变）** | 20000 → 26200 |
| B：讲话均匀铺满窗口 | 30000 → 33800（1.127×） | 120 → 106.5 | 60 → **60（不变）** | 5000 → 8450 |
| C：讲话只在窗口尾部 | 10000 → **0** | 60 → **0** | 60 → 60 | 45000 → **60000** |
| D：窗口也随音频轴放大（纯缩放，隔离裁剪） | 30000 → 50700（**1.690×**） | 120 → 71.0 | 60 → 35.5 | 20000 → 33800 |

**三条实测结论**：

1. **只有当窗口也跟着音频轴放大时（场景 D），`speechMs` 才正好是 1.69 倍。**
   真实场景窗口是墙钟，所以**不会出现简单倍数**。
2. **`speechMs` 可能涨也可能跌**（A 跌到 0.845、B 涨到 1.127），
   取决于讲话分布：靠尾部越多，被裁掉的越多。
3. **最危险的形态是场景 C**：讲话全被推出窗口 → `speechMs = 0`、
   `charsPerSpeechMinute = 0`、`longestSilenceMs` 直接等于整个窗口。
   **「语速 0」和「整场全是静默」这两个看起来像事实的结论，可能只是漂移的产物。**

> 场景 D 只在「一切都用音频轴」的自洽假想下出现，真实链路不是这样。
> 保留它是为了说明：**1.69 这个倍数是纯缩放场景的量，不能直接套到真实窗口上。**

---

## 4. 对外呈现的纪律

**⛔ 不要把以下字段当成精确值呈现给用户或写进结论**：

- `speechMs` / `silenceMs`
- `charsPerSpeechMinute`
- `longestSilenceMs`

**✅ 可以放心当精确值用**：

- `totalMs`
- `charsPerTotalMinute`（分母是墙钟）
- `chineseChars` / `englishWords`
- `paceChanges`
- `maxRepeatSimilarity` / `repeatCandidate`

**具体影响**（对应 `docs/audio-clock-anomaly.md` §6）：

- 报告里的「有效讲话」「静默」「语速（按讲话）」「最长静音」四行
  **在漂移会话上是失真的**。话术分析若要加提示，按本文档判定，
  不要按「一定涨 1.69 倍」写。
- 用量核算**不能拿音频时间轴当计费基准**（计费是 ASR 连接时长），
  `scripts/usage-reconcile.cjs` 已改为「墙钟为上界、音频为下界」的区间估计。

---

## 5. 未实测 / 边界

- 本文档所有失真数字**来自构造输入**，不是真实会话回放。
  真实会话的讲话分布未知，实际失真幅度取决于分布。
- 「普通按钮路径比值 ≈ 1.0」仍**只有 6 个正常会话的旁证**，
  正面验证需要一次 60~90 秒真实采集（见 `docs/audio-clock-anomaly.md` §7），
  **待额度**。
- 已知受影响范围仅限两个探针驱动的会话（`5970a6d6` / `d61e4b32`），
  均由双管线探针造成，**不是产品链路缺陷**。
