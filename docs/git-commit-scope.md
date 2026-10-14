# Git 提交范围建议（盯播统筹出具，供盯播负责人执行提交）

> 依据：2026-10-14 23:00 实测 `git status --porcelain`（分支 `ui/polish-visual-system`）。
> 结论先行：**evidence/ 建议进，scripts/ 下有 5 个探针有复现价值该进、其余为一次性调试残留该进 .gitignore。**
> 我已对仓库做过密钥模式 grep，未发现真实密钥明文（明细见第 4 节）。

## 1. 必进（无争议）

| 路径 | 理由 |
|---|---|
| `src/` 全部 | 交付物核心；含本轮新增 `main/security/runtimeConfig.ts`、`main/analysis/verifyRealWindow.ts`、`main/analysis/deduplicate.ts` |
| `tests/` 全部 | 含本轮新增 5 个测试文件（real-window-harness、runtime-config、report-speech-timing、asr-lifecycle、asr-session-boundaries、analysis-link-verify） |
| `package.json`、`package-lock.json` | 方案第 18 节要求锁文件与可复现构建；`package.json` 本轮改了 test/prepackage/build 三段 |
| `scripts/test-electron-node.js` | 测试入口，README 已引用 |
| `scripts/verify-electron-native.js` | 打包 native 闸门，README 已引用 |
| `scripts/tencent-live-probe.js` | 鉴权/上传连通性探针，README 已引用其边界 |
| `scripts/read-public-config.js` | 只读公开配置（LLM base_url/model）的来源，README 引用 |
| `README.md`、`demo/`、`fixtures/` | 交付文档与演示/夹具数据 |
| `docs/` | 4 份：audio-link-verification、runtime-integration-notes、主要工作说明、问题清单素材 |
| `electron-builder.json5`、`tsconfig*.json`、`vite.renderer.config.ts`、`.gitignore` | 构建配置（若已在版本控制内则确认无漂移） |

## 2. 建议进：evidence/（13 个文件，合计约 170 KB）

**判定：进。** 理由：

1. **它是本轮唯一的一级证据**，直接支撑"第①级已证"这个交付门槛结论——`lvl1-subtitles-20261014-224219.json`（5 条非空稳态、sessionId 190ba540、时间戳递增、UI/DB 逐字一致）与 `lvl1-20261014-223740.json`（正弦波 0 字幕对照 + 7 条稳态）被 README 与两份 docs 反复引用。不进仓库，交付物里的证据引用就是死链。
2. **无敏感信息（已实测扫描）**：13 个文件逐个人工 grep `AKID`、`sk-`、`DSH_SECRET`、`secretKey`、`secret_key`、`api_key`、`signature`、`password`、`Bearer` 全部零命中。
3. 内容只是：音频块电平统计（mean/peak/zeros/clip/nan）、UI 快照（字幕文本、chip 状态）、稳态片段（seq/text/startMs/endMs/conn）、播放源路径。**没有音频波形数据、没有密钥、没有用户个人信息。**
4. sessionId 是本地 SQLite 生成的 UUID，转写文本是中文 TTS 带货口播（合成语音），不涉及真实主播内容。

**建议同时进 `evidence/README.md`**（我可以写），说明每个文件是什么、对应哪条结论、哪个口径，避免半年后没人知道 `loopback-clean` 与 `loopback-click` 的区别。

**建议只进这 4 个主证据 + 1 个说明**，减小体积与噪音：

- `lvl1-subtitles-20261014-224219.json`（第①级主证据）
- `lvl1-20261014-223740.json`（已知信号对照）
- `final-20261014-223019.json` + `final-chunks-20261014-223019.json`（最终稳态 + 电平）
- `loopback-live-20261014-222300.json`（loopback 实采）

其余 8 个（`loopback-clean/click/signal`、`mic-win32`、`loopback-win32`、`capture-probe-*`）是过程探针，**可不进**——但若想保留完整过程链，全进也只 170 KB，我倾向全进 + README 说明。由你定。

## 3. scripts/ 下有复现价值的（建议进）

| 文件 | 复现价值 |
|---|---|
| `scripts/cdp-client.cjs` | CDP 客户端基础库，被多个 probe 复用，是"如何驱动真实 Electron 窗口验收"的公共设施 |
| `scripts/cdp.ps1` / `scripts/cdp-lib.ps1` | 同上，PowerShell 侧封装 |
| `scripts/nettest.cjs` | 网络连通性判别（DNS/HTTPS），复现 EAI_AGAIN 排查用 |
| `scripts/probe-live-loopback.ps1` | **本轮第①级证据的生成脚本**，README 引用的证据由它产出，必须进 |
| `scripts/probe-lvl1.ps1` / `scripts/probe-lvl1-sub.ps1` | 同上，lvl1 系列证据生成脚本 |
| `scripts/probe-loopback-live.ps1` / `probe-loopback-signal.ps1` / `probe-loopback-final.ps1` / `probe-loopback-clean.ps1` | loopback 系列验收脚本，覆盖"实采/正弦对照/最终稳态/干净环境"四种场景 |
| `scripts/probe-mic.ps1` / `scripts/probe-mic-win32.ps1` | 麦克风路径验收 |
| `scripts/probe-click-loopback.ps1` / `probe-click2.ps1` / `probe-win32-click.ps1` | 真实点击发起采集的验收（对应手势校验与旁路开关） |
| `scripts/probe-asr-live.js` | ASR 实时连接探针 |
| `scripts/probe-llm-live.js` / `scripts/probe-llm-settings.js` | LLM 真实请求探针 + 只读公开设置来源 |
| `scripts/probe-db-keys.js` / `scripts/db-probe.js` / `scripts/read-db.cjs` | 数据库只读检查（验证转写落库、设置键） |
| `scripts/probe-queue.cjs` / `scripts/probe-resampler.cjs` | 队列与重采样独立验证 |
| `scripts/probe-capture.cjs` | 采集链路探针 |
| `scripts/smoke-asr-transcript.js` / `scripts/smoke-capture-session.js` / `scripts/smoke-renderer.js` | 三个真实 Electron 冒烟脚本，README 有引用 |
| `scripts/start-app.ps1` | 带环境启动 app 的入口（演示/验收都要用） |
| `scripts/asr-bench/` | 延迟基准工具（bench.js、direct-probe*.js、loopback-drive.js、level2-drive.js、read-ui.js、reset-session.js、cdp.js） |
| `scripts/repro-e2e.js` | 端到端复现脚本 |

**其中 6 个是"证据生成器"，与 evidence/ 强绑定，优先进**：`probe-live-loopback.ps1`、`probe-lvl1.ps1`、`probe-lvl1-sub.ps1`、`probe-loopback-live.ps1`、`probe-loopback-signal.ps1`、`probe-loopback-final.ps1`。

## 4. 不进（一次性调试残留，进 .gitignore）

| 路径 | 理由 |
|---|---|
| `.verify-tmp/` | 验证过程临时目录 |
| `capture-probe-1791983232799.json`、`capture-probe-1791983260511.json` | 时间戳命名的临时抓取，已由 evidence/ 的规范命名取代 |
| `diag-out.txt`、`logs-electron.txt`、`logs-electron.err` | 日志输出 |
| `scripts/run2.cjs`、`scripts/run-diag.cjs` | 一次性运行入口，无说明无参数 |
| `scripts/probe-diag.cjs` | 诊断残留 |
| `scripts/probe-now.js`、`scripts/probe-now.log`、`scripts/probe-audio2.log`、`scripts/repro-e2e.log` | 早期探针与日志 |
| `scripts/probe-final.ps1` | 与 `probe-loopback-final.ps1` 重复且更早 |
| `scripts/probe-click2.ps1` | 与 `probe-click-loopback.ps1` 重复 |

**建议 .gitignore 追加**：

```gitignore
.verify-tmp/
capture-probe-*.json
diag-out.txt
logs-electron.*
*.log
scripts/run2.cjs
scripts/run-diag.cjs
scripts/probe-diag.cjs
scripts/probe-now.js
scripts/probe-final.ps1
scripts/probe-click2.ps1
scripts/repro-e2e.log
```

## 5. 密钥扫描结果（我已实测，供你复核）

对全仓（排除 node_modules）grep 以下模式：

```
AKID[0-9A-Za-z]{10,}    sk-[A-Za-z0-9]{8,}    SECRET_KEY    secretKey
secret_key              api[_-]?key           password      Bearer
```

**命中全部为代码与测试，无真实密钥明文**：

- `src/main/ipc.ts:44`、`src/main/security/errorFactory.ts:16`：脱敏正则的定义处。
- `src/main/asr/tencentSign.ts`、`src/main/asr/tencentAdapter.ts`、`src/main/analysis/llmClient.ts`、`src/main/ipc.ts:231/271/285`：读取 `process.env.DSH_SECRET_*`，**只读不写死**。
- `src/renderer/pages/SettingsPage.tsx`：界面文案提示需要环境变量。
- `README.md`：凭证表列出变量名（**只有名字，没有值**）。
- `tests/asr.test.ts:289`：`vi.stubEnv("DSH_SECRET_TENCENT_ASR_SECRET_KEY", "")`——空字符串。
- `tests/report.test.ts:114/123/124`：**假密钥** `AKIDxxxxxxxxxxxxxxxx`、`sk-abcdefgh12`、`sk-abcdef123456`，用于验证脱敏逻辑，不是真密钥。

**evidence/ 13 个文件逐个人工扫描，零命中。** 按红线，你提交前请再跑一次自己的 grep 复核。

## 6. 提交信息建议（分段，写清本轮修复范围）

```
fix(runtime): 环境凭证、系统声 handler、报告口径与测试入口

- 密钥改只读环境变量：新增 security/runtimeConfig.ts，界面移除三个密钥输入框，
  设置保存剥离密钥字段，getAsrStatus/getLlmStatus 不回显历史敏感配置
- Windows 系统声：main 进程注册 setDisplayMediaRequestHandler（主屏幕 + loopback），
  修复 getDisplayMedia 直接抛 NotSupportedError；手势旁路 AILIVE_ACCEPTANCE_NO_GESTURE_CAPTURE 默认关闭
- 报告口径：语音时段 SQL 别名修 snake_case/camelCase 断裂；语速改汉字+英文词双分母；
  ASR/LLM 连接与请求计数无持久化来源，返回 null 并标注「未统计」
- 测试入口：npm test 改走 electron-node（不切 ABI、不改写 native 二进制、单次 run），
  子进程清空 DSH_SECRET_*
- 打包：build.npmRebuild=false + electronVersion 锁定，prepackage 增加只读 native 闸门
- 测试：16 文件 157/157 通过；新增 real-window-harness / runtime-config / report-speech-timing 等
- 文档：README 重写（数据边界/凭证/音频源/报告口径/已知限制），docs 四份，evidence 一级证据
```

## 7. 提交前最后三项确认

1. **native 二进制不要进**：确认 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 在 .gitignore 覆盖范围（`node_modules/` 已覆盖，确认无例外）。
2. **`dist/`、`release*/`** 已被现有 .gitignore 覆盖，确认无漏。
3. **`demo/sample-framework.json`** 是新文件（未跟踪），内容为模拟商品资料，无敏感信息，**建议随 `demo/` 一起进**。
