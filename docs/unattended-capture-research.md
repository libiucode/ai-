# 无人值守采集：前置调研（模块 A 刚需）

> 本轮**只调研，未改任何代码**。范围：`src/main/capture/`、`src/renderer/capture/` 及与其直接相关的
> `src/main/index.ts`、`src/renderer/pages/MonitorPage.tsx`、`src/main/ipc.ts`（只读）。
>
> 目标问题：现在必须人工点「监听系统声音」才能建会话。要做到「到点自动开录」，采集侧有什么障碍？

---

## 0. 一句话结论

**三层障碍，两层可解、一层需要产品决策。**

| 层 | 障碍 | 可解性 |
|---|---|---|
| 1 | `userGesture` 校验（采集入口） | 可解，但**不能靠绕过手势**——必须走「保留用户一次性授权」的模型 |
| 2 | 设备选择没有记忆（`captureSelectDevice` 是空实现） | 可解，纯工程 |
| 3 | 时序耦合：采集必须先于会话建立 | 可解，需改调用顺序或加就绪门 |

---

## 1. 障碍一：`userGesture` 校验

### 1.1 现状

`src/main/index.ts:34-42`：

```ts
mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
  const owner = mainWindow;
  const gestureOk = request.userGesture || allowGesturelessCapture;
  if (process.platform !== "win32" || !owner || owner.isDestroyed() ||
      request.frame !== owner.webContents.mainFrame || !gestureOk ||
      !request.audioRequested || !request.videoRequested) {
    callback({});
    return;
  }
  ...
});
```

`allowGesturelessCapture` 来自 `AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE === "1"`，**默认关闭**，仅本地验收实例使用。

### 1.2 为什么这是真障碍

`request.userGesture` 由 Chromium 的 user activation 决定，而 user activation **只能由真实用户输入产生**。2026-10-14 实测结论：

- CDP `Runtime.evaluate` 不带 `userGesture: true` → `AbortError: Error starting capture`
- CDP `Input.dispatchMouseEvent`（合成）→ 无法产生 activation
- Win32 `mouse_event`（硬件级）→ 同样无法产生 activation
- 定时器、`setInterval`、启动回调里调用 → 当然也没有 activation

**结论：没有任何「程序自己触发」的方式能通过手势校验。** 这不是实现问题，是 Chromium 的安全模型。

### 1.3 可行路线（按推荐度）

**路线 A：保留用户一次性授权，后续自动复用（推荐）**

用户点一次「开始监听」→ 拿到 `MediaStream` → **不解绑**，保持长生命周期。之后「到点自动开录」不是重新调 `getDisplayMedia`，而是：

- 会话切换时对**同一个 stream** 复用（`stream.getAudioTracks()` 仍在 live 状态）
- 若轨道 ended（设备变化/服务重启），此时再回落到需要用户重新授权

代价：需要常驻一个 `MediaStream`（系统回环采集一直在跑，即使不在记录）。需要产品决策是否接受「麦克风/系统声灯常亮」。

**路线 B：托盘/开机自启 + 用户一次性点击**

应用启动后弹一次确认，用户点「允许录音」→ 建立长效 stream → 之后定时任务复用。本质是 A 的变体。

**路线 C：不用 `getDisplayMedia`，改走原生采集（未实测）**

在 main 进程直接用 `desktopCapturer` 或原生 API 拿 loopback，不经渲染进程的 `getDisplayMedia`，因此不受 user activation 约束。

⚠️ **这条是架构改动，超出 `capture/` 范围，且未实测。** 需要先验证：
1. Electron 主进程是否有办法直接拿到系统回环音频（`desktopCapturer` 给的是 DesktopCapturerSource，取音频需经 `navigator.mediaDevices` 消费，仍会回到渲染层）
2. 是否有第三方原生模块（如 `node-audio` / WASAPI 绑定）可用，及其 ABI/签名/打包影响

**不建议**：长期开启 `AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE`。它是验收旁路，默认关闭是刻意的设计；生产环境打开等于允许任何脚本静默启动系统录音。

---

## 2. 障碍二：设备选择没有记忆

### 2.1 现状（实测发现）

`src/main/ipc.ts:156-158`：

```ts
ipcMain.handle(IpcChannels.captureSelectDevice, async (_e, deviceId: unknown) => {
  return typeof deviceId === "string";
});
```

**这个 handler 只校验类型，完全丢弃 `deviceId`。** 也就是说：

- `appApi.selectAudioDevice(id)` 调用后在**主进程侧没有任何效果**
- 设备选择只存在于渲染进程的 `deviceId` state（`MonitorPage.tsx:29`），页面刷新/重载即丢失
- 没有任何持久化（`settings` 表里也没有设备字段的记录路径）

### 2.2 影响

无人值守场景下，用户预先选好的设备在应用重启后会回到「默认设备」，**可能导致到点开录时采错设备**（例如选中了 VB-CABLE 但重启后回到 Razer 麦克风）。

### 2.3 建议（纯工程，可解）

1. 主进程真正保存 `deviceId`（写入 `settings` 表）
2. 渲染进程启动时从主进程读回并回填下拉框
3. 设备失效时（`NotFoundError` / `OverconstrainedError`）明确提示回落到默认设备，而不是静默采错

⚠️ 涉及 `src/main/ipc.ts`（存储侧），**不在我的写范围内**，本条只作结论上报。

---

## 3. 障碍三：初始化时序耦合

### 3.1 现状

`MonitorPage.tsx:125-139` 的 `doStart` 顺序是：

```
1. 先调开始采集（getUserMedia / getDisplayMedia）
2. result.ok 为真 → captureRef.current = handle
3. 再调 mon.startSession({ audioSource, deviceId })
4. started 为假 → 停采集、清空、报错
```

而主进程侧 `orchestrator.ingestAudio()` 第一行：

```ts
if (this.status !== "active" || !this.sessionId) return;
```

### 3.2 已有实测证据

我在第①级诊断中踩过这个坑：**采集起了、音频帧在流，但会话没建，main 把所有帧直接丢弃**，出现「电平完美非零 + 0 条字幕」。

`doStart` 之所以能正常工作，是因为它把「先采集、后建会话」串行化了，两步之间只有几毫秒。但无人值守场景下如果拆开（例如定时器先建会话、隔一会儿再采集），这个 gap 会放大成真实丢音。

### 3.3 建议

无人值守的启动流程应当是**先建会话、且主进程侧确认 `status === "active"`，再开始采集**；或者反过来但保证中间不丢帧（在 main 侧加一个「未 active 时的短暂缓冲」而不是直接 return）。

**当前设计是「未 active 直接丢」，这在有人值守时正确（避免脏数据），在无人值守时需要额外的就绪门。** 这属于 `analysis/orchestrator.ts`，不在我范围内。

---

## 4. 其它观察到的小问题

| 项 | 现状 | 影响 |
|---|---|---|
| `NotAllowedError` / `NO_DEVICE` 文案 | ~~仍写着「勾选分享音频」~~ **已改**（2026-10-14，`audioCapture.ts`） | Electron 下不存在这个勾选项（由 main 的 handler 直接给源）。原文案会误导用户去找一个不存在的选项 |
| `AudioContext` 采样率 | 依赖系统输出设备（本机 48000） | 已由 `PcmResamplerSlicer` 处理 44.1k/48k→16k，无需改动 |
| 设备失效检测 | `t.addEventListener("ended")` 已有 | 无人值守下应升级：见 `docs/capture-device-health-design.md`（区分「设备故障」与「内容静音」） |
| 无声警告 | 已实现（`SILENCE_WARN_MS=5000`） | 无人值守时是有用的健康信号；但当前**无法区分**「设备死了」和「没人说话」，需加设备健康检查前置判据 |

---

## 4.5 设计前提：外部依赖都不是稳定前提（2026-10-14 追加）

**无人值守必须在开机前做前置自检，而不是等出事再报错。** 依据来自本轮三处独立观察：

| 外部依赖 | 观察到的不稳定 | 来源 |
|---|---|---|
| 公开直播流 | 8 个源中 2 个 1080p 源隔日复测**完全拉不出音频**（0 秒解码）；有效性随时间漂移 | 实时转写本轮实测 |
| 虚拟声卡路由 | 本机默认输出是 CABLE Input，信号经 VB-CABLE 内部自环一跳；设备哈希变化会导致旧轨道死亡 | 本轮与第①级实测 |
| 默认输出设备 | 无工具可脚本化切换（COM `IPolicyConfig` 全部 `E_NOINTERFACE`）；切换后行为**未实测** | 本轮实测 |
| ASR 凭证 | 只在 Harness 会话继承的进程里可用，外部拉起的 app 读不到 | 本轮实测 |

**结论**：这些都是「运行时可能变、变了会静默失效」的外部条件。无人值守的启动流程应当包含**开机自检**：

1. 目标音频设备是否存在（`enumerateDevices` 比对）
2. 默认输出设备是否合理（不是意外的虚拟设备 / 不是已断开设备）
3. 直播源是否可达且能解码出音频
4. ASR 凭证是否存在且可用

任一项失败 → **开机即明确报错并记录**，而不是等到直播结束才发现整场没录到。

配套的运行期检查见 `docs/capture-device-health-design.md`。

---

## 5. 结论汇总（给产品/排期用）

| 障碍 | 位置 | 可解性 | 需要谁 |
|---|---|---|---|
| `userGesture` 校验 | `src/main/index.ts:34-42` | 需产品决策（常驻 stream vs 原生采集） | 桌面端 + 产品 |
| 设备选择无记忆 | `src/main/ipc.ts:156-158` | 纯工程可解 | 桌面端（存储侧） |
| 启动时序 gap | `MonitorPage.tsx:125` + `orchestrator.ts` | 纯工程可解 | 桌面端 + 分析侧 |

**采集侧本身（`src/main/capture/`、`src/renderer/capture/`）没有阻塞性障碍**：`wireStream` 的逻辑与「谁触发、何时触发」无关，只要拿到 `MediaStream` 就能工作。三个障碍都在采集之外（main 的权限门、IPC 的存储、渲染的调用顺序）。

**未实测标注**：路线 C（原生采集绕开手势）纯属推导，未做任何验证。上述所有结论均基于源码阅读 + 2026-10-14 的实测记录，没有运行新的验证。

---

## 6. 补充：「到点自动结束」已接通（2026-10-15，与本文档障碍无关）

本文档调研的是「到点**自动开始**」，它卡在 `userGesture` 上。但无人值守还有另一半——「到点**自动结束**」，**它不受任何手势约束，已在本轮实施完成**。

### 6.1 为什么它能独立成立

`getDisplayMedia` 需要 user activation，是因为它要**新取得**采集权限；而结束会话只是停掉已在跑的 `MediaStreamTrack` 与 ASR 连接，**不申请任何新权限**。

**两个能力的可解性完全不同，不应该被一起归为「无人值守未接通」。**

### 6.2 实现（零额度，不依赖真实音频）

| 层 | 改动 |
|---|---|
| 纯函数 | `src/shared/schedule.ts` 新增 `scheduledEndAt()`：给定时刻算出所在排期窗口的结束时刻；窗口外返回 `null` |
| 主进程 | `SessionOrchestrator.start()` 绑一次结束时刻；`tickTimer` 每秒调 `checkScheduledEnd()`；到点调 `stop("schedule-window-end")` |
| 落库 | `sessions.end_reason`（schema v4），区分 `user` / `schedule-window-end` / `process-restart` / `no-audio-timeout` |
| 界面 | 会话进行中显示「排期结束」倒计时；到点弹出 `SESSION_AUTO_ENDED` 提示写明原因 |

### 6.3 两条关键设计约束

1. **只在窗口内启动的会话才绑定结束时刻。** 用户在窗口外手动开的临时监听不会被预约结束掐断——否则「临时听一会儿」会被一个跟他无关的排期打断。
2. **每秒轮询而不是 `setTimeout`。** 会话可能被暂停/恢复，绝对时刻的定时器在暂停期间仍会到点，会在用户手动暂停后突然把会话结束掉。轮询 + `status === "active"` 判断，语义才与「排期窗口到点」一致。

### 6.4 与「无音频超时自动结束」的关系

后者**未实施**，且本轮评估已降级：干净直播样本最长静默只有 0.4~0.8 秒，该机制在真实直播里几乎不会触发，收益上限在几毛钱量级（见 `docs/auto-stop-threshold-analysis.md`）。**它的真实价值在失败会话与用户忘关两类场景，不在静默止损。**

### 6.5 测试

`tests/schedule.test.ts` 新增 5 条（窗口内外、跨天两段、结束时刻必须晚于 now 且不超 24h）；`tests/ready-gate.test.ts` 新增 5 条（绑定/不绑定、窗口外不绑定、到点结束写原因+提示、手动结束写 `user`）；`tests/migrations.test.ts` 增 v4 列与 `COALESCE` 不覆盖语义。**全部不消耗 ASR 额度。**
