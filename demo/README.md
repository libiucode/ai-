# 演示说明（demo/README.md）

> 修订日期：2026-10-15 ｜ 对应 HEAD：`b901be2`
>
> 本文说明**怎么把 AI盯播工具演示起来**，以及**哪些能说、哪些不能说**。
> 配套的逐分钟脚本见 [`script.md`](./script.md)。

---

## 1. 三种运行方式

### 方式 A：开发态（推荐用于功能演示）

```powershell
cd D:\ai盯播工具\app
$env:ELECTRON_RUN_AS_NODE = $null        # 必须！见下文「已知边界 2」
cmd /c "npm run build"
cmd /c "npx electron . --no-sandbox"
```

### 方式 B：安装包（推荐用于「交付物」演示）

```powershell
D:\ai盯播工具\app\release-verify\win-unpacked\AI盯播工具.exe
```

或双击 `release-verify\AI盯播工具-Setup-0.1.0.exe` 安装后启动。

> ⚠️ 安装包**是某个历史 commit 打的**。演示前请确认它与当前代码一致；
> 需要最新代码时重新 `cmd /c "npm run package"`（产物落在 `release-verify/`）。

### 方式 C：零额度界面演示（不消耗 ASR/LLM 额度）

只加载**打包产物里的界面**，主进程用桩，**不启动真实采集、不连 ASR**：

```powershell
cd D:\ai盯播工具\app
$env:ELECTRON_RUN_AS_NODE = $null
cmd /c "npx electron scripts/verify-packed-ui.js"
```

这条适合演示四页结构、面板职责、文案，**不产生任何云端调用**。

---

## 2. 两个演示 Plan

| | Plan A：真实链路 | Plan B：无密钥 |
|---|---|---|
| 前提 | 有 ASR/LLM 密钥环境变量 | 无密钥即可 |
| 内容 | 真实音频 → ASR 转写 → 分析 → 问题 → 报告 | fixture 讲解 + UI 走查 |
| 标注 | 「真实音频，现场 ASR 与 AI 分析」 | 全程「模拟数据演示」 |
| 额度 | **会消耗试用额度** | **零消耗** |
| 适用 | 最终验收演示 | 功能结构讲解、额度紧张时 |

**Plan A 的密钥怎么给**：见 `script.md` 第 0.1 节（界面填写 **或** 环境变量，环境变量优先）。
**关键**：两条通道都行，**不必**为此去改系统环境变量；若已在界面保存过，直接可用。

---

## 3. 已知边界（演示前必读）

### 边界 1：本机 PowerShell 直接跑 npm 会被拦截

脚本执行策略禁止 `npm.ps1`。所有 npm 命令改用：

```powershell
cmd /c "npm run build"
cmd /c "npm test"
cmd /c "npm run package"
```

### 边界 2：启动 Electron 前必须清 `ELECTRON_RUN_AS_NODE`

本机该变量默认为 `1`，会让 `require('electron')` 只返回 exe 路径字符串，
应用崩在 `Cannot read properties of undefined (reading 'whenReady')`。

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
```

### 边界 3：重装依赖后要重建 better-sqlite3 ABI

better-sqlite3 的二进制只能挂一个 ABI：Electron 33 要 **130**，本机 Node v24 要 **137**。
谁重装依赖，谁跑一次：

```powershell
cmd /c "npm run abi:electron"
```

> 打包时**不需要**手动跑它：`npm run package` 的 `prepackage` 会自动
> typecheck + build + 只读 native 闸门（`scripts/verify-electron-native.js`），
> 闸门会真正打开内存 SQLite 校验版本/平台/架构，失败则禁止打包。
> 该闸门只读、不重写二进制，因此不会与正在跑的应用抢文件。

### 边界 4：密钥有两条通道（2026-10-16 更正）

> 本节旧版写「界面无任何密钥输入框」，**已失效**。当前版本界面有「密钥（加密存本机）」面板。

- **通道 A：界面填写** → `SettingsPage.tsx` 的密钥面板，Electron `safeStorage` 加密后存本机（`credential_store_v1`）
- **通道 B：环境变量** → `src/main/security/runtimeConfig.ts` 读取
- **环境变量优先级更高**，两者都有时以环境变量为准
- 三条硬红线不变：**不要**把密钥写进任何文件、不要贴进聊天、不要永久写入系统环境
- 界面**不回显明文**（已配置显示 `••••••••`），日志/错误提示/导出报告均无明文（`redactSecrets()` 脱敏）
- 安全边界别夸大：密文绑本机账户，换机器不可解；防的是明文落盘被检索，**不防**同账户下的其它程序

| 演示 plan | 推荐通道 |
|---|---|
| Plan A（真实链路） | 任取其一；本人机器上有旧配置时用**界面填写**更省事 |
| Plan B（无密钥） | 不需要密钥 |

---

## 4. 演示数据说明（逐个 fixture）

### 4.1 演示专用（`demo/`）

| 文件 | 演示什么 | 真实还是模拟 |
|---|---|---|
| `demo/sample-framework.json` | 话术配置：商品事实 / 步骤 / 规则三块 | **模拟**。虚构商品「清晨500mL保温杯」，`"simulated": true` |
| `demo/script.md` | 逐分钟演示脚本 | — |
| `demo/README.md` | 本文件 | — |

> `demo/sample-framework.json` 里明确写了「模拟资料，不代表真实在售商品；不得直接用于真实宣传」。

### 4.2 测试夹具（`fixtures/`）— **不是演示数据**

| 文件 | 演示什么 | 真实还是模拟 |
|---|---|---|
| `fixtures/framework-sample.json` | 话术框架结构 | **模拟**。但含「实验室恒温测试12小时」等未核实宣称，**不建议用于演示** |
| `fixtures/asr-partial-final.json` | 临时/稳态字幕分离 | **模拟** ASR 消息 |
| `fixtures/asr-reconnect.json` | 断线重连与去重 | **模拟** ASR 消息 |
| `fixtures/llm-valid.json` | 合法 LLM 输出 | **模拟** |
| `fixtures/llm-fake-evidence.json` | 伪造引文被拒 | **模拟**（用于讲幻觉防护） |
| `fixtures/llm-invalid-json.json` | 坏 JSON 被拒 | **模拟** |
| `fixtures/llm-timeout.json` | 超时处理 | **模拟** |

> ⚠️ **`demo/sample-framework.json` 与 `fixtures/framework-sample.json` 内容不同**，
> 演示请用前者。早期脚本误指了 `fixtures/` 那份。

---

## 5. 演示时不能说的话（逐条对照）

| 不能说 | 实际 | 依据 |
|---|---|---|
| 「数据不出本机」 | 记录存本机，**音频送 ASR、转写送 LLM** | `App.tsx:42-47` 已改为如实描述 |
| 「勾选分享音频」 | Electron 下**没有**这个选项 | `audioCapture.ts:205-207` |
| ~~「在设置里填 API Key」~~ **已从「不能说」移出**（见下方说明） | 2026-10-16 起界面**有**密钥输入框，这句话现在**可以说** | `SettingsPage.tsx` 密钥面板 + `credentialStore.ts` |
| 「密钥明文存在数据库里」 | 存的是 `safeStorage` **密文**，原文明文不落盘 | `credentialStore.ts` 的 `safeStorage.encryptString` |
| 「换台机器密钥还能用」 | **不能**——DPAPI/Keychain 密文绑本机账户，换机器显示未配置 | `credentialStore.ts` 顶部边界注释 |
| 「报告里有 ASR/LLM 请求统计」 | 显示**「未统计」**，无持久化来源 | `HistoryPage.tsx` 的「未统计」区块、`reportBuilder.ts`（字段返回 `null`） |
| 「macOS 已验证」 | **未实测** | 见第 6 节 |
| 「长跑两小时稳定」 | **未实测**（五项数据缺失） | 见第 6 节 |

**可以说的**：
- 规则引擎秒级兜底 + LLM 深度建议
- 每个问题可溯源到具体转写片段（`segment` + 时间戳）
- 「分析运行 x/y 成功」是真实统计；口径为**「规则 + LLM 语义分析都完整执行」才记 success**，未配置 LLM 或空窗口记 **skipped** 且不计入成功
- 报告「会话信息」里有**「结束方式」**：手动结束 / 排期到点自动结束 / 上次进程异常退出收尾 / 长时间无音频自动结束；早期会话显示「未记录」
- 到点**自动结束**已接通；到点**自动开始**未接通（受浏览器安全模型限制）
- 设备故障与内容静音已分流提示

---

## 6. 未实测项（演示中不得暗示已验证）

| 项 | 状态 | 说明 |
|---|---|---|
| **macOS 全部功能** | ❌ 未实测 | 本周只交付 Windows x64 |
| **长跑稳定性（2 小时 / 五项数据）** | ❌ 未实测 | 队列积压、内存趋势等五项数据缺失 |
| **误报/漏报抽检（20 个真实候选）** | ❌ 未实测 | 需真实语料 |
| **真实 LLM 链路** | ⚠️ 部分 | 依赖安全密钥；无密钥时为「未实测」 |
| **安装包双击完整链路** | ⚠️ 部分 | 裸启动 UI 已验；完整采集→ASR→字幕链路需持安全 env 启动 |
| **到点自动开始** | ❌ 未接通 | Chromium user activation 硬约束，程序无法自行触发采集 |
| **到点自动结束** | ✅ 已接通 | 只停已有轨道，不受手势约束 |
| **ASR 延迟数字（p50 1589ms / 首字 1833ms）** | ⚠️ **有数字但不宜当结论** | 样本 **n=18**、3 分钟运行、**音源是 TTS**，且该次运行**中途在第 90 秒主动断线重连过一次**（数字是修正基准后按「连接内基准」重算的）。真实直播的**多次**重连场景未测 |

> **延迟这条要特别小心。** 报告里的 `p50 1589ms / 首字 1833ms` 是真实实测（非估算），
> 但它的成立条件很窄：**18 个样本、TTS 音源、且只经历了一次重连**。
> - 重连场景**恰恰是这套计算最容易出错的地方**——这组数字的历史版本就是错的：
>   用「会话启动时刻」做基准时算出 **p50 95 秒**的荒谬值（重连后服务端 `end_time` 从 0 重计，
>   基准没跟着换）。改成按「连接内首包时钟」做基准后才得到 p50 1589ms
>   （见 `docs/asr-link-verification.md` §5.2）。
> - 也就是说：**这组数字是在「修正过重连基准」之后、且只重连一次的条件下得到的**；
>   真实直播**必然经历多次重连**，多次重连下的时间轴正确性**未测**。
>
> **演示时建议只说行为、不报数字**：讲「边说边出字、临时字幕会变、稳态字幕定稿」
> 这个**可观察行为**；不要报具体毫秒数。若被追问延迟，如实说
> 「实测 p50 约 1.6 秒，但样本仅 18 条、音源是 TTS，多次重连场景未测」。

---

## 7. 演示前自检清单

- [ ] `$env:ELECTRON_RUN_AS_NODE = $null` 已执行
- [ ] 有密钥时：环境变量已设，两处「测试连接」均成功
- [ ] 无密钥时：已切 Plan B，并准备好全程标注「模拟数据」
- [ ] 分析间隔/窗口已改为演示值（30 秒 / 3 分钟），并**口播标明**
- [ ] 导入的是 `demo/sample-framework.json`（不是 `fixtures/` 那份）
- [ ] 已确认**不会**口播「勾选分享音频」「数据不出本机」「在设置里填密钥」
- [ ] **不报 ASR 延迟毫秒数**（样本 n=18、TTS 音源、只重连过一次；只说「边说边出字」的行为）
- [ ] 已准备真实音频源（回放或现场讲解），并戴耳机避免回授
- [ ] 若要演示排期自动结束，已配好一个**马上到点**的结束时刻
- [ ] 明确知道哪些是模拟数据、哪些未实测
