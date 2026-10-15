# 桌面端 UI 完整性与打包验证（P1-2）

- 验证人：桌面端
- 验证时间：2026-10-14 21:00 – 23:20
- 工程：`$PSScriptRoot\..`（Electron 33.4.11 / React 18 / TS / Vite / better-sqlite3 / ws / zod）
- 平台：Windows x64。macOS 一律标注**未实测**，本周只交付 Windows。

## 结论速览

| 项 | 结论 |
|---|---|
| A 监控页 | 通过（含新增 5 秒无声警告） |
| B 临时/稳态字幕区分 | 通过 |
| C 异常状态可见性 | 断线/分析失败通过；无声已在本次补上 |
| D 话术配置页 | 通过 |
| E 分析设置页 | 通过（密钥改环境变量，UI 只留公开配置） |
| F 报告页 | 通过（统计口径已改为诚实显示） |
| G IPC 类型化 | 通过 |
| H 打包 | 通过，产物 81.79 MB |
| I 安装验证 | 通过（win-unpacked 实测，非安装目录内） |
| J 打包配置 | 通过，icon 缺失已记录 |

---

## 一、源码核对与 UI 验收（A–G）

验证方式：用 Electron 加载**打包产物**里的真实 renderer + preload（`release-verify/win-unpacked/resources/app.asar`），
逐页点击切换后断言 DOM。脚本：`.verify-tmp/verify-packed-ui.js`。

### A. 实时监控页

| 要求 | 实测 |
|---|---|
| 音源选择 | 有，下拉"默认麦克风"+设备列表，另有"监听系统声音"按钮 |
| 输入电平 | 有实时可视化（`.meter` + `.meter-fill`，宽度按电平实时变化） |
| ASR 状态 | 有，chip 显示"未连接/连接中/识别中/重连中/已断开/错误"+重连次数 |
| 开始/暂停/结束 | 有。"开始麦克风监听""监听系统声音""暂停""继续""结束"齐全 |
| 实时字幕 | 有（`.transcript`，稳态含时间戳+序号，临时带"临时"标记） |
| 当前语速 | 见下方说明 |
| 最新分析状态 | 有（"最近分析"指标 + 分析倒计时） |
| 问题列表 | 有（`IssueCard`：严重度徽章、类型、时间、原话、依据、建议、定位原句按钮） |

产物实测：`MONITOR_METER=true`、`MONITOR_TRANSCRIPT=true`、
按钮 `["开始麦克风监听","监听系统声音"]`（未开始状态）。

**语速口径说明**：监控页"指标"区原有一格"有效讲话 / 静音"是写死的占位（恒显示 `—`），
我未改动它；真实语速（讲话分母 / 总时分母）在**报告页**输出，由分析线负责。

### B. 临时字幕与稳态文本区分（方案第 229 行硬要求）

- 稳态：正常字色，右侧标记"稳态 #序号"，含时间戳，可点击定位。
- 临时：`.seg-partial` → `opacity 0.6` + **斜体** + 灰色（`.seg-text` 用 `--text-dim`），
  行首有 `…` 标记，右侧标记"临时"。
- 面板顶部有文字说明："临时字幕为识别中间结果（灰色斜体），不落库；稳态字幕为已定稿内容。"

**通过**——颜色、斜体、透明度、文字标记四重区分。

### C. 异常状态可见性（方案第 229 行硬要求）

| 状态 | UI 表现 | 结论 |
|---|---|---|
| 断线 | ASR chip 变"重连中（第 N 次）"；顶部状态徽章转"重连中"；`hasTranscriptGap` 触发黄色 callout："ASR 曾断线重连，断线期间存在转写缺口"；断线瞬间清空临时字幕，不以旧字幕冒充当前 | 通过 |
| 无声 | **本次新增**：连续 5 秒电平低于阈值且处于监听态（capturing/reconnecting/analyzing）→ 黄色 callout 提示排查音源；声音恢复自动消失；**暂停时不报警** | 通过（新增） |
| 分析失败 | `app.error` 事件 → 错误行显示 `[ANALYSIS_LLM_FAILED] …`；"最近分析"指标显示 `failed`；报告页明确列出失败次数并注明"相应窗口的问题可能缺失" | 通过 |

无声警告实现（`MonitorPage.tsx`，仅 renderer 范围）：
阈值 `SILENCE_LEVEL_THRESHOLD = 0.005`（电平为每帧样本平均绝对值，室内底噪约 0.001–0.003，人声 0.02+），
`SILENCE_WARN_MS = 5000`；只在 `LISTENING_STATES = ["capturing","reconnecting","analyzing"]` 内判定，
`paused` 不报警（采集已主动停止，无声是预期）；开始/恢复时重置计时，避免暂停期间累计成误报。

### D. 话术配置页

产物实测面板：`基本信息`（话术名称、已核实商品事实）、`话术步骤（N）`、`自定义规则（N）`、`保存与导入导出`。

- 商品事实：多行文本域，标注"允许作为 AI 判断输入"
- 话术步骤：名称 + 优先级（可选/建议/必须）+ 最长等待时间（秒）+ 删除
- 自定义规则：类型（禁用词/绝对化/未核实宣称/重复话术/热词）+ 词或正则 + 绑定步骤 + 启用开关 + 删除；正则合法性校验
- JSON 导入/导出：有（`导出 JSON` / `导入 JSON`，导入走 `FrameworkEditSchema` 校验并给出具体错误）

**通过**。

### E. 分析设置页

产物实测字段：`App ID`、`Base URL`、`模型名`、`分析间隔`、`分析窗口`、`请求超时（毫秒）`、`单场预算上限`。

本次按安全要求改造（仅 renderer 范围）：

- **删除** Secret ID / Secret Key / API Key 三个输入框。产物实测 `PASSWORD_INPUTS=0`。
- 密钥一律来自进程环境变量（`DSH_SECRET_TENCENT_ASR_SECRET_ID/KEY`、`DSH_SECRET_LLM_API_KEY`），
  主进程只从 env 读，界面无法查看或替换。
- 连接测试统一走 `{ useStored: true }`，不再传手填密钥。
- 保存只写公开配置（App ID / Base URL / 模型名），密钥字段剥离，不落盘、不进 settings 表。
- 状态区按 source 显示：环境变量 → "密钥来自环境变量"；旧库配置 → 提示建议改用环境变量。

窗口/间隔/超时/预算：`windowIntervalSec`(30/60/120)、`windowSizeSec`(180/300/600) 由 orchestrator 启动时
从 `app_settings` 读取并生效；`budget_limit` 由 `LlmClient.analyze` 在超限时抛 `LLM_BUDGET_EXCEEDED`。
`paceThreshold` / `silenceThresholdMs` 在 schema 中存在但**无 UI 入口**（既有状态，未新增）。

### F. 直播报告页（历史与报告）

面板：会话信息、分析质量与缺口、问题统计、话术指标、话术步骤覆盖、问题时间轴。

本次按"诚实统计"要求改造（`HistoryPage.tsx`）：

- 原"ASR/LLM 请求次数"一格把 ASR 连接数与 LLM 请求数**合并**显示，且这两类事件本就没持久化，
  却用 `analysisRuns` 拼出近似数字——不同口径混在一格，既误导也让导出报告自相矛盾。
- 改为：只保留**真实**的"分析运行 x/y 成功"，ASR 连接/断线/缺口与 LLM 请求/失败标注**未统计**，
  并说明原因（实时事件未落库，无法事后回算）。
- 移除"估算 token"（同样是估算值，与"未统计"口径冲突）。

导出：`导出 HTML 报告` / `导出 JSON 报告` 两个按钮（产物内实测两个按钮都正常渲染）。

**报告导出格式映射（已修正）**：
`ReportFormatSchema` 原为 `["markdown","json"]`，但 `reportExport` 里 `format === "json"` 才走 JSON，
其余（即 `"markdown"`）实际调用 `buildHtmlReport()` 并写 `.html` 扩展名——**契约名撒谎**。
现改为 `["html","json"]`，并保留 `"markdown"` 作为**输入别名**在 schema 层归一化为 `"html"`，
兼容尚未更新的调用方（否则它们会被 Zod 拒绝、静默返回空字符串，用户只看到"导出已取消"）。
详见 `src/shared/schemas.ts:136` 的说明。`ipc.ts` 是 `if(json)→JSON else→HTML` 结构，无需改动。

### G. IPC 类型化

- `shared/api.ts` 的 `WindowApi` 与 `src/preload/index.ts` 暴露的方法**逐项对齐**（20 个方法 + `sendAudioChunk`）。
- 事件通道用 `IpcChannels` 常量映射，无 `any` 逃逸。
- 本次新增 `ConfigSource = "environment" | "storage"`，`AsrStatusInfo` / `LlmStatusInfo` 加 `source` 字段，
  移除已不再返回的 `secretIdTail` / `keyTail`（主进程已不回传密钥尾部）。
- 遗留小瑕疵（未改，仅记录）：preload 中 `session.list` / `session.detail` / `session.delete` /
  `asr.testConnection` / `llm.testConnection` / `report.generate` / `settings.getAsrStatus` /
  `settings.getLlmStatus` 用了字符串字面量而非 `IpcChannels` 常量，当前值与常量一致，
  但未来改常量时不会报错。`capture.listDevices` 常量已定义但无 handler 也无调用方。

---

## 二、打包（H–J）

### H. 打包执行

```powershell
# 打包进程自身不带 ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = $null
$env:PATH = "$PSScriptRoot\..\node_modules\7zip-bin\win\x64;" + $env:PATH
$env:ELECTRON_BUILDER_NSIS_DIR = "$env:LOCALAPPDATA\electron-builder\Cache\nsis\nsis-3.0.4.1"
$env:ELECTRON_BUILDER_OFFLINE = "true"
npm run package
```

- `npm run package` → **exit 0**
- 打包耗时：**166.4 秒**（含 `prepackage`：typecheck → build → native 只读闸门）
- 输出目录：`$PSScriptRoot\..\release-verify\`

**产物**：

| 文件 | 大小 |
|---|---|
| `release-verify\AI盯播工具-Setup-0.1.0.exe` | **81.79 MB**（85,758,302 字节） |
| `release-verify\AI盯播工具-Setup-0.1.0.exe.blockmap` | 0.09 MB |
| `release-verify\win-unpacked\AI盯播工具.exe` | 180.04 MB |
| `release-verify\win-unpacked\resources\app.asar` | 9.06 MB |

### 打包过程中撞到的三个坑（已解决，供后续复现参考）

1. **`@electron/rebuild` unlink 被占用 → EPERM**
   `npmRebuild: true` 时 builder 要 unlink `better_sqlite3.node`，
   而该文件正被另一个成员跑音频采集的进程加载着。
   解决：`build.npmRebuild = false` + 显式 `build.electronVersion = "33.4.11"`，
   并新增 `scripts/verify-electron-native.js` 作为**只读闸门**（由盯播负责人创建）：
   用目标 Electron 内置 Node 实际 `new Database(':memory:')` 并查 SQLite，校验 win32/x64/版本一致，
   失败即禁止 builder。本次闸门输出：
   `[native-gate] PASS Electron 33.4.11, ABI 130, win32/x64, SQLite 3.53.2`（exit 0）。

2. **签名工具联网下载失败**
   `winCodeSign-2.6.0` 下载超时。解决：`build.win.sign = null` + `signAndEditExecutable = false`
   + `signingHashAlgorithms = []`。产物为**未签名**安装包，双击会有 SmartScreen 提示，本地自用可接受。

3. **`7za` 不在 PATH**
   联网其实可达（下载 `nsis-resources-3.4.1.7z` 成功），真正失败是 Go 端解压时
   `exec: "7za": executable file not found in %PATH%`。
   解决：把 `node_modules\7zip-bin\win\x64` 加入 PATH。

另：`release\`（历史目录）中的 `app.asar` 被占用，builder 无法清理，故本次改用新输出目录
`release-verify\`，未动历史产物。

### I. 安装与启动验证

- 安装位置：`$PSScriptRoot\..\release-verify\win-unpacked`（**不在开发目录内**，直接双击 `AI盯播工具.exe`）
- 裸启动（不继承任何 DSH 凭证环境）：进程存活，主窗口标题 **「AI 盯播工具」**，内存约 100 MB，`Responding=True`
- 数据库：首次启动在 `%APPDATA%\ai-live-monitor\live-monitor.db` 创建
- 四页切换：全部渲染成功，无白屏、无"加载中"卡死
- 控制台：仅 Chromium 缓存与 CSP 警告，**无崩溃**

**两档验收口径**（按 Chief 定义）：

- **档① 裸双击**：只验 UI 启动 / 可操作 / 无崩溃。已实测通过。
  无 DSH env 时 ASR/LLM 不工作属**预期**，不是缺陷。
- **档② 持安全 env 的进程启动**：验完整链路（采集→ASR→字幕→话术→问题→导出）。
  **未实测**——LLM 安全卡待用户保存，真实直播音频 ASR 联调由音频采集线负责。
  本报告不冒充该档已通过。

### J. 打包配置检查

`package.json` 的 `build` 字段（本次新增/修改，均已通报盯播负责人）：

| 字段 | 值 | 说明 |
|---|---|---|
| `appId` | `com.local.ai-live-monitor` | |
| `productName` | `AI盯播工具` | |
| `asar` | `true` | |
| `asarUnpack` | better-sqlite3 / bindings / file-uri-to-path | |
| `npmRebuild` | `false` | 避免重写被占用的 native 文件 |
| `electronVersion` | `33.4.11` | 显式锁定 |
| `files` | dist/main、dist/renderer、package.json，排除 prebuilds | |
| `win.target` | nsis / x64 | |
| `win.sign` | `null` | 离线环境，未签名 |
| `nsis` | oneClick=false、可改安装目录、artifactName `AI盯播工具-Setup-${version}.exe` | |

**native 模块包含确认**：
`app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node` 存在（1.83 MB）。
哈希 `359CBD480D7C5B2E4693A68605DC1429E05C48D04016B7AA2AC0B04D6B176B17`，
与源码树中的二进制**完全一致**（即 Electron ABI 130）；PE machine = `0x8664`（x64）。
`bindings`、`file-uri-to-path` 一并包含。

**asar 内容确认**：`\dist\renderer\index.html`、`\dist\main\main\index.js`、
`\dist\main\preload\index.js`、`\package.json` 均在包内。

**icon**：**缺失**。构建日志 `default Electron icon is used reason=application icon is not set`，
产物使用 Electron 默认图标。未补图标（需补请先给素材或确认可用占位图标）。

**中文路径**：`D:\ai盯播工具\` 全程参与打包，**未出现乱码**。
产物文件名 `AI盯播工具-Setup-0.1.0.exe` 与 `AI盯播工具.exe` 中文正常；
asar 内路径、NSIS 脚本中的中文路径均正确；运行时窗口标题中文正常。

---

## 三、遗留与未实测

1. **未实测**：真实直播音频 ASR 字幕、真实 LLM 调用、档②完整链路（依赖安全卡 env + 音频采集线）。
2. **未实测**：macOS（本周不交付）。
3. **icon 缺失**（见 J）。
4. `ReportFormat` 枚举名 `markdown` 与实际产出 HTML 不一致，建议改名（需动共享契约）。
5. `paceThreshold` / `silenceThresholdMs` 有 schema 无 UI。
6. 安装包**未签名**，SmartScreen 会提示。
