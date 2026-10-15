# 问题、定位、修复与验证（incident-review）

> 交付物之四「问题清单」的**定稿之一**。素材来源：`docs/问题清单素材.md`、`docs/lessons-false-positive-outage.md`、
> `docs/audio-clock-anomaly.md`、`docs/asr-link-verification.md` §6.4.1、`docs/desktop-verification.md` 及各线验证报告。
>
> **记录规则**：每条问题必须能追溯到证据（commit / evidence 文件 / 测试文件）。无法追溯的写「未核实」，不编造。
> 早期材料的结论对应各自当时的 commit，**不代表当前 HEAD**；无法复现的标「历史」。

- 定稿时间：2026-10-15 01:2x（一轮）；**二轮追加于 2026-10-15 10:4x**
- HEAD：一轮 `556580e`（分支 `fix/real-asr-lvl1`）；**二轮收尾 `09ac468`**
- 当前基线：全量测试 **31 文件 / 355 项通过**（2026-10-15 10:0x 实测）

---

## 一、已修复且有验证证据

### INC-01 腾讯云 ASR 字段读错导致 0 字幕（最严重）

| 项 | 内容 |
|---|---|
| **现象** | 用户原话：「语音输入正常，聆听声音也有声音调整（电平条在跳），就是不显示字幕。」数据库 `transcript_segments` 0 条 |
| **根因** | 腾讯云实际返回 `result.index` / `result.voice_text_str`，原实现读 `result.slice_seq` / `result.result_text`，真实响应被解析为序号 0、空文本；去重判断 `seq <= lastSeqSeen` 又把同一句后续响应全丢弃 |
| **修复** | `src/main/asr/tencentAdapter.ts` 改读真实字段；允许同一句多次临时更新与最终定稿；忽略空文本/重复帧/过期句；新连接重置去重状态。`src/renderer/hooks/useMonitorState.ts` 临时字幕原地替换 |
| **验证** | 新增 5 项回归（`tests/asr.test.ts`）；真实腾讯云联调 10.815 秒已知语音 → 3 条最终字幕、落库与 UI 一致 |
| **证据** | `修复记录-实时字幕bug.md`、`交接文稿-实时字幕bug.md` |
| **基线** | 修复于 `b72d1b0` 之后的工作区；**历史**（该联调结果本轮未复现） |

### INC-02 ASR 连接生命周期 8 类缺陷

| # | 触发条件 | 缺陷 | 修复 |
|---|---|---|---|
| 1 | 握手阶段被服务端关闭 | 未 open 的 close 分支直接 return，不再重试 | 关闭后仍按退避重试；握手加 10 秒超时 |
| 2 | 停止时仍在握手 / 旧连接迟到事件 | 向未打开连接发结束帧；旧 close 清掉新 ws；旧 message 串入；定时器未清 | 握手中直接终止；按 socket 归属隔离事件；关闭即清定时器 |
| 3 | 暂停/结束时音频仍在 500ms 队列 | 句尾音频未发送即结束 | 重采样器加尾部 flush，按实时速率发完余量再发结束帧 |
| 4 | 暂停久恢复 / ASR 重连 | 切片时钟未重置，新连接字幕从 0 开始 | 恢复时重置切片时钟；连接时间映射到首个实际发送包 |
| 5 | 系统声音监听后暂停继续 | `doResume` 无条件调麦克风，音源被切 | 按会话音源恢复 |
| 6 | 连续点开始 / 开始被拒 | 重复采集；失败后轨道继续跑 | 同时只允许一个采集操作；失败释放轨道 |
| 7 | 断线时仍有临时字幕 | 临时字幕残留；错误状态未推送 | 非 connected 清理临时字幕；同步错误状态 |
| 8 | 旧会话 LLM 请求未结束就开新会话 | 迟到结果用可变 sessionId 写入新会话 | 分析任务固定原会话 ID |

- **验证**：新增 `tests/asr-lifecycle.test.ts`、`tests/asr-session-boundaries.test.ts` 共 9 项；修复前首次边界测试复现 7 个失败
- **证据**：`自查记录-实时字幕bug.md`
- **基线**：`b72d1b0` 之后工作区；**历史**（测试用例已并入当前套件）

### INC-03 better-sqlite3 ABI 乒乓（全组性阻塞）

| 项 | 内容 |
|---|---|
| **现象** | 三条连锁：① 本机 Node 24（ABI 137）与二进制（Electron ABI 130）不匹配，`npm test` 的 pretest 守卫尝试重建并**改写二进制**；② 重建被运行中的 electron 占用打出 `EBUSY`，测试跑不起来（表现为 34 个「红灯」，实为环境红灯）；③ 切回 Node ABI 后 `.forge-meta` 未清，builder 误判「已重建」跳过，把 Node ABI 二进制打进安装包，应用启动即崩 |
| **根因** | 单个二进制只能对应一个运行时，而「测试用 Node、运行/打包用 Electron」天然冲突 |
| **修复** | 删除 pretest 钩子；`npm test` 改走 `scripts/test-electron-node.js`，用 Electron 内置 Node（v20/modules 130）跑 vitest，**不切 ABI、不改写二进制** |
| **验证** | 执行前后 `better_sqlite3.node` SHA-256 一致；全量测试通过 |
| **证据** | `docs/runtime-integration-notes.md`、`scripts/test-electron-node.js`、`scripts/verify-electron-native.js` |
| **基线** | 全组统一命令后；**已修复** |

### INC-04 打包闸门与 `winCodeSign` 权限

- **现象**：① `@electron/rebuild` unlink 被占用 → EPERM；② winCodeSign 解压符号链接 → EPERM；③ `7za` 不在 PATH。
- **修复**：`build.npmRebuild:false` + `build.electronVersion:"33.4.11"`；新增只读闸门 `scripts/verify-electron-native.js`（真实加载 SQLite，正确 runtime exit 0 / 错误版本 exit 1 / hash 不变）；`build.win.sign:null`；PATH 加 `7zip-bin`。
- **验证**：闸门输出 `[native-gate] PASS Electron 33.4.11, ABI 130, win32/x64, SQLite 3.53.2`；`npm run package` exit 0，耗时 166.4 秒。
- **证据**：`docs/desktop-verification.md` 第二节。

### INC-05 密钥输入框移除后的编译期断裂（UI 残留）

- **现象**：删除密钥输入框后，`src/renderer/pages/SettingsPage.tsx` 第 93/102 行仍引用已删除的 `llmApiKey`，`tsc` 报 `TS2304`，renderer 与 main 两个 tsconfig 均 exit 2，**build 无法执行**。
- **性质**：**打包前的拦路虎；不是运行时 bug，是编译期断裂。**
- **根因**：删 UI 字段时漏删 `testLlm()` 里两处对该 state 的读取。
- **修复**：删除 `llmApiKey` state 及两处引用；`testLlm()`/`testAsr()` 改为只发 `{useStored:true}`；`doSave()` 只写公开配置；三个密钥输入框整块删除。
- **验证**：产物实测 `PASSWORD_INPUTS=0`；typecheck 双配置通过。
- **证据**：`docs/desktop-verification.md` §E。

### INC-06 `verifyIssues` 未拒「跨段拼接引文」

- **现象**：早期校验只检查 `quote` 是否存在于某个片段文本中，未要求它来自**单个**片段，导致把多个片段的文字拼起来也能通过。
- **修复**：`quote` 必须是**单个** `segment_id` 对应原文的连续子串；`segment_id` 不存在、改数字、跨段拼接、空引文**全部拒绝**。
- **验证**：`tests/llm.test.ts`、`tests/fixtures.test.ts`（`llm-fake-evidence` 夹具）；F 组硬验收「不存在 ID、改数字、跨段拼接、空引文全拒」。
- **证据**：`docs/analysis-link-verification.md` §2 F 行。

### INC-07 `metrics` 语速分子漏英文词

- **现象**：语速分子原只统计汉字，含英文的转写被低估。
- **修复**：`字词总量 = 汉字数 + 英文词数`，并输出**双分母**（除以有效讲话时长 / 除以总时长）。
- **验证**：`tests/analysis-link-verify.test.ts` C 组；`tests/report-speech-timing.test.ts` 真实 SQLite 时段 → 双分母报告。
- **证据**：`docs/analysis-link-verification.md` §6。

### INC-08 `computeStepCoverage` 步骤与阶段无映射

- **现象**：话术步骤覆盖统计与转写阶段之间无映射，覆盖结果不可信。
- **修复**：报告侧由 `replayScriptPhases` 重放稳态转写还原阶段区间（与实时同一台状态机）。
- **验证**：`tests/scriptCoverage.test.ts`（13 项，含「未配置框架时 script 为 null，不虚构数据」）。
- **证据**：`tests/scriptCoverage.test.ts`、`README.md` 测试说明节。

### INC-09 `runAnalysis` 每窗口重读框架、覆盖会话绑定

- **现象**：分析任务在运行中重新读取当前框架，会话切换后可能用新框架分析旧窗口。
- **修复**：分析任务**固定原会话 ID**；迟到结果只写入原会话，UI/摘要/运行状态按任务归属更新。
- **验证**：`tests/asr-session-boundaries.test.ts`「late LLM responses remain in their original session」；修复前该用例复现失败。
- **证据**：`docs/问题清单素材.md` INC-02 第 8 条来源、`tests/asr-session-boundaries.test.ts`。

### INC-10 `parseTencentMessage` 用 `audio_duration` 反推时间戳

- **现象**：片段起止时间按 `audio_duration` 启发式回推，非服务端真实字段。
- **修复**：服务端实际返回 `start_time` / `end_time`，改用真实字段；重连后把连接时间映射到首个实际发送音频包的会话时间。
- **验证**：`tests/asr.test.ts`「官方示例字段解析出文字、句序号和毫秒时间」；`tests/asr-session-boundaries.test.ts`「reconnected sentence timestamps refer to the session's actual audio position」。
- **证据**：`docs/asr-link-verification.md` §12.1（记录时间映射透传与 `gapDetected` 两处修复）。

### INC-11 去重键吞掉同片段多风险点

- **现象**：问题键设计不当时，同一片段内的多个不同风险点被合并成一条。
- **修复**：问题键 = `[type, stepId或null, 排序后 segmentIds]`（`src/main/analysis/deduplicate.ts`），类型不同即不同键；引文长短变化不改变问题身份。
- **验证**：`tests/storage.test.ts`「三个重叠窗口相同问题只产生一条持续记录」；`tests/analysis-link-verify.test.ts` B1 实测形成 3 个稳定键、重叠窗不重复提醒。
- **证据**：`docs/analysis-link-verification.md` §5。

### INC-12 `stalled` 判据在静默时误报（误判教训）

- **现象**：原判据为「`onaudioprocess` 回调停更 ≥3000ms」，该假设（回调按 ~85ms 稳定节拍）**从未被验证**；静默时回调本来就会变慢，与 `silent` 语义不可区分 → 可能把正常静默判成设备故障。
- **修复**：改读 `AudioContext.state`（`suspended`/`interrupted` → `stalled`；`running` 时**静默多久都不判 stalled**）；快速路径由「兜住所有非 ok 状态」改为显式白名单 `ended`/`muted`。
- **纪律**：**误判导致的真实中断，比漏判更严重**——漏判只是「该报的没报」，误判是系统主动掐断正常流程。
- **验证**：单测覆盖；**真实行为未实测**（见 INC-13 与 `docs/known-limitations.md`）。
- **证据**：`docs/lessons-false-positive-outage.md` §5.1/§5.2。

### INC-13 `ws.on("close")` 未接收 `code`/`reason` 导致断线无法诊断

- **现象**：只记录「已断开」，拿不到关闭码，无法区分正常结束、鉴权失败、还是服务端主动断。
- **修复**：`close` 回调接收 `code`/`reason` 并透传到错误对象（`gapDetected`/`closeCode`/`closeReason` 可观测性）。
- **证据**：`docs/asr-link-verification.md` §0.1 关于 `0d7b9f6` 的记录。

### INC-14 会话结束后界面状态机不收敛、采集不停

- **现象**：自动结束时界面仍显示在录制；会话结束后采集未停。
- **修复**：会话结束状态收敛 + 采集停止；`tests/ready-gate.test.ts` 覆盖「到点自动结束：写 `end_reason=schedule-window-end` 且向用户提示原因」「自动结束后也广播 null」。
- **证据**：提交 `530156e`（收口）、`556580e`（历史页显示结束方式）；`tests/ready-gate.test.ts`、`tests/end-reason-label.test.ts`。

### INC-15 导出工件 `sourceLabel` 假标签

- **现象**：导出工件声称的音频来源与实际不符（**声称「真实直播」实为 TTS**）。
- **修复**：导出工件样本标注落到 HTML；来源标签必须反映实际音源。
- **证据**：提交 `530156e`（「导出工件样本标注落到 HTML」）。

---

## 二、数据与证据污染（引用纪律）

### CONT-01 会话 `2920b432` 混合会话被当作「真实直播样本」

| 区间 | 时长 | 内容性质 | 可用性 |
|---|---|---|---|
| 0 ~ 124.8s | 124.8s | 降糖保健品广告口播（干净） | ✅ **唯一可用区间** |
| 124.4 ~ 174.2s | 49.8s | **无音频**（音源切换间隙） | ⛔ 不是静默，是**没有音源** |
| 174.2 ~ 742.4s | 568.2s | 带货 TTS（他人注入） | ⛔ 非真实直播 |

- **事故经过**：脚本只关 WebSocket 未点「结束」，残留会话持续采集，把另一成员播放的 TTS 测试音采进同一 session（4 条干净片段 → 44 条混合）。
- **两条关键更正**：① 那个 49.8s **不是「真实直播最长静默」**，是音源切换间隙；干净窗口内最长 VAD 空隙仅 **0.4s**（n=1）。② 流标签 `cctv13hd.m3u8` **不等于**内容性质——实播为降糖保健品广告口播，**不是新闻**。
- **修复**：脚本收尾改为**显式点「结束」并等待落库 `stopped`**；新增 `Test-DualPipelineRisk` 等前置检查。
- **引用纪律（全组生效）**：引用任何会话的**统计**必须同时标注**所属时间区间**；**只写 sessionId 的引用一律视为无效引用**。
- **影响面**：第②级结论（只引用前 124.8 秒干净区间）**成立**；「44 条 / 15 分钟」等统计**作废**。
- **证据**：`docs/asr-link-verification.md` §6.3/§6.4.1、`evidence/session-profiles.json`。

### CONT-02 干净的「真实带货直播」样本 = 0 场

- 全库核查结论：单音源会话多为 **TTS 测试音**、**影视剧对白**（`b217299a`）、**文化讲解**（`f941151f`），另有 1 个内容性质未定（`d61e4b32`）。
- 因此**不能**声称「已用真实带货直播验证」。真实 LLM 调用的两轮来源（广告口播 + TTS）**都不是带货直播**。
- **证据**：`docs/asr-link-verification.md` §6.4.1、`docs/analysis-link-verification.md` 首页。

### CONT-03 音频时间轴快于墙钟（根因：探针脚本双管线，**非产品 bug**）

- **现象**：`speech_intervals` 跨度超过会话墙钟（`5970a6d6` 比值 1.69、`d61e4b32` 1.27，其余 6 个会话 0.74~1.00 正常）。
- **根因**：`scripts/probe-persist5.ps1` 同时起了两条采集管线（自建 `getDisplayMedia` + 点 app 按钮），同一份音频被送两遍，`PcmResamplerSlicer.nextStartMs` 按样本数累加跑到墙钟前面。
- **证据（三条闭合）**：① 静态扫描该脚本是唯一双入口；② 时间吻合（脚本修改时间晚于两个异常会话起始）；③ 定量闭合——自建管线单独贡献 313.1s ≈ 1.0 倍，而 DB 跑到 551.2s，差额 238s 必须有第二来源。
- **修复**：脚本移除自建管线只走 app 按钮；新增运行时断言（比值 > 1.1 报警）+ 启动前静态双管线检查。
- **边界（必须守住）**：「普通按钮路径绝不会有此问题」目前**只有 6 个正常会话的旁证，不构成实测支撑**，仍需一次真实按钮路径的正面验证。
- **证据**：`docs/audio-clock-anomaly.md`。

### CONT-04 误判三条因果链（方法教训）

一次 30 分钟长跑（session `f941151f`）82 秒结束，三个成员各自从单一现象跳到因果，**三条都错**：

| 谁 | 编出的根因 | 错在哪 |
|---|---|---|
| 实时转写 | 健康检查把静默误判成设备故障 | 未核对数据库，事后撤回 |
| 音频采集 | 自己的 `stalled` 误判掐断 ASR | 未核对 `ended_at`，用 `asr=closed` 倒推因果 |
| 盯播负责人 | 由流标签推断为「CCTV-13 新闻直播」 | 未核实实际内容（实播广告口播） |

- **真相**：`track` 的 `ended` 事件正常触发 `handleCaptureEnded()` → `status=stopped`，**行为正确，未发生误判中断**。
- **纪律**：① 判据正确性不能只测「该不该触发」，必须验证「正常场景会不会误触发」；② 故障路径必须留可观测痕迹。
- **证据**：`docs/lessons-false-positive-outage.md` §1–§4。

---

## 三、成员/环境类（非产品缺陷，影响交付过程）

| 编号 | 事件 | 性质 | 处置 |
|---|---|---|---|
| ENV-01 | 音频采集成员模型调用 `PI_AI_ERROR Provider finish_reason:error` | **成员服务失败**，非产品采集失败 | 未立即重试、未全员暂停；由实时转写线只读接续 |
| ENV-02 | 全局 `Stop-Process` 杀进程（负责人与统筹各一次） | 协作过程问题 | 已立规：**禁止全局 kill，只操作自己记录的 PID** |
| ENV-03 | pretest 自动切 ABI 中断他人实测 | 环境机制问题 | 已移除钩子（并入 INC-03） |
| ENV-04 | 本机默认输出为 VB-CABLE | 环境事实 | 已在报告中如实披露音频路由跳线 |

---

## 三补、二轮（2026-10-15 上午）已修复且有验证证据

### INC-16 数字簇截断导致证据造假（最严重）

| 项 | 内容 |
|---|---|
| **现象** | 规则 `\d小时` 命中「保温25小时」的「5小时」→ quote 变成 **"保温二十五小时"**——规则根本没匹配的「保温」被当成证据报给用户。这不是引文失真，是**证据造假**：报的是凭空多出来的文字。 |
| **根因** | `normalizeDigits` 把中文数字簇（如「二十五」）折成阿拉伯数字「25」时，簇内**每个字符的 map 全指向簇起点**。反查只用 `map[m.index]` 和 `map[end]` 还原原文区间，命中只覆盖簇的一部分时，会把整个簇圈进 quote。 |
| **修复** | `src/main/analysis/ruleEngine.ts`：`NormalizedText` 新增 `clusters` 字段记录簇区间；命中后新增**数字簇截断守卫**——命中区间与数字簇**只接受「完整包含」或「完全不相交」，部分相交则丢弃**。`RuleHit` 新增 `numeralNormalized?: boolean` 标注命中来自中文数字折叠。`tests/ruleEngine-numerals.test.ts` 23 条测试钉住守卫与边界（含"零不折叠""三零五是单簇折成305"两条反直觉正面用例）。 |
| **验证** | 全量 330/330（当时）→ 355/355（收尾）；typecheck 双端 0 错误。抛针构造实测守卫只在「真的截断」时出手（`\d+小时` 贪婪覆盖整簇 → 不被拦、quote 正确）。 |
| **证据** | `ceaed12`、`tests/ruleEngine-numerals.test.ts` |
| **能力边界（必须写明）** | `numeralNormalized` 只能识别「写法被转」（中文数字→阿拉伯数字），**不能识别「数字被改」**（如 ASR 把「七天」识成「一天」）——规则对两者都命中，quote 忠实反映被改后的原文。 |

### INC-17 LLM 429 被重试烧额度

| 项 | 内容 |
|---|---|
| **现象** | HTTP 429（限流/配额耗尽）被当成「可重试」，重试循环更快耗尽剩余额度。 |
| **根因** | `src/main/analysis/llmClient.ts` 闸门用**黑名单**（列举不可重试错误码），任何新错误码默认都会被重试——429 从未进过黑名单。 |
| **修复** | `948186c`：改为**白名单**——`retryable` 由产生错误的那一处声明（`classifyHttpStatus` / `requestCompletion`），只有 `retryable === true` 才重试。实测当前不重试集合：401 / 402 / 403 / 429 / 501 / 505 / 通类 client error；重试集合：`ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` / 5xx。 |
| **价值** | 修的是**一类问题**（默认拒绝重试），不是一个症状——以后新增不可重试错误码不可能再漏。 |
| **验证** | `tests/analysis-link-verify.test.ts` H 组；`948186c`；typecheck 0 错误。 |
| **已知 flaky** | H8（deadline 到点后不再空转重试）偶发单跑红、复跑即绿，**他人文件、非本次改动引入**，见第四节。 |

### INC-18 报告用错话术框架

| 项 | 内容 |
|---|---|
| **现象** | 历史报告用默认框架分析，而非用户配置的框架；用户无法从报告看出用的是哪个框架。 |
| **根因** | `src/main/analysis/orchestrator.ts` 每窗口重读框架，会话切换后可能用新框架分析旧窗口；store 无 `getFramework` 封装，框架来源不可追溯。 |
| **修复** | `948186c`：store 新增 `getFramework(frameworkId)`；报告侧选框架四级优先级；`shared/contracts.ts` `ScriptReport` 新增三态 `frameworkSource`（**实测值域为 `"session-bound" \| "fallback-unrecorded" \| "fallback-deleted"`**，不是 `"session"/"explicit"/"default"/"none"`，此处以代码为准）；HTML 与 JSON 都能读到来源。 |
| **核心价值** | 把「文案标注」升级成「契约字段」——原设计只在 HTML 加一句提示，**JSON 和 UI 都读不到**，下游无从判断。 |
| **验证** | `tests/storage.test.ts` 新增 `getFramework`；`tests/analysis-link-verify.test.ts` D 组。 |
| **证据** | `948186c`、`src/shared/contracts.ts` `frameworkSource` 行 |

### INC-19 ASR 断线缺口全程丢失

- **现象**：ASR 断线期间无字幕，用户分不清「主播没说话」和「断了没录上」。
- **根因**：断线后重连前的间隙在时间轴上**根本不存在**，前端也无提示。
- **修复**：断线期间插入标记片段（`gapDetected`），时间轴连续，缺口可见。
- **验证**：`tests/asr-lifecycle.test.ts`、`tests/asr-session-boundaries.test.ts`。
- **证据**：`docs/asr-link-verification.md` §12.1（`gapDetected` 透传）。

### INC-20 高频错误刷屏

- **现象**：`CAPTURE_QUEUE_OVERFLOW`、`PRE_START_BUFFER_OVERFLOW`、`PRE_START_BUFFER_PARTIAL` 按音频帧约 85ms 一次触发，淹没关键提示。
- **修复**：节流——首次立即报，之后每 60 秒最多一条；累计次数经 `getErrorCount(code)` 供 UI 读取，**次数不丢失**。
- **验证**：`tests/ready-gate.test.ts`「高频错误节流」「不同错误码各自独立节流」。

### INC-21 没做语义分析却记 success

- **现象**：未配置 LLM 时，分析窗口仍记 `success`，报告把「没做」当成「成功」。
- **修复**：`src/main/analysis/orchestrator.ts`：`llmState === "not_configured"` 时跳过 LLM 分支，该窗口记 `skipped` 而非 `success`。
- **验证**：`tests/ready-gate.test.ts`「未做语义分析不得记 success」。

### INC-22 设备选择无记忆

- **现象**：用户选过的系统声音设备下次启动不记忆，需重新选。
- **修复**：`804a1c4`：`shared/contracts.ts` `Settings` 新增 `audioDeviceId?: string | null`（**注释说明为何不许空串**）；`resolveStoredDevice` 实现优先级（存储 ID → 默认设备 → 空）；`MonitorPage.tsx` 保存选择。
- **验证**：四条路径实测（首次选 / 重启恢复 / 切换 / 再重启）；`scripts/verify-device-mem.js`。
- **附带修正**：修探针时发现探针自身污染被测状态（自己送音频给状态机），已修。

### INC-23 `captureSelectDevice` 假通道

- **现象**：`captureSelectDevice` 含三层死通道（未使用的冗余实现），维护负担且误导阅读。
- **修复**：`ca00342`：整体移除三层死通道，只保留按钮路径；探针删掉给死通道用的桩。
- **验证**：全量通过，typecheck 0 错误。

### INC-24 暂停恢复泄漏 —— ✅ **已证伪，不修**

- **现象**：负责人怀疑 `doResume` 恢复时泄漏音源。
- **结论**：实时转写用探针实测证伪，**无泄漏**。记录为**已证伪**，不是未修复缺陷——不要当成待修项列进「未修复清单」。

### INC-25 `metrics` 时间基失真

- **现象**：`speechMs` / `charsPerSpeechMinute` / `longestSilenceMs` 在采集异常时失真；`charsPerTotalMinute` / 总字数 / `paceChanges` / 重复度安全。
- **根因**：窗口是**墙钟**、区间是**音频轴**，越界的讲话被**整段裁掉**，因此不是简单乘一个系数。
- **四场景实测**（构造输入，非真实会话回放）：讲话在中段 → `speechMs` 30000→**25350（0.845×，跌）**；均匀铺满 → 1.127×；全在尾部 → **0（语速归零）**；窗口也随音频轴放大（纯缩放）→ **1.690×**。
- **关键结论**：1.69 倍**只在「窗口也跟着音频轴放大」的假想场景成立**，真实链路窗口是墙钟，不会出现。**禁止写「可能偏高 1.69 倍」**——真实失真方向取决于讲话分布，可能高也可能低。
- **最危险形态**：讲话全被推出窗口 → 语速 0、最长静音 = 整个窗口。**「语速 0」「整场全是静默」这两个看起来像事实的结论，可能只是漂移的产物。**
- **修复**：`094e935`：`src/main/analysis/metrics.ts` 逐字段标注时间基契约（安全/失真）；新建 `docs/metrics-timebase.md`。
- **验证**：`tests/metrics-timebase.test.ts` 10 条测试；全量 340/340（当时）→ 355/355。
- **证据**：`094e935`、`docs/metrics-timebase.md`。

### INC-26 `cta` 排序与 `STEP_PHASE_KEYWORDS` 口径不一致

- **现象**：同一文件 `ruleEngine.ts` 两个常量做同一件事（关键词→阶段），但 `cta` 位置相反——`STEP_PHASE_KEYWORDS` 排第一（有注释「价格/售后类步骤名常含『介绍』，避免误归」），`PHASE_TRIGGERS` 排最后。重构时改了一个没改另一个。
- **后果**：「今天介绍这款产品，大家点击小黄车下单」判成 `productIntro`，应为 `cta`——**主播明明在促单，报告记成产品介绍**。
- **修复**：`09ac468`：`PHASE_TRIGGERS` 重排为 `cta → opening → productIntro`，补同口径注释。
- **验证**：`tests/step-phase-order.test.ts` 7/7、`tests/ruleEngine-triggers.test.ts` 8/8、全量 355/355。

### INC-27 `.*号链接` 误报

- **现象**：「型号链接不对」「下一号链接哦」这类与促单无关的文本也判成 `cta`。
- **根因**：`.*号链接` 的 `.*` 前缀让它匹配任意位置的「号链接」。
- **修复**：`09ac468`：收紧为 `/下单|拍.*链接|点击.*(小黄车|购物车)|(?<![下上这那哪])[一二三四五六七八九十\d]+号链接/`——要求「号」前是数字，且前面不能是「下/上/这/那/哪」等指示词（排除序数「下一个」）。
- **迭代过程**：第一版只加数字要求，被实时转写的测试抓到漏网「下一号链接哦」，补负向前查才修完。**测试用例比第一版实现想得更全。**
- **验证**：`tests/ruleEngine-triggers.test.ts` 5 个误报用例全过。

### INC-28 标点打断数字-单位失配 —— **决策：不修**

- **现象**：「保温二十五**，**小时」「改善80**。**%」不命中，而「3.5折」正常（小数点是数字的一部分，不是打断）。
- **归因**：**两者皆有**——上游 ASR 插入原文没有的标点 + 规则 `\s*` 只容忍空白。
- **决策**：**不修**。加 `[，。、]?` 会让「改善80。%」这类 ASR 怪写法也被报成问题，属于**用误报换召回**。按「宁可漏报，不可误报」的纪律取舍。
- **证据**：`tests/ruleEngine-triggers.test.ts`「标点打断不命中」「3.5折正常命中」两条正面测试。

### INC-29 20 条默认规则漏报 —— **决策：不补**

- **实测漏报**：`七天无理由退换`、`无效退款`、`假一赔十`、`立竿见影`、`药到病除`、`零添加`、`纯天然`、`无副作用`、`孕妇可以用`、`明星同款`、`医生推荐` 等约 20 条。
- **决策**：**不补正则**。补正则的代价是误报，而误报摧毁信任。这 20 条只钉住「当前确实漏」这个事实，作为后续是否补的依据，**不是缺陷**。
- **其中一条需说明**：`只剩最后3件` 不命中，是**纯正则写法问题**（规则要求「只剩」紧贴数字，「最后」插在中间即失配），**不是归一化问题**——该文本里没有中文数字簇。
- **证据**：`tests/ruleEngine-numerals.test.ts` 注释。

---

## 四、未修复 / 未核实（诚实声明）

| 项 | 状态 |
|---|---|
| 错误渲染进程时间戳与「音频快于墙钟」的正面验证 | **未实测**（需一次 60~90 秒真实按钮路径采集，需额度） |
| `stalled` 新判据的真实行为 | **仅单测覆盖，未实测** |
| loopback track 在默认输出切换时的行为 | **未实测**（COM 接口不可用，无法脚本化切设备） |
| 真实抖音直播内容源端到端 | **未实测**（用户侧阻塞：需开浏览器面板） |
| 误报/漏报抽检 20 条真实候选 | **未实测**（`reviewedRealCandidates=0`） |
| 历史遗留明文密钥记录 | **未清理**（运行链路已不读取，但未删除） |
| 早期 10.815 秒人声 → 3 条字幕 | **历史**，本轮未复现 |
| `analysis-link-verify.test.ts` H8 偶发失败 | **flaky（未修）**：单跑红、复跑即绿，非本次改动文件引入。一个 flaky 测试会训练团队忽略失败，**待修** |
| INC-29 那 20 条规则漏报 | **有意取舍，不是缺陷**（误报代价高于漏报），后续是否补需误报率数据支撑 |
| INC-28 标点打断失配 | **有意取舍，不是缺陷** |
| `numeralNormalized` 识别「数字被改」 | **能力边界，非缺陷**：只能识别写法被转，不能识别 ASR 把数字识别错 |
| INC-24 暂停恢复泄漏 | ✅ **已证伪，不修**，不是待修项 |
| 二轮全部结论的构造输入而非真实会话 | 数字簇守卫、metrics 四场景均来自**构造输入**，不是真实会话回放 |

---

## 五、本轮最值得记录的三条教训

1. **误判比漏判危险**：误判会主动掐断正常流程，且用户无从知晓。判据必须验证「正常场景不误触发」。
2. **从单一现象跳到因果是通病**：本次三个成员各犯一次；正解是先查数据库里最直接的事实（`status`/`ended_at`）。
3. **不结束会话 = 采集不停 = 后续任何声音都进同一 session**：残留会话会静默吞掉他人音频并持续计费（实测有会话挂 622 分钟）。

## 六、二轮最值得记录的四条教训

1. **凭印象写断言，是「注释与代码相反」的同源病**：实时转写凭推理写三条测试断言（「零」是否折叠、「三零五」是否三个簇、「只剩最后3件」是否命中），**全被探针证伪**。修法是先写探针跑出实测行为，再定断言。
2. **宁丢命中，不可造证据**：数字簇截断意味着规则没匹配的文字可能被当成证据报给用户。宁可漏报一条，不可报错一条——这正是我们做逐字证据校验的全部意义。
3. **同一个文件里两个常量做同一件事，必须口径一致**：`STEP_PHASE_KEYWORDS` 把 cta 排第一并写了注释说明理由，`PHASE_TRIGGERS` 却排最后。**当初有人想清楚了才排的序，只改了一个常量，漏了另一个。**
4. **汇报前最后一步才取 HEAD，取完立刻写进消息**：成员提出，比「注明测得时刻」更根本。加时间戳是让别人能对账，汇报前重取是自己就不给错值——两个一起用。
5. **负责人的错误，成员用证据纠正了三次**：`speechMs` 1.69 倍（被实测推翻）、「`step-phase-order.test.ts` 是话术分析建的」（实为从草稿转成）、「`getFramework` 已存在」（grep 扫的是工作树）。**看到行号就以为在库里，与「凭印象不读代码」是同一种错误。**
