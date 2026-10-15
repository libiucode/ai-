# 音频链路实测报告：Windows 系统声采集（采集侧）

> 本文档只写**采集侧**（系统播放声 → PCM 16k → 200ms 分包 → 有界队列 → 送达 ASR 适配器）。
> ASR 服务侧（签名算法、转写质量、端到端延迟、断线重连）由「实时转写」负责，见
> `docs/asr-link-verification.md`，两边不重复、不互相顶替。

- 负责人：音频采集
- 日期：2026-10-14（21:00–23:10 实测）
- 工程：`$PSScriptRoot\..`
- 平台：Windows 10 / Electron 33.4.11 / Chrome 130.0.6723.191
- **macOS 相关一律标注「未实测」，本周只验 Windows**
- 改动范围：只动 `src/main/capture/`、`src/renderer/capture/`；未碰 `analysis/`、`asr/`、`report/`、`storage/`

---

## 0. 结论速览

| 项 | 结论 | 位置 |
|---|---|---|
| A 麦克风采集（10 分钟） | **未实测**（优先跑系统声；本 agent 无法自行发声，来源需注明） | §6 |
| B Windows 系统声 loopback 采集 | **通过** | §1 |
| C PCM 重采样与 200ms 分包 | **通过** | §4 |
| D 有界队列 | **通过**（并修了 2 个边界缺陷） | §5 |
| E 无声检测 | **通过** | §7 |
| 第①级：已知测试音 → 非空稳态字幕 | **通过** | §8 |
| 第②级：抖音直播真实系统声 | **未实测**（缺浏览器播放源，需用户出手） | §9 |
| 第③级：10 分钟稳定性 | loopback 侧**通过**（58 条字幕 / 578 秒 / 单连接无重连）；麦克风侧未实测 | §10 |

---

## 1. B 项：Windows 系统声 loopback —— 通过

### 1.1 链路

```
app「监听系统声音」按钮（userGesture）
  → getDisplayMedia({ video:true, audio:{...} })
  → main 的 setDisplayMediaRequestHandler
  → desktopCapturer.getSources({ types:["screen"] }) + audio:'loopback'
  → 渲染进程 ScriptProcessor(4096) + 静音 Gain(gain=0，绝不回放)
  → window.appApi.sendAudioChunk(Float32Array, 48000)
  → main: orchestrator.ingestAudio → 重采样 → 分包 → 队列 → ASR
```

`getDisplayMedia` 实测返回原文：

```json
{"steps":["getDisplayMedia","resolved"],
 "videoTracks":1,"audioTracks":1,
 "audioLabel":"System audio",
 "ctxState":"running","ctxSampleRate":48000,"ok":true}
```

拿到 1 条音频轨、label `System audio`、AudioContext 48000Hz `running`。

### 1.2 音频帧特征（321 chunk，48kHz @4096 帧）

| 指标 | 值 |
|---|---|
| chunk 数 | 321 |
| wallMs | 27310 |
| chunksPerSec | 11.75（= 48000/4096，节拍正确） |
| nonzeroChunks | 321 |
| allZeroMeanChunks | **0** |
| fullyZeroChunks | **0** |
| meanOfMeans | 0.0114 |
| maxMean / maxPeak | 0.0126 / 0.0309 |
| minPeak | 0.0000305 |
| totalNan | **0** |
| totalClip | **0** |
| sampleRates | [48000] |
| errors | []（track 未 ended，无设备失效） |

**全程非零、无 NaN、无削波**，不是「±1 LSB 设备活着但无信号」的假非零。

### 1.3 未静默改系统路由

本次验收**没有修改任何默认系统音频路由**。

---

## 2. 用户手势门槛（最易误判，必读）

`main` 的 `setDisplayMediaRequestHandler` 校验 `request.userGesture`。实测：

| 驱动方式 | 结果 | 原因 |
|---|---|---|
| CDP `Runtime.evaluate` 不带 userGesture | `AbortError: Error starting capture` | handler 收到 `userGesture=false` |
| CDP `Input.dispatchMouseEvent` | 会话未启动 / AbortError | 合成输入，Chromium 不产生 user activation |
| Win32 `mouse_event` / `SendInput` | 点不到按钮；即便点中也不产生 user activation | 注定失败 |
| 键盘 Tab + Enter | 同上 | 同上 |
| **CDP `Runtime.evaluate` 带 `userGesture: true`** | **成功** | 显式授予手势 |

**作用域陷阱**：`userGesture: true` 只对**当次表达式执行期**有效。`button.click()` 回调里触发的 `getDisplayMedia` 是后续微任务，手势已用尽 → 仍被拒。必须在同一次表达式内完成 `getDisplayMedia → ScriptProcessor → sendAudioChunk`。

**关于验收旁路**：验收中使用了默认关闭的 `AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE=1`（仅本地验收实例开启，由盯播负责人管理实例生命周期）。
> **交付态仍要求真实用户手势。** 第②级与打包后正式验收必须用无旁路实例 + 真实用户点击。

---

## 3. 「电平非零」不等于「ASR 能出字」

本次最重要的教训。`orchestrator.ingestAudio()` 第一行：

```ts
if (this.status !== "active" || !this.sessionId) return;
```

不走 app 自己的按钮路径建立会话 → 主进程丢弃所有音频帧 → 出现**「电平完美非零 + 0 条字幕」**的假象。

| 现象 | 真实含义 |
|---|---|
| 电平条跳 / 探针收到非零 chunk | 只证明**渲染层**收到帧 |
| UI 黄色「⚠ 已连续 5 秒没有检测到输入声音」 | 会话已建、采集源无声（**不是** handler 失败） |
| UI 红色 `captureError` callout | 采集启动失败（**不是**「只是没声音」） |
| `slice_type=2` 但 `voice_text_str` 空 | 连接通、帧在走，但无识别内容（**不算通**） |
| 纯正弦波下 0 条字幕 | ASR 对纯音无内容可识别，**属预期** |

反证：同一套链路，440Hz+1000Hz 正弦波 → `finalCount=0`（电平 mean 0.0210~0.0213 完全正常）；换成中文 TTS 语音 → 立刻出字。

---

## 4. C 项：PCM 重采样与 200ms 分包 —— 通过

### 4.1 单元测试

`tests/pcm.test.ts` **12/12 通过**（含新增 6 条队列边界）。全量 15 文件 126 测试，capture 相关全绿；analysis/prompt 域 4 条红灯与 capture 无关，非我引入。

### 4.2 独立脚本实测（绕过 vitest，直接跑编译产物）

| 场景 | 预期时长 | 实际覆盖 | 漂移 | 丢失率 | 削波 | 全零 |
|---|---|---|---|---|---|---|
| 44.1kHz 模拟 60 秒（4096 块） | 59907ms | 59800ms | **-0.179%** | 0.18% | 0 | 0 |
| 48kHz 模拟 60 秒（4096 块） | 60075ms | 60000ms | **-0.124%** | 0.12% | 0 | 0 |
| 44.1kHz 单次 5 秒大块 | 5000ms | 5000ms | 0 | 0 | 0 | 0 |
| 48kHz 单次 5 秒大块 | 5000ms | 5000ms | 0 | 0 | 0 | 0 |

**无累积漂移**：60 秒漂移 <0.2%，是每块 `floor(input.length / ratio)` 的取整残差，不是发散。48k 残余样本保留正确（修复前每包丢 ~895/3200 ≈ 22%）。

### 4.3 已修复的历史 bug（现由单测锁住）

- 按 `input.length` 迭代而非 `input.length/ratio` → 等于升采样补零，音频时钟快 2.76~3 倍
- 成包后直接 `buffered=0` 丢残余 → 直播场景周期性缺片

---

## 5. D 项：有界队列 —— 通过（并修了 2 个缺陷）

### 5.1 上限与策略

| 队列 | 上限 | 溢出策略 |
|---|---|---|
| `BoundedPacketQueue`（pcm.ts） | 320000 B = 10s = 50 包 | 丢最旧 + `overflowCount++` |
| `orchestrator.pendingPackets` | `10000/PACKET_MS` = 50 包 = 10s | `slice(-50)` 保留最新 + `queueOverflowCount++` |

**丢弃而非阻塞**，符合方案第 7 节第 9 条「音频队列和缓存均设上限」。

### 5.2 本次修的 2 个边界缺陷（`src/main/capture/pcm.ts`）

1. **单包超上限时上限失效**：旧实现先 `shift()` 一包再把这个超大包塞进去 → `totalBytes` 仍远超 `maxBytes`（实测上限 1000B 收 5000B 包后 `totalBytes=5000`）。改为**直接拒绝入队**，返回 `false`，`rejectedCount++`，不破坏上限。
2. **溢出只丢一包就停**：改为 `while` 循环连续丢最旧直到放得下。

新增 `bytes` getter 供断言。

### 5.3 新增边界测试（6 条，已通过）

未满不溢出 / 溢出后占用不越上限 / 超大包拒绝 / 拒绝后不死锁 / `onOverflow` 与 `onReject` 分别触发 / 默认上限=10s=50 包。

---

## 6. A 项：麦克风采集 —— 未实测

**未做 10 分钟长测**。原因：优先跑通系统声（首周硬门槛）；且本 agent 无法自行对着麦克风讲话，若采到的是环境声或现场用户说话必须注明来源，不能声称「自己发声」。

已验证的能力（短测）：`getUserMedia` 可取到 `Default - 麦克风 (Razer USB Sound Card) (1532:0529)`、`麦克风 (Realtek(R) Audio)`、`CABLE Output (VB-Audio Virtual Cable)`，AudioContext 48000Hz `running`。

脚本已就绪：`scripts/probe-mic.ps1`（CDP 驱动真实渲染进程，逐包记录 mean/rms/peak/min/max/zeros/nan/clip，支持 `-UseVB` 复现 VB-CABLE 静音现象、`-Minutes` 控制时长）。

---

## 7. E 项：无声检测 —— 通过

静音状态下 UI 弹出明确提示，实测原文：

```
⚠ 已连续 5 秒没有检测到输入声音。请检查：麦克风是否被静音或音量过低、
系统声音采集是否选错了共享目标（需要勾选"分享音频"）、播放设备是否正常运行。
声音恢复后此提示会自动消失。
```

符合方案第 11 节「断线、无声、分析失败必须显示状态」。UI 另有 chip「队列溢出 N 次」。

---

## 8. 第①级：已知测试音 → 非空稳态字幕 —— 通过

| 判定项 | 要求 | 实测 |
|---|---|---|
| 非空稳态字幕 | `slice_type=2` + `voice_text_str` 非空 | 5 条，text 全非空 |
| 时间戳正确 | `start/end` 单调递增 | 相邻间隔 100~140ms，无回退无重叠 |
| UI 与 SQLite 一致 | `transcript_segments` 有对应行 | UI `finalCount=5` ↔ DB 5 行 |

```
sessionId: 190ba540-c53b-4807-ab6f-56e2e54345c7
audio_source: systemLoopback
started_at_iso: 2026-10-14T14:40:56.567Z
```

| # | start→end | seq | 文本 |
|---|---|---|---|
| 1 | 4980→14700 | 0 | 大家好，欢迎来到直播间。今天给大家带来一款王炸单品，这个真的是我无限回购的一款。 |
| 2 | 14800→26020 | 1 | 家人们，谁懂啊？这个价格我真的会谢。官方旗舰店平时都要300多，今天在我直播间直接给你打下来。 |
| 3 | 26100→35400 | 2 | 这款精华的核心成分是烟酰胺，浓度5%。坚持用7天，你就能看到肤色明显提亮。这个是实测数据。 |
| 4 | 35660→48060 | 3 | 运营帮我把这个优惠券再上1万张，321上链接，宝宝们直接冲手慢舞。… |
| 5 | 48060→60120 | 4 | 这款面霜添加了2裂酵母和依克多因修复屏障的效果非常好。… |

单调性检查：`start_ms/end_ms 不重叠且递增: true`，`非空 text 行数: 5/5`。

**播放源（不是直播，不冒充）**：中文 TTS 语音（实时转写生成，Microsoft Huihui，16kHz/16bit/mono，20 段带货口播），合并为 `D:\asrbench-audio\merged.wav`（265 秒）后 `ffplay` 播放。
**结论只能写为「已知中文测试音 + Windows loopback 的非空稳态字幕已通」，不得写成「直播已通」。**

---

## 9. 第②级：抖音直播真实系统声 —— 未实测

**阻塞原因**：我的浏览器面板未打开。`read_browser` 返回原文：
> Your browser panel is not open. It exists only in the DSH Desktop app: ask the user to click your name at the top of your chat, open the browser from there, and load the page.

需要用户在 DSH Desktop 顶栏点击 Bot 名字打开浏览器面板并加载直播间。目标 URL：`https://live.douyin.com/295178185857`（韩束官方旗舰店）；若未开播则换在播房间并记录原因。

**这是用户侧硬阻塞，不是代码或模型问题。**

---

## 10. 第③级：10 分钟稳定性

**loopback 侧：通过。**

- 实例：CDP 9224（PID 20180，旁路开启，由盯播负责人管理生命周期）
- 播放源：`D:\asrbench-audio\loop10.wav`（795 秒循环，13 分钟）
- sessionId：`ae6d96d7-662d-4d13-aa53-881e9254d6a5`（app 真实分配）
- 音源 `systemLoopback`，采集「采集中」，ASR chip 全程「识别中」无中断

DB 直读结果：

| 指标 | 值 |
|---|---|
| 稳态片段行数 | **58** |
| 时间跨度 | **578.1 s**（4140 → 582200 ms） |
| start/end 不重叠递增 | **true** |
| source_seq 递增 | **true**（0 → 57） |
| 空文本行 | **0** |
| 涉及连接数 | **1**（`74e12628…`，全程未发生重连） |
| 平均片段间隔 | 9994 ms |

> 采集脚本在 9 分 45 秒时因 CDP `Runtime.evaluate` 单次 15 秒超时而中断（已记录），
> 非链路故障：会话状态与 DB 落库完整，58 条片段覆盖 578 秒音频，全程单连接无重连、无空文本。

**麦克风侧：未实测**（见 §6）。

---

## 11. 设备与路由

渲染进程 `navigator.mediaDevices.enumerateDevices()` 实测 audiooutput：

```
Default - CABLE Input (VB-Audio Virtual Cable)          ← 当前默认输出
Communications - 扬声器 (Razer USB Sound Card) (1532:0529)
CABLE Input (VB-Audio Virtual Cable)
27G1R (NVIDIA High Definition Audio)
扬声器 (Realtek(R) Audio)
CABLE In 16ch (VB-Audio Virtual Cable)
扬声器 (Razer USB Sound Card) (1532:0529)
```

audioinput：`Razer USB Sound Card`、`Realtek(R) Audio`、`CABLE Output (VB-Audio Virtual Cable)`。

**当前默认输出是 CABLE Input**，`ffplay` 直接播放时信号经 VB-CABLE 内部路由（进 CABLE Input、从 CABLE Output 出来被 loopback 采到）。这不改变链路正确性（电平、采样率、时间戳均真实），但**不应描述为「未经虚拟声卡直出扬声器」**，否则在干净机器上复现会产生困惑。

---

## 12. 平台额外依赖

| 平台 | 需要额外装什么 | 说明 |
|---|---|---|
| Windows | **什么都不用装** | loopback 由 Chromium + Electron `desktopCapturer` 内置提供（`audio:'loopback'`）。实测本机无需安装任何虚拟声卡即可采到系统播放声。 |
| macOS | 需 BlackHole 等虚拟声卡，或系统录音权限 | **未实测** |

---

## 13. 复现方式

```powershell
# 采集 + 建会话（端口以负责人给的为准）
& ([scriptblock]::Create([System.IO.File]::ReadAllText(
    "$PWD\scripts\probe-lvl1.ps1", [System.Text.Encoding]::UTF8))) `
    -Port 9224 -Seconds 600 -WavPath "D:\asrbench-audio\loop10.wav"

# 字幕与时间戳证据
& ([scriptblock]::Create([System.IO.File]::ReadAllText(
    "$PWD\scripts\probe-lvl1-sub.ps1", [System.Text.Encoding]::UTF8))) -Port 9224

# 重采样器独立实测
node scripts/probe-resampler.cjs

# 有界队列独立实测
node scripts/probe-queue.cjs

# SQLite 一致性（Electron 内置 Node，ABI 130 匹配）
$env:ELECTRON_RUN_AS_NODE="1"
& "$PSScriptRoot\..\node_modules\electron\dist\electron.exe" `
  "$PSScriptRoot\..\scripts\read-db.cjs"
```

### 已废弃、不得再据此出结论的脚本

- `scripts\probe-live-loopback.ps1`：`Runtime.evaluate` 未设 `userGesture`，且只统计 chunk 不调 `sendAudioChunk`
- `scripts\probe-capture.cjs`：同样只有统计、不送数据

### 环境坑

1. PowerShell 读含中文的 `.ps1` 必须 `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)`，默认按 ANSI 解码会把 JS 里的中文变成乱码并破坏语法。
2. Node 子进程连不上由 PowerShell 启动的进程所监听的本地端口（沙箱网络视图不同）；CDP 客户端需用 PowerShell 的 `ClientWebSocket` 实现。
3. ffmpeg `concat` 协议读不了中文路径，需先复制到纯英文路径。

---

## 14. 源码改动清单（限 capture/ 目录）

| 文件 | 改动 |
|---|---|
| `src/main/capture/pcm.ts` | `BoundedPacketQueue`：单包超上限拒绝入队 + `rejectedCount`；溢出改为 while 连续丢最旧；新增 `bytes` getter |
| `src/renderer/capture/audioCapture.ts` | `NotSupportedError` 文案：去掉「不是应用故障」「驱动/策略限制」「换一台机器」等误判，改为列出需要排查的三类原因；注释记录 2026-10-14 实测结论 |
| `tests/pcm.test.ts` | 新增 `BoundedPacketQueue` 边界测试 6 条；import 补齐 |
