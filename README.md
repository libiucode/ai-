# AI 盯播工具（Windows MVP）

直播话术合规与质量的本地实时监控工具：麦克风或系统声音 → 腾讯云实时 ASR → 本地规则引擎 + LLM 分析 → 实时问题提醒与直播报告。所有数据只保存在本机。

## 项目简介

- **实时转写**：音频 16kHz/16bit/单声道，200ms 包上传腾讯云实时语音识别（ASR），临时/稳态字幕分开显示。
- **自动分析**：按可配置窗口（3/5/10 分钟，间隔 30/60/120 秒）做规则命中（绝对化用语、未核实宣称、自定义禁用词）+ 指标统计（语速、静音、重复）+ LLM 深度分析（引用原话、给出依据与建议）。
- **问题可溯源**：每条问题带原话证据、segment_id、时间戳、判断依据和改进建议；LLM 伪造引用会被服务端校验拒绝。
- **报告导出**：HTML / JSON 两种格式，全部来自真实数据库，不包含任何密钥。

## Windows 安装步骤

1. 从 `release/` 目录获取安装包（如 `AI盯播工具-Setup-0.1.0.exe`）。
2. 双击安装，按提示选择安装目录（默认装到当前用户目录，不需要管理员）。
3. 安装完成后从开始菜单启动「AI盯播工具」。
4. 卸载：Windows「设置 → 应用」中卸载。卸载**不会**删除用户数据（数据库、报告），如需彻底清除，手动删除 `%APPDATA%/ai-live-monitor/` 目录。

## Windows 打包注意事项（winCodeSign 符号链接权限）

`npm run package` 首次执行时，electron-builder 会下载并解压 winCodeSign 工具包。在未开启 Windows 开发者模式的系统上，解压其中的符号链接文件会报 `EPERM`。规避办法（任选一）：

1. 开启 Windows「设置 → 系统 → 开发者选项 → 开发人员模式」，之后重试 `npm run package`（一劳永逸）；
2. 或手动解压：用 7-Zip 把 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<版本>.7z` 解压到同名目录，解压时排除 darwin 相关的符号链接文件，再重试打包。

本机开发环境已完成上述处理，打包可直接通过；换新机器或 CI 需要重新执行一次。

## 开发环境启动步骤

```bash
npm install          # 建议 Node 22 LTS 或更高版本；Windows 建议用 npm.cmd
npm test             # vitest 全部测试（46 个）；pretest 自动处理 better-sqlite3 ABI
npm run typecheck    # tsc 双 tsconfig 校验
npm run build        # 产出 dist/renderer + dist/main
npm run smoke        # 真实 Electron 渲染层冒烟：验证预加载生效、React 挂载、无 console 错误（防白屏）
npm run dev          # 构建 renderer + main 并启动 Electron
npm run package      # electron-builder 打包 Windows 安装包
```

### better-sqlite3 ABI 注意事项（重要）

better-sqlite3 的二进制只能对应一个运行时：
- 跑 `npm test` 需要 **Node ABI** 版本
- Electron 运行/打包需要 **Electron ABI** 版本

`npm test` 已内置 pretest 守卫（`scripts/ensure-sqlite-abi.js`）：跑测试前自动检测当前 Node 与二进制 ABI 是否匹配，不匹配则自动重建，**通常无需手动操作**。守卫还会顺带清理 `build/Release/.forge-meta`（@electron/rebuild 的重建记录）——留着过期的记录会让下次 `npm run package` 误判"已重建过"而跳过，把 Node ABI 的二进制打进安装包，应用一启动就崩。自动重建失败（无网络等）时，用手动切换命令：

```bash
# 切到 Electron（跑应用/打包前）
npm run abi:electron

# 切回 Node（跑测试前）
npm run abi:node
```

`abi:electron` 中的版本号（当前 33.4.11）需与 `node_modules/electron` 实际版本保持一致，升级 Electron 后同步修改 `package.json` 中该脚本。

## 腾讯云 ASR 开通和配置位置

1. 开通[实时语音识别](https://cloud.tencent.com/product/asr)（注意是**实时**语音识别，不是一句话识别）。
2. 在[ API 密钥管理](https://console.cloud.tencent.com/cam/capi)获取 `SecretId` / `SecretKey`。
3. 在[账号信息](https://console.cloud.tencent.com/developer)查看 `APPID`。
4. 打开应用「分析设置」页 → 腾讯云 ASR 区域，填入三项 → 「测试连接」→ 保存。
5. 确认账号已开通 `16k_zh` 引擎的实时识别权限（新用户有免费额度）。

计费参考：实时识别约 2.5 元/小时起（以腾讯云最新价格为准），1 小时直播约 2.5～4 元。

## OpenAI 兼容 API 配置

1. 「分析设置」→ LLM 区域，填入：
   - Base URL：如 `https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4` 等任何兼容 `/chat/completions` 的服务
   - 模型名：如 `gpt-4o-mini`、`glm-4-flash`
   - API Key
2. 「测试连接」会发一个 8 token 的最小请求验证连通性。
3. 「单场预算上限」默认 10 次 LLM 请求（约每 5 分钟窗口 1 次 + 修复重试），超出后自动停止 LLM 分析（本地规则继续生效），防止费用失控。

费用估算：报告页显示估算 token 数（按转写字符数估算），实际计费以服务商账单为准。1 小时直播（5 分钟窗口）约 12 次请求，每次输入约 3-5k token，用 glm-4-flash 这类低价模型单场成本通常低于 1 元。

## 音频来源选择方法

- **麦克风**：监控页 → 「开始麦克风监听」。可在下拉框选择具体设备（默认为系统默认麦克风）。适合主播本机自检。
- **系统声音**：监控页 → 「监听系统声音」。弹出屏幕共享选择框：
  - Windows 下选择要监听的**浏览器标签页**或**整个屏幕**，并**勾选“分享音频”**；
  - 用于监听直播伴侣/推流软件播放的声音（即观众听到的声音）；
  - 如果共享目标没有音频轨，应用会明确提示“共享目标没有提供音频”，不会假装在监听。

## 默认窗口和间隔设置

| 项目 | 默认值 | 可选值 |
|------|--------|--------|
| 分析间隔 | 60 秒 | 30 / 60 / 120 秒 |
| 分析窗口 | 5 分钟 | 3 / 5 / 10 分钟 |
| 请求超时 | 30 秒 | 自定义（毫秒） |
| 单场预算 | 10 次 | 自定义 |

间隔与窗口在「分析设置」页修改，保存后**下一次会话**生效。

## API 费用估算方法

- ASR：按音频时长计费（腾讯云控制台可查用量）。
- LLM：报告页「估算 token」= 转写中文字数 × 1.6 + 英文词数 × 1.3（输入近似值），输出每次约 500-1500 token。总请求次数见报告「LLM 请求次数」。

## API Key 存储方式

- 腾讯云密钥：SQLite 数据库 `settings` 表 `asr_config` 键（JSON）。
- LLM API Key：同一 `settings` 表 `llm_api_key` 键。
- 数据库文件位于 `%APPDATA%/ai-live-monitor/live-monitor.db`（本机用户目录，不上传）。
- **不会**出现在：日志文件、错误提示、界面明文（只显示脱敏尾部 4 位）、导出的报告、 Git 仓库。

## 常见错误和解决办法

| 错误 | 原因 | 解决 |
|------|------|------|
| `ASR_NOT_CONFIGURED` | 未配置腾讯云密钥 | 到分析设置页配置并保存 |
| `ASR_CONNECT_FAILED` | 密钥错误 / 未开通服务 / 网络问题 | 测试连接看具体提示；确认已开通实时识别 |
| `ASR_REMOTE_*` | ASR 服务返回错误码 | 看提示信息；常见为引擎参数或配额问题 |
| `LLM_CONFIG_INVALID` | LLM 三项配置不完整 | 检查 Base URL / 模型 / Key |
| `LLM_HTTP_ERROR` | 服务商拒绝（401/429 等） | 检查 Key 有效性、额度；应用只显示状态码不显示服务商原文，防止密钥泄漏 |
| `LLM_BAD_JSON` | 模型输出不符合约定 | 应用已自动重试一次；仍失败则该窗口跳过 LLM 分析（规则分析不受影响） |
| `CAPTURE_QUEUE_OVERFLOW` | 音频发送阻塞超过 10 秒 | 检查网络；会自动丢弃最旧数据继续 |
| 麦克风权限被拒绝 | 系统隐私设置 | Windows 设置 → 隐私 → 麦克风，允许桌面应用 |
| 共享目标没有提供音频 | 屏幕共享未勾选音频 | 重新共享并勾选「分享音频」 |
| 数据库无法打开 | better-sqlite3 ABI 不匹配 | 见上文 ABI 切换命令 |

## macOS 当前限制

- 未在 macOS 上做任何实测。
- 系统声音回环采集方案（getDisplayMedia 音频轨）在 macOS 的行为未验证。
- 打包只配置了 Windows NSIS 目标。

## 隐私说明

- 所有音频、转写、问题、报告数据只保存在本机 SQLite 数据库，不上传到任何第三方（除调用腾讯云 ASR 与你配置的 LLM 服务本身）。
- 音频不落盘（不保存原始音频文件）；只有转写文本入库。
- 密钥只存本机数据库，导出的报告经过密钥过滤测试（见 `tests/report.test.ts`）。
- 卸载应用不会自动删除数据库；如需清除请删除 `%APPDATA%/ai-live-monitor/`。

## 已知限制和第二阶段规划

已知限制（诚实声明）：
1. **真实 ASR/LLM 联调未完成**：开发机没有腾讯云/OpenAI 账号密钥，所有 ASR/LLM 相关验证基于 fixture 测试与签名单测。真实密钥环境下的 30 分钟连续转写、断网恢复、费用等验收项未执行。
2. **LLM 修复重试在预算计数上偏保守**：一次分析最多计 2 次请求。
3. **ASR 音频时长映射用启发式**：按 `audio_duration` 回推片段起止时间，真实联调时可能需要按腾讯返回字段校准。
4. **分析倒计时未精确显示**：UI 显示最近分析状态，精确到秒的倒计时需要主进程暴露调度器边界（第二阶段）。
5. **话术步骤覆盖检测未接入报告**：ScriptLoopState 已实现，但步骤覆盖状态未进报告页。

第二阶段规划：
1. 真实密钥端到端验收（麦克风 10 分钟 + 系统声音 10 分钟 + 断网恢复）。
2. 话术步骤覆盖状态进报告与实时提醒（步骤超时提醒）。
3. 精确分析倒计时与窗口进度条。
4. 多话术框架管理与切换。
5. macOS 打包与验证。

## 演示脚本

见 `demo/script.md`（3-5 分钟演示流程）。

## 测试说明

- 单元测试 46 个：`npm test`（vitest）。
- fixture 目录 `fixtures/` 覆盖：ASR 临时/稳态分离、断线重连、LLM 正常/超时/坏 JSON/伪造证据、话术框架样例。
- 所有 fixture 测试标注「模拟数据」；fixture 通过**不代表**真实 ASR/LLM 已验收。
