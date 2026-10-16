# AI 盯播工具（Windows MVP）

直播话术合规与质量的本地实时监控工具：麦克风或系统声音 → 腾讯云实时 ASR → 本地规则引擎 + LLM 分析 → 实时问题提醒与直播报告。

> **当前交付范围：Windows x64。macOS 未实测。**
>
> **数据边界（必读，勿误读为"数据不出本机"）**
> 会话、转写、问题、设置只保存在本机 SQLite。但两条链路**必然出网**：
> - ASR：音频 16kHz/16bit/单声道，200ms 一包上传腾讯云实时语音识别；
> - LLM：窗口内转写文本上传你配置的 OpenAI 兼容服务。
> 因此"本地运行"指应用与数据存储在本机，不等于音频与转写不离开本机。

## 开源前的几句话（给第一次来的人）

这是一个**一周内从零做出来的 MVP**，不是成熟产品。它真实可用，但有明确的边界：

- **干净的真实带货直播样本 = 0 场**。所有实测素材是 TTS 测试音、公开转播广告口播、影视剧对白——**都不是带货直播**。因此严禁说"已用真实带货直播验证"。
- **到点自动开始未接通**。Chromium 的 user activation 只能由真实用户输入产生，程序无法自己触发系统声音采集。定时监听的 UI 与数据结构已做好，但**到点不会自动开始录制**。
- 已知限制、隐私边界、第二阶段规划全部逐条列在 [`docs/known-limitations.md`](docs/known-limitations.md)；已修问题与归因在 [`docs/incident-review.md`](docs/incident-review.md)。**这两份是交付物的一部分，不是开发日志。**
- 演示流程见 [`demo/script.md`](demo/script.md)，含"演示时不能说的话"清单。

## 项目简介

- **实时转写**：音频 16kHz/16bit/单声道，200ms 包上传腾讯云实时语音识别（ASR），临时/稳态字幕分开显示。
- **自动分析**：按可配置窗口（3/5/10 分钟，间隔 30/60/120 秒）做规则命中（绝对化用语、未核实宣称、自定义禁用词）+ 指标统计（语速、静音、重复）+ LLM 深度分析（引用原话、给出依据与建议）。
- **问题可溯源**：每条问题带原话证据、segment_id、时间戳、判断依据和改进建议；LLM 伪造引用会被服务端校验拒绝。
- **报告导出**：HTML / JSON 两种格式，全部来自真实数据库，不包含任何密钥。

## 本机到底有几个「AI盯播」目录（2026-10-16 实测，先读这段）

这台机器上同名字样的目录有 4 处，很容易搞混。**以下每条都是实测结果（含实测时间），不是推断。**

| 路径 | 它是什么 | 实测状态 |
|---|---|---|
| `D:\ai盯播工具\app\` | **开发目录（唯一）** | 源码在这里，git HEAD `882d358`。**改代码只改这里。** |
| `D:\ai盯播工具\ai-live-monitor\` | 空目录 | `Get-ChildItem -Recurse` 返回 **0 项**。早期文稿称它是「win-unpacked 部署目录」，该说法已过期，别再引用。 |
| `C:\Users\libiu\AppData\Local\Programs\ai-live-monitor\` | NSIS 默认安装目录 | **空目录**：没有 `resources/app.asar`，卸载注册表里也查不到本应用 → 这台机器**从未成功安装过**正式安装包。 |
| `D:\AI-Live-Monitor\` | 2026-10-13 00:56 解压的 win-unpacked 副本 | 内含 `AI盯播工具.exe`（约 180 MB）。是便携副本，**不是**安装产物。 |

**那现在跑的其实是哪个？** 实测进程列表（2026-10-16 20:23）：正在运行的是 `D:\ai盯播工具\app\release-verify\win-unpacked\AI盯播工具.exe`（6 个进程）——即**开发目录里的打包验证产物**，不是上面任何一个目录。

- 打包验证产物另有多个历史目录：`release/`、`release-final/`、`release-verify/` 等，均在 `D:\ai盯播工具\app\` 下，最新的是 `release-verify/`（2026-10-16 20:05）。
- 用户数据目录是**单独一处**：`%APPDATA%\ai-live-monitor\`（库 `live-monitor.db` 在那里）。它跟上面四个目录都无关，**卸载不会删它**。

一句话：**开发在 `app\`，验证跑 `app\release-verify\`，数据在 `%APPDATA%\ai-live-monitor\`，其余四个目录都不用管。**

## 安装与启动（Chief 已拍板的启动前提）

安装包由 `npm run package`（electron-builder，NSIS x64）产出。

**两种启动方式，能力不同，不要混谈：**

| 启动方式 | 能验什么 | 不能验什么 |
|---|---|---|
| 资源管理器裸双击 exe | 界面、导航、四页渲染、本地数据管理 | ASR / LLM **不工作**——这是预期行为，不是故障 |
| 从持有 `DSH_SECRET_*` 的 Harness 安全环境启动 exe | 完整链路：采集 → ASR → 字幕 → 分析 → 问题 → 报告 | — |

- 密钥有**两条通道**，取其一即可：**① 在设置页「密钥」面板填写**（经系统加密后存本机）；**② 进程环境变量**（CI / 自动化 / 不希望在盘上留存时）。**环境变量优先级更高**，两者都提供时以环境变量为准。两条都能完成配置，按你的环境选，不存在哪条更正统。
- 界面永不回显明文、不入库明文、不进日志与导出报告；只显示「已配置」。
- 卸载：Windows「设置 → 应用」中卸载。卸载**不会**删除用户数据，如需彻底清除，手动删除 `%APPDATA%/ai-live-monitor/`。

### 安全凭证（双通道）

| 用途 | 安全卡名 | 进程内变量 |
|---|---|---|
| 腾讯云 SecretId | `TENCENT_ASR_SECRET_ID` | `DSH_SECRET_TENCENT_ASR_SECRET_ID` |
| 腾讯云 SecretKey | `TENCENT_ASR_SECRET_KEY` | `DSH_SECRET_TENCENT_ASR_SECRET_KEY` |
| LLM API Key | `LLM_API_KEY` | `DSH_SECRET_LLM_API_KEY` |

**通道 ①：设置页填写**

设置页 →「密钥（加密存本机）」面板。输入框为 `type="password"`，填好后点「保存密钥」：

- 用 Electron `safeStorage` 加密后存本机数据库——Windows 走 DPAPI，macOS 走 Keychain，Linux 走系统密钥环。
- 密文绑定当前系统账户，**换机器或换账户后无法解密**，会当作未配置，需重新填写。
- 它防的是「明文落盘被随手看到或被全文检索到」，**不防同账户下的其它程序**。有环境变量时仍以环境变量为准。
- 「清除本机凭证」按钮只清界面存的密文，不影响环境变量。
- 系统不支持加密存储时输入框会被禁用，界面会提示改用环境变量。

**通道 ②：环境变量**（CI / 多环境切换），取值优先级高于通道 ①。

可选的**公开**环境变量（也可在设置页保存，优先级低于环境变量）：`DSH_TENCENT_ASR_APP_ID`、`DSH_LLM_BASE_URL`、`DSH_LLM_MODEL`。

- 数据库文件 `%APPDATA%/ai-live-monitor/live-monitor.db` 只保存公开配置、业务数据与上述密文。
- **不会**出现在：日志、错误提示、界面明文、导出的报告、Git 仓库。历史遗留的明文密钥记录运行链路不再读取，但**未被清理**。

## Windows 打包注意事项（winCodeSign 符号链接权限）

`npm run package` 首次执行时，electron-builder 会下载并解压 winCodeSign 工具包。在未开启 Windows 开发者模式的系统上，解压其中的符号链接文件会报 `EPERM`。规避办法（任选一）：

1. 开启 Windows「设置 → 系统 → 开发者选项 → 开发人员模式」，之后重试（一劳永逸）；
2. 或用 7-Zip 把 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<版本>.7z` 解压到同名目录，解压时排除 darwin 相关的符号链接文件，再重试。

换新机器或 CI 需要重新执行一次。

## 开发环境启动步骤

```bash
npm install          # 建议 Node 22 LTS 或更高版本；Windows 建议用 npm.cmd
npm run typecheck    # tsc 双 tsconfig 校验
npm test             # electron-node 方式跑 vitest 全量，单次 run 后退出；内部清空 DSH_SECRET_*，不发真实网络请求
npm run build        # 产出 dist/renderer + dist/main
npm run smoke        # 真实 Electron 渲染层冒烟：验证预加载生效、React 挂载、无 console 错误（防白屏）
npm run dev          # 构建 renderer + main 并启动 Electron
npm run package      # prepackage 自动 typecheck + build + 只读 native 闸门，再 electron-builder 打包
```

### better-sqlite3 ABI（重要，已改革）

better-sqlite3 单个二进制只能对应一个运行时：Electron 33.4.11 需要 **Electron ABI（modules 130）**，Node v24 需要 Node ABI（137）。

**现在 `npm test` 用 Electron 内置 Node（v20 / modules 130）跑 vitest，与二进制天然匹配，不切 ABI、不改写二进制。** 不要在跑测试前后执行 `abi:node` / `abi:electron`。

- **打包前也不要每次执行 `npm run abi:electron`**：二进制被占用时该命令自己也会失败（EBUSY）。`npm run package` 的 `prepackage` 钩子已内置只读 native 闸门（`scripts/verify-electron-native.js`）：
  - 用 Electron 33.4.11 真实 `require` 并打开 SQLite，打印 `PASS ... SQLite x.y.z` 才算过；
  - 只读校验，**不改写二进制**，前后 SHA-256 一致；
  - 失败时提示"AABI 不符，请结束自己负责的采集并协调 `npm run abi:electron` 后重试"——此时才需要协调重建。
- `build.npmRebuild: false` + `build.electronVersion: "33.4.11"` 已锁定，打包不再触发原生模块重建。
- **新机器例外**：`npm install` 后若 `prebuild-install` 装成 Node ABI，需先 `npm run abi:electron` 再 `npm test` / `npm run package`。
- 单元测试子进程会清空真实服务密钥，不会泄漏到测试输出。

## 凭证与公开配置的填写位置

1. **公开配置在界面填**：「分析设置」页：
   - ASR：App ID（公开信息，默认 `1502622498`）
   - LLM：Base URL、模型名
   - 分析间隔 / 窗口 / 请求超时 / 单场预算
2. **密钥二选一**：设置页「密钥」面板填写（加密存本机），或提供环境变量。**环境变量优先级更高**。
3. 「测试连接」与正式运行使用同一套取值逻辑（环境变量 > 本机密文）。
4. 保存设置时主进程会剥离所有密钥字段；`settings.get` 不回显历史记录中的敏感字段。密钥不在「保存全部设置」里提交，需单独点「保存密钥」。

## 音频来源选择方法

- **麦克风**：监控页 → 「开始麦克风监听」。可在下拉框选择具体设备（默认为系统默认麦克风）。适合主播本机自检。
- **系统声音**：监控页 → 「监听系统声音」。
  - **Windows**：由主进程 `setDisplayMediaRequestHandler` 直接授权主屏幕 + `audio: "loopback"`，**不弹 Chrome 式选择器**。因此不存在"选择标签页并勾选分享音频"这个步骤——采的是**整个主屏幕的系统播放声**。
  - **交付态必须真实用户点击**：handler 默认校验 `request.userGesture`，防止子页面或脚本在用户不知情时启动系统录音。
  - **本地验收旁路（默认关闭）**：`AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE=1` 会跳过手势校验，仅供持凭证的本地验收实例使用。**它不得出现在任何交付配置、安装脚本或文档化启动流程里。** 自动化验收若启用了该旁路，必须在结论中显式标注"使用了手势旁路"，否则该次验收不能作为交付证据。
  - 旁路存在的原因（实测限制）：Chromium 的 user activation 只由真实用户输入产生，CDP `Input.dispatchMouseEvent` 与 Win32 `mouse_event` 都不产生 activation，自动化点击无法通过手势校验。
  - 只由应用自己的顶层 frame、且必须带用户手势时才授权；其他 frame 或平台直接拒绝。
  - 屏幕视频轨只用于建立采集流，拿到后即停止。
  - 用于监听浏览器播放的直播间、直播伴侣/推流软件播放的声音（即观众听到的声音）。
  - 如果共享目标没有音频轨，应用会明确提示「共享目标没有提供音频」，不会假装在监听。
  - **不能保证只采某个标签页**：要隔离音源，请用系统侧手段（如把浏览器输出路由到指定设备）。
  - 失败时报 `NotSupportedError` 时，可能原因：应用未注册采集授权、屏幕录制权限未开启、系统不支持回环采集。不要再向用户断言"与 app 无关"。
- **无声提示**：连续 5 秒未检测到输入声音会显示警示，列出麦克风静音、共享目标选错、播放设备异常的排查项。

## 默认窗口和间隔设置

| 项目 | 默认值 | 可选值 |
|------|--------|--------|
| 分析间隔 | 60 秒 | 30 / 60 / 120 秒 |
| 分析窗口 | 5 分钟 | 3 / 5 / 10 分钟 |
| LLM 请求超时 | 20000 毫秒（整轮，上限即此值） | 可改但会被压到 20000 |
| 单场预算 | 10 次 LLM 请求（含修复重试） | 自定义 |

间隔与窗口在「分析设置」页修改，保存后**下一次会话**生效。

## API 费用估算方法

- ASR：按音频时长计费（腾讯云控制台可查用量）。实时识别约 2.5 元/小时起，以腾讯云最新价格为准。
- LLM：报告页「估算 token」= 转写中文字数 × 1.6 + 英文词数 × 1.3（输入近似值），**不是服务商实际计费量**。
- 实际 LLM 请求次数与失败次数：**未统计**（见「报告口径」）。

## 报告口径（重要，勿误读）

- **语速双分母**：分子 = 中文字数 + 英文词数；分母分别给「有效讲话时长」和「分析覆盖总时长」，两个语速都展示，不把长时间静音藏掉。
- **ASR 连接 / 断线 / 转写缺口计数：未统计**。JSON 中为 `null`，HTML 报告明确标注「未统计」。不要拿 `analysisRuns` 数量冒充请求数。
- **LLM 实际请求 / 失败次数：未统计**，JSON 为 `null`，HTML 标注「未统计」。
- 分析运行次数（成功/总数/失败）是真实统计，含义是"窗口分析跑了几轮"，与上面几项不是一回事。
- **关于 `tests/report.test.ts` 那 12 项通过的正确读法**：它们证明的是"报告里的统计与数据库记录一致""HTML 转义""导出无密钥""脱敏"这些**结构与口径逻辑**，**不能**据此认为"真实导出的报告里所有统计字段都有值、都可信"。恰恰相反：连接/断线/缺口与 LLM 请求/失败这几个字段按设计就是 `null` + 「未统计」。
- 有分析运行失败时报告会警示：相应窗口的问题可能缺失。

## macOS 当前限制

- 未在 macOS 上做任何实测。
- 主进程的 `setDisplayMediaRequestHandler` **当前只处理 Windows**；其他平台直接拒绝，系统声音采集在 macOS 上尚不可用。
- macOS 上的系统音频需要 **BlackHole** 虚拟声卡（`brew install blackhole-2ch`，并在「音频 MIDI 设置」里建多输出设备），届时按"选 BlackHole 虚拟输入当麦克风"的路径走。**该路径未实测。**
- 打包只配置了 Windows NSIS 目标。

## 隐私说明

- 会话、转写、问题、设置只保存在本机 SQLite（`%APPDATA%/ai-live-monitor/live-monitor.db`）。
- 音频不落盘（不保存原始音频文件），但会**实时上传**腾讯云 ASR；转写文本会上传你配置的 LLM 服务。
- 密钥双通道（设置页填写加密存本机 / 环境变量，环境变量优先），明文不写数据库、不进日志、不进报告、不回显界面；导出的报告经过密钥过滤测试（见 `tests/report.test.ts`）。
- 卸载应用不会自动删除数据库；如需清除请删除 `%APPDATA%/ai-live-monitor/`。

## 当前状态与已知限制（诚实声明）

**本周交付门槛是"真实音频验收"，它目前尚未完成，不属于第二阶段。**

已完成并有本轮证据：

- typecheck（双 tsconfig）、build、renderer smoke 通过。
- `npm test` 全量通过：**32 个测试文件 / 368/368 通过**（2026-10-16 20:33 实测，HEAD `882d358`）。fixture 通过**不代表**真实 ASR/LLM 已验收；其中 `real-window-harness` 的 3 项是工具自测，**不代表真实 LLM 已验收**。
- `npm test` 内部清空 `DSH_SECRET_*` 后运行，**不发出任何真实 ASR/LLM 请求**；真实联调脚本（`tencent-live-probe.js`、`asr-bench/*`、`verifyRealWindow`）直接运行以继承凭证。两者不要混用——用 `npm test` 的结果证明真实链路无效。
- Windows 系统声音主进程 handler 已注册：主屏幕 + loopback 授权路径就位，默认要求真实用户手势。
- 鉴权/上传连通性探针通过：12 秒本地合成多频波，451ms WebSocket 握手、2 个临时帧、1 个空文本稳态帧、close 1006。**只证明握手与上传链路连通，不证明识别出文本、不证明字幕、不证明端到端延迟验收。**

**第①级：采集链路本身 —— 本轮已跑通并核实（盯播负责人亲自核过证据文件，非采信转述）**

- 证据文件：`evidence/lvl1-subtitles-20261014-224219.json`（采集时间 2026-10-14 22:42:19）。
- 播放源：**中文 TTS 带货口播，265 秒合并 wav**，经 Windows loopback 进入应用。**不是抖音直播。**
- 结果：sessionId `190ba540-c53b-4807-ab6f-56e2e54345c7`；**5 条非空稳态片段**；时间戳严格递增（4980 → 14700 → 26020 → 35400 → 48060 → 60120 ms）；loopback 电平非零；ASR 状态「识别中」；UI `finalCount` 与 SQLite 行数一致且**逐字相同**。
- 同期另有一次已知信号验收（`evidence/lvl1-20261014-223740.json`，播放源 `D:\asrbench-audio\merged.wav`，75 秒）产出 7 条稳态，首条稳态出现在第 11 秒。
- **准确口径**：这一级证明的是「**Windows loopback 采集 → 腾讯云 ASR → 非空带时间戳字幕 → 落库与 UI 逐字一致**」这条链路本身已通。**不能写成「抖音直播间已通」**——播放源是已知中文测试音，不是直播内容。
- 该轮 LLM 未配置（UI 反复出现 `[ANALYSIS_LLM_FAILED] LLM_NOT_CONFIGURED`），故本证据不含 LLM 分析环节。

**第②级：直播内容源（抖音真实直播）—— 仍待证**

- 待证内容：`https://live.douyin.com/295178185857` 真实直播播放 → loopback → ASR → 字幕 → 分析 → 报告全链路。
- 阻塞点：需要用户打开浏览器面板播放直播间。**不阻塞在本工具自身。**

尚未验证（按交付门槛列出，不是"以后再说"）：

| 项 | 状态 |
|---|---|
| 抖音真实直播内容源端到端（第②级） | **待证**（阻塞在用户侧开浏览器面板，不阻塞在工具） |
| 麦克风完整链路与连续时长（10/30 分钟） | **待证**（此前 8 秒非零短测不能替代；loopback 已通不等于麦克风已通） |
| LLM 真实请求 | **待安全 key**：只读到的公开设置为 `http://127.0.0.1:3425/v1` + `group/auto-step-5-preview`，服务可用性与用户选择待 Chief 核实 |
| 打包 win-unpacked 双击启动后的完整链路 | **待证**（开发模式通过不能替代打包验收） |
| macOS 采集和打包 | 未实测 |
| ASR/LLM 连接、断线、缺口的真实计数 | 未统计（实现未持久化） |

其他已知取舍：

1. **LLM 修复重试计入预算**：一次分析最多计 2 次请求，预算偏保守。
2. **ASR 音频时长映射用启发式**：按 `audio_duration` 回推片段起止时间；真实联调时可能需要按腾讯实际返回字段（`start_time`/`end_time`）校准。
3. **精确分析倒计时未实现**：UI 只显示最近分析状态。
4. **话术步骤与阶段映射靠关键词触发**：漏说关键词的阶段不会出现在覆盖统计里。
5. **短会话尾部窗口可能不分析**：会话在调度边界前结束时，最后一个窗口可能未触发分析，最终字幕仍保存。
6. **DNS 瞬失败**：出现过 `getaddrinfo EAI_AGAIN`；持续断网时无法得到云端字幕。
7. **~~未配置 LLM 时会反复弹 `LLM_NOT_CONFIGURED`~~（已修复，2026-10-15，INC-21）**：原描述为「按 60 秒间隔一小时约 60 条，会淹没真实提示」。修复方式：`orchestrator` 在 `llmState === "not_configured"` 时**直接跳过 LLM 分支**，不再每个窗口调用 `llm.analyze()`，该窗口记 `skipped` 而非 `success`——**不会再把「没做语义分析」伪装成「成功」**。规则引擎照常工作。同类高频错误（`CAPTURE_QUEUE_OVERFLOW` 等按音频帧 85ms 触发）也已改为节流（首次立即报，之后每 60 秒最多一条，累计次数不丢失）。回归测试见 `tests/ready-gate.test.ts`。
8. **安装包产物**：`npm run package` 产出 `release-verify/AI盯播工具-Setup-0.1.0.exe`（约 85.8 MB，NSIS x64，未签名）。未签名状态下双击安装会触发 SmartScreen 提示，属预期。

## 演示脚本

见 `demo/script.md`（3–5 分钟演示流程）。演示配置（每 30 秒分析最近 3 分钟）与产品默认（每 60 秒分析最近 5 分钟）必须在画面上标明。

## 测试说明

- `npm test`：electron-node 方式，全量单次 run 后退出；不要用 `npx vitest run`（会因 Node ABI 不匹配全红），也不要在测试前后切 ABI。
- 本轮结果：**32 个测试文件 / 368/368 全通过**（2026-10-16 20:33 实测，HEAD `882d358`）。fixture 通过**不代表**真实 ASR/LLM 已验收。
- **测试数一律以 `npm test` 实测为准，文档不写死数字。** 本文档与 `docs/` 下各文若出现与实测不一致的测试数（例如旧写的 355/31 文件），**以实测为准**——355 是 2026-10-15 的基线，`882d358` 之后新增了断线缺口回归与 task-2 补网用例，故增至 368/32 文件。改文档前先跑一次 `npm test`，不要照抄上一版。
  - 其中 `tests/real-window-harness.test.ts` 的 3 项是**工具自测**：证明验证脚本（`verifyRealWindow.ts`）本身能跑通「真实窗口 → LLM → 证据门禁 → 报告」流程（隔离内存库、模拟 ASR 来源、模拟 fetch），**不代表真实 LLM 已验收**。
- **`npm test` 内部会清空 `DSH_SECRET_*`（及公开的 `DSH_TENCENT_ASR_APP_ID` / `DSH_LLM_BASE_URL` / `DSH_LLM_MODEL`）再启动 vitest**，防止单测意外发出真实网络请求。因此**不要以为 `npm test` 能验证真实链路**——它一条真实 ASR/LLM 请求都不会发。
- 真实联调（`scripts/tencent-live-probe.js`、`scripts/asr-bench/*`、`verifyRealWindow`）**不走 `npm test`**，直接运行以继承真实凭证。
- 新增 `tests/real-window-harness.test.ts`：真实窗口 → LLM → 证据门禁 → 报告的**隔离内存库**验证，ASR 来源与 fetch 均为模拟。它证明链路编排与门禁逻辑，**不算真实 LLM 验收**。- `fixtures/` 覆盖：ASR 临时/稳态分离、断线重连、LLM 正常/超时/坏 JSON/伪造证据、话术框架样例。
- 所有 fixture 测试标注「模拟数据」；fixture 通过**不代表**真实 ASR/LLM 已验收。
- 话术步骤覆盖：实时面板经 `script.status` 事件秒级刷新，报告侧由 `replayScriptPhases` 重放稳态转写还原（同一台状态机），测试见 `tests/scriptCoverage.test.ts`。
- 历史材料中的"10.815 秒人声 → 3 条稳态字幕"是**历史记录**，本轮未复现，不代表当前版本已通过真实识别验收。
