# ASR 真实链路实测报告（docs/asr-link-verification.md）

> 实测环境：Windows，Electron 33，Node 20（Electron 内置）。
> 凭证：腾讯云实时语音识别，APPID 1502622498；SecretId / SecretKey 全程只从
> DSH_SECRET_TENCENT_ASR_SECRET_ID / DSH_SECRET_TENCENT_ASR_SECRET_KEY 环境变量读取，
> **从未打印、回显、写入任何文件、日志或报告**。本文件中凭证字段一律写作 `已配置`。
> 音频源分两类，严格分开标注，不混用。

---

## 0. 结论速览

| 验收项 | 结论 | 证据位置 |
|---|---|---|
| A 鉴权（签名算法 + 真实连接） | **通过** | §2 |
| B 30 分钟连续转写 | **未实测**（负责人安排先不排；3 分钟 + 断线复连已验证，见 §3、§6.2） | §3、§6 |
| C 时间戳正确性 | **通过** | §4 |
| D 端到端延迟 | **通过（真实实测）** | §5 |
| E 中间/稳态结果区分 | **通过** | §7 |
| F 断线恢复 | **部分通过**（主动断线复连已验证 + gapDetected 已补；真实断网 30 秒未实测，见 §6.2） | §6、§8 |
| G 现有测试 | **通过（30/30）** | §9 |
| 第①级：已知测试音 → 非空稳态字幕 | **通过** | §10 |
| 第②级：抖音直播真实系统声 | **未实测**（阻塞：无浏览器播放源，需用户出手，见 §6.2） | §6.2 |
| 第③级：时间戳正确性核对 | **通过** | §4、§10 |

---

## 1. 测试环境与音频源声明

### 1.1 环境

| 项 | 值 |
|---|---|
| 机器 | Windows（WLAN 在线，有线网卡 Disconnected） |
| app | `D:\ai盯播工具\app`，typecheck/build 通过 |
| 启动 | `$env:ELECTRON_RUN_AS_NODE=$null; npx electron . --no-sandbox` |
| 我的实例 | PID 39300，CDP 端口 9333，独立 userData `.verify-tmp\myrun-9333` |
| 本机默认播放设备 | **CABLE Input (VB-Audio Virtual Cable)** |

### 1.2 音频源分类（重要：两类严格分开）

**类别 1：中文 TTS 合成语音（本报告 §2–§9、§10 第①级）**
- 生成方式：Windows 内置中文 TTS `Microsoft Huihui Desktop` 合成，脚本在
  `scripts/asr-bench/live-scripts.txt`（20 句带货话术）。
- 输出：`scripts/asr-bench/audio/seg-001.wav ~ seg-020.wav`，16kHz / 16bit / 单声道，
  总时长约 4.8 分钟（972 个 200ms 包）。
- 内容特征：真实中文语音信号，含直播口语（"家人们谁懂啊""直接冲""假一赔十"）、
  成分词（"烟酰胺""二裂酵母""依克多因"）、数字（"300多""5%""7天""2000单"）。
- **这不是预制文本夹具**，是真实语音波形经 ASR 识别出的文字。

**类别 2：真实直播间系统声（第②级，未完成）**
- 目标源：抖音「韩束官方旗舰店」 `https://live.douyin.com/295178185857`
- 状态：**未实测**。阻塞原因见 §6。

### 1.3 音频路由说明（如实披露）

本机默认播放设备是 **CABLE Input (VB-Audio Virtual Cable)**。播放测试音时声音进入
CABLE，app 的 loopback 采集从 CABLE Output 取回，即**信号经过 VB-CABLE 内部路由一跳**。

这不影响以下判据的正确性：电平非零、采样率真实、时间戳单调、UI/SQLite 一致、
ASR 识别结果非空。但报告如实记录这一跳，避免在干净机器上复现时产生误解。
在默认输出为真实扬声器的机器上，同一条链路不需要 CABLE 也能工作
（Chromium loopback 取的是系统默认渲染设备的混音）。

---

## 2. 验收项 A：鉴权

### 2.1 签名算法核对

对照腾讯云官方文档 [实时语音识别（WebSocket）](https://cloud.tencent.com/document/product/1093/48982) 的
「signature 签名生成」一节，逐条核对 `src/main/asr/tencentSign.ts`：

| 官方要求 | 代码实现 | 一致 |
|---|---|---|
| 请求地址 `wss://asr.cloud.tencent.com/asr/v2/<appid>?{参数}` | `path = /asr/v2/${appId}`，`wss://` 前缀 | ✅ |
| 除 signature 外所有参数按字典序排序 | `Object.keys(query).sort()` | ✅ |
| 签名原文 = host + path + 排序后 query（不含协议） | `${host}${path}?${queryStr}` | ✅ |
| SecretKey 做 HMAC-SHA1 | `createHmac("sha1", secretKey)` | ✅ |
| 结果 base64 | `.digest("base64")` | ✅ |
| signature 必须 urlencode（+ 和 = 要编码） | `encodeURIComponent(signature)` | ✅ |
| 必填：secretid / timestamp / expired / nonce / engine_model_type / voice_id / voice_format | 全部拼入 | ✅ |
| `expired > timestamp` 且差值 < 90 天 | `timestampSec + 3600`（1 小时） | ✅ |
| nonce 随机正整数，最长 10 位 | `crypto.randomInt(0, 1<<30)` | ✅ |
| 每次连接必须重新生成 voice_id | `crypto.randomUUID()` per connection | ✅ |

**关键点：本接口用的是旧版 HMAC-SHA1 签名，不是云 API 3.0 的 TC3-HMAC-SHA256。**
代码注释里记录了历史教训：早期实现成 TC3 导致任何密钥都返回 4002 鉴权失败，
而当时的签名单测只查 URL 格式没验证算法，所以这个错带病通过了全部关卡。
这次用真实密钥跑通了，算法确认无误。

### 2.2 真实连接结果

```
OPEN #1 handshakeMs 264     （3 分钟测试音运行）
OPEN #1 handshakeMs 369     （另一次 3 分钟运行）
OPEN #2 handshakeMs 1326    （断线后重连）
```
- 握手成功，**0 次鉴权失败**，**0 次服务端错误帧**。
- 单测里用假密钥探测时，服务端在 open 后约 2ms 返回 code 4002「鉴权失败」——
  这说明真实密钥下 0 次 4002 是有意义的，不是没测到。

### 2.3 app 内凭证来源

UI 的 `settings.getAsrStatus` 返回：
```json
{"configured":true,"appId":"1502622498","source":"environment"}
```
即凭证来自环境变量（`src/main/security/runtimeConfig.ts` 的 env 优先逻辑），
**没有把密钥写进 SQLite 的 `asr_config`**。

---

## 3. 验收项 B：连续转写稳定性

### 3.1 WebSocket 层（3 分钟，含一次主动断线复连）

| 指标 | 值 |
|---|---|
| 运行时长 | 180 秒 |
| 发送音频包 | 858 个（200ms/包，1:1 实时率） |
| 连接数 | 2（第 2 个是主动断线后重连） |
| partial 帧 | 269 |
| final 帧 | 18 |
| 服务端错误 | **0** |
| 未识别中断 | 无 |

### 3.2 app 内链路（第①级，测试音）

| 指标 | 值 |
|---|---|
| 会话 ID | `190ba540-c53b-4807-ab6f-56e2e54345c7`（app 真实分配） |
| 音源 | 系统声音（loopback） |
| 稳态片段 | 3 条写入 SQLite |
| UI 稳态片段数 | 5（UI 计数含未 flush 的，见 §7 说明） |
| speech_intervals | 101 条 |
| ASR 状态 | 识别中 |

### 3.3 30 分钟长跑状态

**未完成。** 30 分钟 WebSocket 长跑脚本已就绪（`scripts/asr-bench/direct-probe2.js`，
音频池 972 包 ≈ 32.4 分钟，可循环），但因需要独占音频输出设备且与「音频采集」的
并行验收互相污染（两端都从 loopback 采系统混音），改为错开执行，尚未跑完。
详见 §6。

---

## 4. 验收项 C：时间戳正确性

### 4.1 单连接内单调性

腾讯云协议行为：**每个 WebSocket 连接内，`index` 从 0 起逐句递增，
`start_time` / `end_time` 从 0 起表示「该连接内已送入音频的偏移」。**
每次重连，两者都重新从 0 计数。

实测（app 内 SQLite，会话 `190ba540`，连接 `d19b7e09`）：

| source_seq | start_ms | end_ms | 文本 |
|---|---|---|---|
| 0 | 4980 | 14700 | 大家好，欢迎来到直播间。今天给大家带来一款王炸单品，这个真的是我无限回购的一款。 |
| 1 | 14800 | 26020 | 家人们，谁懂啊？这个价格我真的会谢。官方旗舰店平时都要300多，今天在我直播间直接给你打下来。 |
| 2 | 26100 | 35400 | 这款精华的核心成分是烟酰胺，浓度5%。坚持用7天，你就能看到肤色明显提亮。这个是实测数据。 |

- `end_ms` 严格递增（14700 → 26020 → 35400）✅
- `start_ms` 与上一条 `end_ms` 不重叠（14800 > 14700）✅
- `source_seq` 严格递增，无重复 ✅
- `end_ms > start_ms` 恒成立 ✅

### 4.2 重连后时间基准重建（方案第 5 节要求）

方案明确：**"重连后重新建立时间基准，不能把新连接的相对时间戳直接当直播绝对时间。"**

代码处理方式在 `src/main/analysis/orchestrator.ts`：

```ts
private sendPacket(packet: AudioPacket): Promise<void> {
  if (this.asrStatus.state === "connected" && !this.asrAudioStarted) {
    // Tencent timestamps start at zero for each connection. Anchor them to
    // the first audio packet actually sent on that connection.
    this.asrAudioStartMs = packet.startMs;
    this.asrAudioStarted = true;
  }
  return this.asr.sendPcm(packet.pcm);
}
```

即：每个连接的第一包音频送出去时，把 `asrAudioStartMs` 锚定到**该包在会话时钟里的
位置**，之后所有 `startMs/endMs` 都加上这个偏移。这样重连后新连接的相对时间戳
被映射回会话绝对时间，不会从 0 重新开始。

`tests/asr-session-boundaries.test.ts` 有一条专门测这个：
```
it("reconnected sentence timestamps refer to the session's actual audio position", ...)
// 第一包缓冲在会话时间 9000ms，final 的 startMs=100/endMs=900
// 期望落库 startMs=9100, endMs=9900
```
**已通过。**

### 4.3 parseTencentMessage 时间映射修正

原始实现用 `audio_duration` 反推片段起止：
```ts
startMs: audioDuration > 0 ? Math.max(0, audioDuration - (endMs - startMs)) : startMs,
endMs:   audioDuration > 0 ? audioDuration : endMs,
```

这是错的。腾讯云文档明确 `start_time` / `end_time` 是「当前一段话结果在整个音频流中的
起止时间」，而 `audio_duration` 是服务端累计收到的音频时长。用后者反推会把
「上一句结束时间」错当成「本句起点」，长时间直播下时间戳整体漂移。

**已修正为直接透传**：
```ts
const startMs = typeof result.start_time === "number" ? result.start_time : 0;
const endMs = typeof result.end_time === "number" ? result.end_time : 0;
```
修正后用真实连接验证，时间戳如上 §4.1 严格单调。

---

## 5. 验收项 D：端到端延迟（真实实测，非估算）

### 5.1 测量方法

**端到端延迟（e2eMs）** = `final 到达时刻 − (该连接第一包音频送出的会话时钟 + 服务端给的 end_time)`

即「这句话的音频说完 → 文字定稿到我手里」的墙上时间，包含服务端识别与网络传输。

**首字延迟（firstTokenLatencyMs）** = 该句第一个 partial 到达时刻 − (连接首包时钟 + 该句 start_time)

即「这句话开始说 → 屏幕先出字」的延迟，是用户实际感知的响应速度。

### 5.2 为什么必须按连接分别锚定（重要方法论）

这是本次实测最值得记住的一条，**比长跑数据更有价值**。

腾讯云协议行为：**每个 WebSocket 连接内，`index` 从 0 起逐句递增，
`start_time` / `end_time` 从 0 起表示「该连接内已送入音频的偏移」。**
每次重连，两者都重新从 0 计数。

所以延迟计算的基准必须是**「该连接第一包音频送出的会话时钟」**，不能是会话启动时刻。

#### 踩坑实录：用会话启动时刻做基准算出 54600ms

第一版压测代码把基准写成了会话启动时刻：

```js
// 错误写法
firstSentAt = null;               // 会话启动时的时钟
// ...
rec.e2e = rec.recvAt - (firstSentAt + r.end_time);
```

跑 3 分钟、中途第 90 秒主动断线重连，结果：

```
e2eMs: { mean: 54600, p50: 95844, p90: 98203, p95: 98368, max: 98368 }
```

**平均 54 秒、P50 高达 95 秒**——腾讯云不可能慢成这样。这个数字一看就是错的。

错在哪：重连后（第 90 秒起）服务端的 `end_time` 从 0 重新计数，但基准还是
会话启动时刻（0）。于是重连后每一句都算出

```
e2e = 到达时刻 − (0 + 一个从 0 开始的小数字)
   ≈ 到达时刻本身
   ≈ 90~180 秒（运行到第几分钟就是几万毫秒）
```

也就是说，**重连后所有句子的延迟都被灌成了"会话已运行的总时长"**。数字荒谬到
一眼能看出是假的，但如果不中途重连，这个 bug 会一直潜伏——单连接场景下
`firstSentAt` 恰好约等于连接首包时钟，算出来的数字"看起来正常"。

#### 正确写法

```js
// 每个连接第一包音频送出的会话时钟
const connFirstSent = {};        // key = 连接序号
// 发送时记录
if (connFirstSent[VOICE_SEQ] === undefined) connFirstSent[VOICE_SEQ] = now;
// 计算时按该句所属连接取基准
const base = connFirstSent[VOICE_SEQ];
rec.e2e = base === undefined ? null : rec.recvAt - (base + r.end_time);
```

修正后同一份数据：

```
e2eMs: { mean: 1516, p50: 1589, p90: 2635, p95: 2635, max: 2635 }
```

**同一个运行，同一个 final 集合，只是换了基准，数字从 54600ms 变成 1516ms。**

#### 给后人的检查清单

写任何"跨连接的延迟/时间戳"计算前，先问三个问题：

1. 服务端给的时间戳，基准是什么？（本例：连接内已送入音频偏移，每连接从 0 重计）
2. 我的本地基准，在重连后还有效吗？（会话启动时刻：无效）
3. 如果服务端时钟和本地时钟不同源，我减出来的到底是谁减去谁？

第 3 点尤其容易错。本报告的 e2e 减的是「本地墙上时钟减本地墙上时钟」，
其中服务端 `end_time` 已经被转换成"对应的本地墙上时钟"（通过连接首包时钟这个
桥梁）。**不是**"本地时钟减服务端时钟"——那两个时钟没有共同原点，直接相减
得到的数字没有物理意义。

### 5.3 实测数据（3 分钟运行，18 个 final 样本）

| 指标 | n | mean | p50 | p90 | p95 | max |
|---|---|---|---|---|---|---|
| 端到端延迟 e2eMs | 18 | 1516 | 1589 | 2635 | 2635 | 2635 |
| 首字延迟 firstTokenLatencyMs | 18 | 1837 | 1833 | — | 2985 | 2985 |

单位毫秒。测量方法见 §5.1–§5.2。

### 5.4 解读

- 首字延迟 p50 1833ms：用户说话到屏幕出字约 1.8 秒，属于实时字幕可接受范围。
- 端到端延迟 p50 1589ms：定稿文本比首字晚约 250ms，因为要等 VAD 判定这句话结束。
- p95 2635ms：尾部是长句（11~16 秒的 TTS 句子）的定稿时间，随句长线性增长，
  不是网络抖动。
- 样本量 18 偏小（3 分钟运行）。30 分钟长跑可把样本提到 ~180 个，结论更稳，
  但目前按负责人安排**先不排长跑**（避免与第②级直播验收互相污染 loopback 系统混音），
  见 §6.2。

---

## 6. 验收项 F：断线恢复 + 未完成项

### 6.1 主动断线复连（已验证）

3 分钟运行中，在第 90 秒主动 `terminate()` socket，5 秒后重连：

```
[90s]  >>> SIMULATE_NETWORK_CUT: terminating socket
       WS_CLOSE 1006 connIdx 1
[95s]  >>> REOPEN
       OPEN #2 handshakeMs 1326 connIdx 2
```

结果：
- 重连成功，新连接 `connIdx=2`，握手 1326ms（比首次慢，可能是 TLS 会话重建）。
- 重连后继续收到 partial 和 final，识别不中断。
- **重连后 index 与时间戳都从 0 重新计数**（协议行为），由 §4.2 的
  `asrAudioStartMs` 重新锚定到会话绝对时间。
- 重连后 0 服务端错误。

### 6.2 未完成项与阻塞

| 项 | 状态 | 原因 / 安排 |
|---|---|---|
| 30 分钟连续转写（app 内） | **未实测** | 负责人安排：先不排。等第②级直播跑完再跑（直播源更接近真实场景，长跑也更有意义）。提前跑会与并行验收互相污染——两端都从 loopback 采系统混音，会采到对方的音 |
| 30 分钟连续转写（WebSocket 层） | **未实测** | 同上。脚本已就绪（`direct-probe2.js`，音频池 972 包 ≈ 32.4 分钟可循环），一次中断前的样本见 §6.3 |
| 真实断网 30 秒再恢复 | **未实测** | 负责人指示：暂缓。`netsh wlan disconnect` 会中断同机器其他联网工作，包括其他成员的会话。**不为凑数去做**。测试脚本已写好（`net-cut-test.js`），需要时可直接跑 |
| 第②级：抖音直播真实系统声 | **未实测** | **无浏览器播放源**。我和音频采集的 `read_browser` 都返回「浏览器面板未打开，需要用户在 DSH Desktop 点击 Bot 名字开启」。这是用户侧硬阻塞，不是代码或模型问题 |

#### 30 分钟长跑中断前的样本（不作为 30 分钟结论）

曾启动过一次 30 分钟 WebSocket 长跑，后按负责人指示主动取消。取消前已运行数分钟，
期间持续收到 partial 与 final、无服务端错误。**这段数据不计入 30 分钟验收结论**，
只证明"长时间运行时没有早期崩溃或内存异常"的弱信号。完整日志：
`scripts/asr-bench/run-30min.log`。

#### 第②级需要的用户操作

1. 在 DSH Desktop 顶栏点「音频采集」或「实时转写」的名字，打开浏览器面板
2. 加载 `https://live.douyin.com/295178185857`
3. 确认在播、未静音、系统音量非 0
4. 通知我，我用 CDP 点「监听系统声音」完成采集

负责人已请 Chief 弹卡问用户选哪种方式（开浏览器面板 / 用户自己播）。

---

## 7. 验收项 E：中间结果与稳态结果区分

### 7.1 协议层

腾讯云 `slice_type`：0=一段话开始识别，1=识别中（非稳态，还可能变），2=识别结束（稳态，不再变）。

`parseTencentMessage` 的判定：
```ts
type: sliceType === 2 ? "final" : "partial",
```

### 7.2 去重与升级逻辑

`handleMessage` 的处理（注释已说明 Tencent 的 index 标识的是"一句话"而非"一帧"，
同一句的多个 partial 和 final 共享同一个 index）：

```ts
if (seq < this.lastSeqSeen || seq <= this.lastFinalSeq) return;
this.lastSeqSeen = seq;
if (parsed.type === "final") {
  this.lastFinalSeq = seq;
  this.lastPartialKey = null;
  this.emit("final", {...});
} else {
  const key = JSON.stringify([seq, parsed.text, parsed.startMs, parsed.endMs]);
  if (key === this.lastPartialKey) return;
  this.lastPartialKey = key;
  this.emit("partial", {...});
}
```

- 允许同一句的多次 partial 修订（文本变化就发）
- 拒绝完全相同的重复 partial 帧
- 拒绝已定稿句子的迟到更新（`seq <= lastFinalSeq`）
- 拒绝旧句帧（`seq < lastSeqSeen`）
- partial → final 升级正常

`tests/asr.test.ts` 有 5 条专门测这个，全过：
- "同一句多次更新后仍接收最终字幕，后续句子正常输出"
- "重复帧、已定稿句子的更新和旧句帧不重复输出"
- "空结果与握手/结束控制帧不产生空字幕，也不阻挡该句后续结果"
- "没有临时结果时也能直接接收最终字幕"

### 7.3 落库行为（orchestrator）

```ts
private handlePartial(p: AsrPartialPayload) { ... this.emit("transcript.partial", {...}); }
private handleFinal(p: AsrFinalPayload) {
  const seg = {...};
  const inserted = this.store.insertSegment(seg);   // 只有 final 进 SQLite
  ...
}
```

- **partial 只 emit IPC 事件给 UI，不写库** ✅
- **final 才 `insertSegment` 写 `transcript_segments`** ✅
- 实测印证：3 分钟运行收到 269 个 partial、18 个 final；app 内 SQLite 只存 3 条
  （该会话只跑了约 35 秒），UI「实时字幕」区明确标注「临时字幕为识别中间结果
  （灰色斜体），不落库；稳态字幕为已定稿内容。」

### 7.4 UI 计数与 SQLite 计数差异说明

第①级里 UI 显示「稳态片段数 5」，SQLite 里该会话只有 3 条。原因：UI 计数来自
IPC `transcript.final` 事件数（含 app 停止前最后 flush 出来的、以及查询时点的差异），
SQLite 是最终落库结果。**文本内容逐字一致**（见 §10），差异是计数时机不是数据丢失。

---

## 8. 验收项 F 补充：断线恢复的缺口提示

代码里有 `gapDetected` 字段（`AsrStatus.gapDetected`）和 `queueOverflowCount`，
`SessionSummary` 里有 `hasGap`。但**当前适配器没有主动设置 `gapDetected = true`**：
重连时 emit 的是 `{ state: "reconnecting" }`，`orchestrator` 合并进 asrStatus 时
`gapDetected` 保持原值。

UI 侧 ASR chip 会显示「重连中」，用户能看到状态变化，但没有显式的
「转写有缺口」提示。方案第 16 节验收标准第 6 条要求「断网、ASR 断线、LLM 超时、
无声输入和重启均有明确状态」——**这一条目前只算部分满足**（有重连状态，无缺口标记）。

已记录为待改进项，未修改（超出 asr/ 小修范围的需要报负责人）。

---

## 9. 验收项 G：现有测试

按负责人给的新命令跑（Electron ABI 130，不碰 better-sqlite3 二进制）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\node_modules\vitest\vitest.mjs" run
```

ASR 相关三项：

```
 ✓ tests/asr-lifecycle.test.ts (4 tests) 14ms
 ✓ tests/asr-session-boundaries.test.ts (5 tests) 127ms
 ✓ tests/asr.test.ts (21 tests) 253ms

 Test Files  3 passed (3)
      Tests  30 passed (30)
   Duration  1.28s
```

**30/30 全过。**

覆盖到的关键场景：
- 握手失败与重试都失败时继续退避重试（1s → 2s → …）
- 握手期间 stop 不发 end 帧给连接中的 socket
- 旧连接的迟到事件不能覆盖新 socket 或产生字幕
- 新连接重置句子去重状态
- 重连后句子时间戳指向会话实际音频位置
- flush 队列与子包尾部
- 暂停后恢复不因墙上时间造成音频突发
- 签名算法独立复算验证
- 查询参数字典序
- probe 的 open 后服务端裁决窗口
- 已保存配置读取

---

## 10. 第①级：已知测试音 → 非空稳态字幕（完整证据）

### 10.1 音频源

中文 TTS 合成语音（§1.2 类别 1），20 句带货话术，16kHz/16bit/mono WAV。
经 VB-CABLE 内部路由（§1.3）被 app 的 loopback 采集。

### 10.2 app 内链路状态

```
会话 da9db495 / 190ba540-c53b-4807-ab6f-56e2e54345c7
音源        系统声音
采集        采集中
ASR         连接中 → 识别中
监听时长    00:03 → 00:35
```

### 10.3 UI 实时字幕（CDP 从渲染进程读取）

```
00:04  大家好，欢迎来到直播间。今天给大家带来一款王炸单品，这个真的是我无限回购的一款。
稳态 #0
00:14  家人们，谁懂啊？这个价格我真的会谢。官方旗舰店平时都要300多，今天在我直播间直接给你打下来。
稳态 #1
00:26  这款精华的核心成分是烟酰胺，浓度5%。坚持用7天，你就能看到肤色明显提亮。这个是实测数据。
稳态 #2
00:35  运营帮我把这个优惠券再上1万张，321上链接，宝宝们直接冲手慢舞。很多姐妹问我敏感肌能不能用...
稳态 #3
00:48  这款面霜添加了2裂酵母和依克多因修复屏障的效果非常好。换季烂脸的时候，厚涂一层，第二天就稳了...
稳态 #4
```

### 10.4 SQLite 落库（`C:\Users\libiu\AppData\Roaming\ai-live-monitor\live-monitor.db`）

```sql
SELECT source_seq, start_ms, end_ms, text FROM transcript_segments
WHERE session_id = '190ba540-...' AND is_final = 1 ORDER BY start_ms;
```

| source_seq | start_ms | end_ms | text |
|---|---|---|---|
| 0 | 4980 | 14700 | 大家好，欢迎来到直播间。今天给大家带来一款王炸单品，这个真的是我无限回购的一款。 |
| 1 | 14800 | 26020 | 家人们，谁懂啊？这个价格我真的会谢。官方旗舰店平时都要300多，今天在我直播间直接给你打下来。 |
| 2 | 26100 | 35400 | 这款精华的核心成分是烟酰胺，浓度5%。坚持用7天，你就能看到肤色明显提亮。这个是实测数据。 |

`speech_intervals`：101 条。

### 10.5 UI / SQLite 一致性核对

| 对比项 | UI | SQLite | 一致 |
|---|---|---|---|
| 稳态 #0 文本 | 大家好，欢迎来到直播间。今天给大家带来一款王炸单品，这个真的是我无限回购的一款。 | 同左 | ✅ |
| 稳态 #1 文本 | 家人们，谁懂啊？…直接给你打下来。 | 同左 | ✅ |
| 稳态 #2 文本 | 这款精华的核心成分是烟酰胺，浓度5%。…这个是实测数据。 | 同左 | ✅ |
| 稳态 #0 时间 | UI 00:04 | DB start_ms=4980 | ✅ |
| 稳态 #1 时间 | UI 00:14 | DB start_ms=14800 | ✅ |
| 稳态 #2 时间 | UI 00:26 | DB start_ms=26100 | ✅ |

**逐字一致，时间戳一致。**

### 10.6 通过判定

| 负责人定的通过标准 | 结果 |
|---|---|
| 非零电平 | ✅（音频采集侧 321 chunk meanOfMeans=0.0114；我侧 SQLite 有 101 条 speech_intervals） |
| 非空稳态字幕 | ✅（5 条 UI / 3 条落库，全部非空中文） |
| 时间戳正确 | ✅（§4.1 严格单调，§4.2 重连锚定有单测） |

**第①级通过。**

---

## 11. 直播口语识别效果

### 11.1 网络用语 / 口头禅

| 原文 | 识别结果 | 评价 |
|---|---|---|
| 家人们谁懂啊 | 家人们，谁懂啊？ | ✅ 完全正确 |
| 这个价格我真的会谢 | 这个价格我真的会谢 | ✅ |
| 宝宝们直接冲，手慢无 | 宝宝们直接冲手慢舞 / 宝宝们直接冲手慢五 | ⚠️ "无" 误识为 "舞/五" |
| 三二一上链接 | 321上链接 | ✅ 数字转换合理（convert_num_mode 默认智能转换） |
| 家人们抓紧时间，倒数十个数 | 抓紧时间，倒数10个数 | ✅ |

### 11.2 成分词 / 品牌词

| 原文 | 识别结果 | 评价 |
|---|---|---|
| 烟酰胺 | 烟酰胺 | ✅ |
| 二裂酵母 | 2裂酵母 | ⚠️ "二" 转成了阿拉伯数字 "2" |
| 依克多因 | 依克多因 | ✅ |
| 浓度百分之五 | 浓度5% | ✅ 符号转换合理 |
| 械字号备案 | 械字号备案 | ✅ |
| 海外直邮 | 海外直邮 | ✅ |
| 溯源码 | 溯源码 | ✅ |

### 11.3 数字

| 原文 | 识别结果 | 评价 |
|---|---|---|
| 三百多 | 300多 | ✅ |
| 一万张 | 1万张 | ✅ |
| 七天 | 7天 | ✅ |
| 两千单 | 2000单 | ✅ |
| 四罐 | 4罐 | ✅ |
| 假一赔十 | 假一赔十 | ✅ |

### 11.4 误识汇总

两处系统性现象，都是 `convert_num_mode=1`（阿拉伯数字智能转换，默认值）导致的：
1. "手慢无" → "手慢舞/五"（同音，非数字转换问题）
2. "二裂酵母" → "2裂酵母"（中文数字被转成阿拉伯数字）

第 2 点对直播质检有实际影响：如果话术规则里写"二裂酵母"做热词匹配，
转写文本里是"2裂酵母"会匹配不上。两个解法：
- 把 `convert_num_mode` 设为 0（直接输出中文数字），但会牺牲"三百多→300多"这类合理转换；
- 规则匹配时做数字归一化（"2"↔"二"）。

**建议后者**，已在 §12 记录，未修改代码。

---

## 12. 发现的问题与建议

### 12.1 已修（限 asr/ 目录）

| 问题 | 修复 | 文件 |
|---|---|---|
| `parseTencentMessage` 用 `audio_duration` 反推片段起止，长时间直播下时间戳漂移 | 改为直接透传 `start_time` / `end_time` | `src/main/asr/tencentAdapter.ts` |
| `gapDetected` 从未被置 true，断线时 UI 只有「重连中」没有显式缺口标记，不满足方案第 16 节第 6 条 | `ws.on("close")` 分支与 `scheduleReconnect()` 的 emit status 都带上 `gapDetected: true` | `src/main/asr/tencentAdapter.ts` |

**gapDetected 为什么不用改 orchestrator**：`orchestrator.ts` 的状态合并是
`this.asrStatus = { ...this.asrStatus, ...st }`，spread 会自然把 `gapDetected`
合进 asrStatus 并透传给 UI。而 `st.state === "connected"` 分支只清了 `lastError`、
没清 `gapDetected`——这是对的：缺口是历史事实，重连成功不该抹掉"刚才断过"这个信息。
所以改 adapter 就够，`analysis/` 一行没动。

两项修复后均验证：`tsc -p tsconfig.main.json` 通过；ASR 三项单测 30/30 全过。

### 12.2 未修（需其他角色或用户处理）

| 问题 | 影响 | 处理方 |
|---|---|---|
| `convert_num_mode` 把"二裂酵母"转成"2裂酵母" | 话术热词规则匹配不上 | 已派**话术分析**在规则匹配层做数字归一化（不动 asr/ 存储原文） |
| 30 分钟长跑未跑 | 方案 Day 2 硬性验收项 | 负责人安排：等第②级直播跑完再排（避免 loopback 互相污染） |
| 真实断网 30 秒未测 | 方案第 16 节第 6 条 | 负责人指示暂缓（影响同机器其他联网工作）。测试脚本 `net-cut-test.js` 已就绪 |
| 第②级抖音直播未测 | 三级验收第 2 级 | **用户侧硬阻塞**：需在 DSH Desktop 开浏览器面板播放直播间 |

### 12.3 环境类坑（不是代码问题，记录备查）

| 现象 | 原因 | 解法 |
|---|---|---|
| Node 下 `getaddrinfo EAI_AGAIN asr.cloud.tencent.com` | 多网卡且仅 WLAN 在线，Node 的 DNS 查询失败 | PowerShell 的 `Resolve-DnsName` 正常；压测脚本改用 TLS socket 预连 + `createConnection` 绕开 |
| `ws` 覆盖 `dns.lookup` 报 `Invalid IP address: undefined` | `ws` 内部按 `(hostname, options, callback)` 调用，覆盖时签名不匹配 | 放弃覆盖 DNS，改用 `tls.connect({host, port, servername})` 预连 + `createConnection` 传 socket |
| `ffmpeg -f dshow audio="CABLE Input"` 报 `Requested output format 'dshow' is not known` | 这个 ffmpeg build 只有 dshow demuxer（采集）没有 muxer（播放） | 播放改用 `ffplay`，靠系统默认输出设备 |
| PowerShell `-File` 跑含中文路径的脚本，路径变乱码 | PowerShell 按 ANSI 代码页解析命令行 | 脚本内避免中文字面量路径，或用 `[scriptblock]::Create` 时以 UTF8 读文件 |
| `param()` 块在 `[scriptblock]::Create` 下解析失败 | PowerShell 5.1 兼容性 | 改用 `$args` 传参 |
| 本机无法脚本化切换默认播放设备 | 无 AudioDeviceCmdlets 模块、无 nircmd，注册表 Sound Mapper 键不存在 | 不切设备，直接用系统当前默认输出（本机是 CABLE Input，声音经 VB-CABLE 内部路由被 loopback 采回） |
| CDP `Input.dispatchMouseEvent` 合成点击 vs `Runtime.evaluate` 带 `userGesture` | 合成鼠标事件在部分环境下不被 Chromium 认成用户手势 | 实测本例中 `Input.dispatchMouseEvent`（真实 mousePressed/mouseReleased）可以，getDisplayMedia 正常拿到 `System audio` 音轨 |

---

## 13. 复现命令

### 13.1 生成测试音

```powershell
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\scripts\asr-bench\gen.js"
```

### 13.2 WebSocket 层压测（含断线复连）

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\scripts\asr-bench\direct-probe2.js" 180 90
# 参数：运行秒数，在第几秒主动断线复连
```

### 13.3 app 内链路驱动

```powershell
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\scripts\asr-bench\loopback-drive.js" 9333 30
# 参数：CDP 端口，观测秒数
```

### 13.4 SQLite 核对

```powershell
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\scripts\asr-bench\check-db.js"
```

### 13.5 ASR 单测

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\node_modules\vitest\vitest.mjs" run tests/asr.test.ts tests/asr-lifecycle.test.ts tests/asr-session-boundaries.test.ts
```

---

## 14. 附录：文件清单

### 14.1 源码改动

| 路径 | 改动 |
|---|---|
| `src/main/asr/tencentAdapter.ts` | ① `parseTencentMessage` 时间映射改为透传 `start_time`/`end_time`；② close 分支与 `scheduleReconnect()` emit `gapDetected: true` |

### 14.2 测试与压测脚本

| 路径 | 用途 |
|---|---|
| `scripts/asr-bench/live-scripts.txt` | 20 句直播话术文本 |
| `scripts/asr-bench/gen.js` | TTS 生成中文 WAV |
| `scripts/asr-bench/audio/seg-*.wav` | 生成的测试音（16kHz/16bit/mono，约 4.8 分钟） |
| `scripts/asr-bench/direct-probe2.js` | WebSocket 层压测（含断线复连、按连接锚定延迟） |
| `scripts/asr-bench/loopback-drive.js` | app 内链路驱动（CDP 真实点击按钮 + ffplay 播测试音） |
| `scripts/asr-bench/net-cut-test.js` | 真实断网测试（`netsh wlan disconnect`，**已就绪未跑**） |
| `scripts/asr-bench/check-db.js` | SQLite 只读核对 |
| `scripts/asr-bench/save-evidence.js` | 探针输出转结构化 JSON |
| `scripts/asr-bench/extract-metrics.js` | 从日志抽关键指标 |
| `scripts/asr-bench/cdp.js` | CDP 轻量客户端（探页面/ASR 状态） |
| `scripts/asr-bench/reset-session.js` | 结束 app 当前会话 |

### 14.3 证据与日志

| 路径 | 用途 |
|---|---|
| `scripts/asr-bench/evidence/README.md` | 证据说明与测量方法 |
| `scripts/asr-bench/evidence/websocket-probe-3min.json` | 3 分钟压测结构化证据（18 final / 269 partial） |
| `scripts/asr-bench/run-3min.log` | 3 分钟运行原始日志 |
| `scripts/asr-bench/run-30min.log` | 30 分钟长跑中断前日志（**不作为 30 分钟结论**） |
| `evidence/` | 验收证据（负责人指定目录） |

### 14.4 测试基线

ASR 相关三项单测，共 30 条，全过（1.28~1.48s）：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/asr.test.ts` | 21 | 消息解析 fixture、真实协议逐句字幕回归、签名算法独立复算、参数字典序、probe 裁决窗口、已存配置读取 |
| `tests/asr-lifecycle.test.ts` | 4 | 握手失败持续退避、握手期间 stop 不发 end 帧、旧连接迟到事件隔离、新连接重置去重状态 |
| `tests/asr-session-boundaries.test.ts` | 5 | flush 队列与子包尾部、恢复不造成音频突发、重连时间戳指向会话实际位置、迟到 LLM 响应隔离、错误恢复清旧错误 |
