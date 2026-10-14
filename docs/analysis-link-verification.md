# 话术分析与 LLM 链路验证（P1-1）

负责人：话术分析；汇报对象：盯播负责人。工程：`D:\ai盯播工具\app`。

验证时间：2026-10-14，Asia/Shanghai。最新全量测试开始于 22:36:44，Windows / Electron 内置 Node / Vitest 2.1.9；16 文件、157 项全部通过，其中分析专项 51 项、真实窗口脚本模拟测试 3 项全部通过。22:36:44 双端 typecheck 通过。

**结论：A–H 的本地逻辑和故障场景已验证，发现的问题已在分析模块修复。真实供应商 LLM 调用、真实音频语义诊断和至少 20 个真实候选抽检均未实测，不能据此宣称产品真实链路全部验收。macOS 未实测。**

## 1. 验证范围和证据等级

本次只修改以下源码，不修改 capture/、asr/、storage/、report/、共享契约和其它页面：

- `src/main/analysis/windowScheduler.ts`
- `src/main/analysis/metrics.ts`
- `src/main/analysis/ruleEngine.ts`
- `src/main/analysis/llmClient.ts`
- `src/main/analysis/orchestrator.ts`
- 新增 `src/main/analysis/deduplicate.ts`
- 新增 `src/main/analysis/verifyRealWindow.ts`（只读真实来源库的验证脚本）

测试：重写本人的 `tests/analysis-link-verify.test.ts`，新增 `tests/real-window-harness.test.ts`（2 项，模拟来源/模拟服务），经授权调整 `tests/fixtures.test.ts` 的 Prompt 约束断言。`tests/asr-session-boundaries.test.ts` 保留原行为断言，未删除或降低要求，5 项全部通过。

盯播负责人同时维护 runtimeConfig、存储区间字段别名、报告双语统计及凭据测试；本报告不将这些改动记作话术分析的代码产出。

证据分为三类：

1. **本机代码实跑：**实际执行 TypeScript 函数、主调度、内存 SQLite、IPC 事件替身、PCM VAD 和 Zod 校验。
2. **故障模拟：**LLM 响应通过 fetch mock 构造；20 秒通过 Vitest 虚拟时钟推进；40 分钟通过会话时间重放。没有调用真实供应商，不代表真实 40 分钟监听或真实 20 秒网络请求。
3. **未实测：**真实主播录播识别、真实 LLM 语义能力、误报漏报率、macOS。

## 2. A–H 验收结论

| 项目 | 明确结论 | 主要证据 | 实测边界 |
|---|---|---|---|
| A 窗口调度 | 本地验证通过 | A1 40 分钟模拟节拍、A2 延迟 tick、A3 SQL 相交边界、A4/A5 参数枚举 | 真实连续监听节拍抖动未实测 |
| B 重叠去重 | 本地验证通过 | B1 实际 orchestrator + SQLite 连跑三个 300 秒重叠窗，UI 仅新增一次；B2 步骤和证据键 | 换证据仍同一语义问题的跨片段合并不是本次实现 |
| C 双语双分母与 VAD | 分析端通过 | C1 实际输出断言；C2 区间归并；C3 PCM 入库；C4 静音 | 真实背景音乐/噪声条件下 VAD 准确率未实测；最终 UI 展示由负责人验收 |
| D 规则引擎 | 候选检测覆盖通过 | D1 五种绝对化、D2 七种数字风险、D3 自定义禁词/启停/非法正则 | 命中仅为风险候选，词法规则不能核实商品事实或认定违法 |
| E Prompt 与 Schema | 本地请求处理链路通过 | E1 枚举/时间/步骤；E2 真步骤和指标输入；E3/E4 单次修复 | 实际模型遵循 Prompt 的效果未实测 |
| F 幻觉防护 | 硬验收本地通过 | 不存在 ID、改数字、跨段拼接、空引文全拒；F5 坏响应真实进入 orchestrator 后不入问题库、不发问题事件 | 逐字证据校验不能保证模型的语义推理正确，仍需人工抽检 |
| G 超时与队列 | 故障模拟通过 | G1 整轮 20 秒封顶、G2 单并发合并、G3 下一轮恢复、G4 timeout 持久化 | 虚拟时钟验证，真实供应商网络延迟未实测 |
| H 单场预算 | 本地验证通过 | H1 修复不得越界、H2 失败/重试计数、H3 新场重置 | 预算单位为请求次数，不是人民币、美元或 token |

统一命令见第 3 节；单项可在专项命令后添加 `-t "A 窗口调度"`、`-t "B 真实调度"` 等标题进行过滤。

## 3. 可复现命令和当前构建状态

在工程目录中执行，确保环境变量只在进程内使用，不打印值：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\node_modules\vitest\vitest.mjs" run
```

专项：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\node_modules\vitest\vitest.mjs" run tests/analysis-link-verify.test.ts
```

类型检查和构建：

```powershell
cmd /c npm run typecheck
cmd /c npm run build
```

| 检查 | 实际结果 |
|---|---|
| 22:36:44 最新全量测试 | 16 文件，157/157 通过，1.67 秒 |
| 分析专项与脚本模拟测试 | 51/51、3/3 通过 |
| 22:36:44 最新双端 typecheck | 通过 |
| 22:06:14 此前全量测试 | 15 文件，154/154 通过，1.53 秒 |
| 22:01 前后双端 typecheck | 通过 |
| 后续 Vite + 主进程 build | 通过；Vite 输出 50 模块、940ms，主进程 tsc 完成 |
| 22:06 历史并行 typecheck | 当时被负责人编辑中的 SettingsPage.tsx:93/102 未定义 llmApiKey 阻断；已上报，22:14:15 最新双端检查通过 |

构建/类型检查记录对应执行时的文件版本；不把此前检查冒充并行编辑后的最终合并结果。

凭据策略改造由盯播负责人完成：`tests/orchestrator-llm-key.test.ts` 改为验证「公开配置＋环境密钥组成配置、忽略数据库旧密钥」和「环境密钥缺失时不启用 LLM、不回读数据库旧密钥」，并新增「ASR 握手挂起仍立即启动调度器和计时器」与「暂停断开 ASR、恢复从环境重连」两条真实路径用例，4/4 通过；`tests/runtime-config.test.ts` 验证 settings.save 不落盘密钥、settings.get 不回显历史敏感字段。本角色未再修改该凭据基线文件，也未在 orchestrator 做重复的字段归一化——`grep` 确认分析层只调用 `store.querySpeechIntervals`，无 snake_case 转换代码，无需回滚。

环境事故记录：首次直接用系统 Node 24 跑 Vitest，原生 SQLite 的 ABI 不匹配；一次 prebuild-install 尝试报告 EBUSY，随后发现二进制已变为 Node ABI。已用预先备份恢复 Electron ABI，之后 Electron 内置 Node 的全量测试通过。未关闭正在音频实测的 Electron 进程。之后不再切 ABI、不改 node_modules、不重装依赖；项目测试脚本由盯播负责人维护。

## 4. A：冻结窗口和稳定边界

调度以固定 `nextBoundary` 递增，不以完成分析的时间重新计算下一边界。默认间隔 60,000ms、窗口 300,000ms。

A1 的正常异步 tick 重放会在每次调用后释放微任务。40 分钟内实际获得 40 个窗口，首窗 `[0,60000]`、第六窗 `[60000,360000]`、最后窗 `[2100000,2400000]`，跳过数为 0。

A2 单次 `tick(185000)` 只允许 60、120、180 秒三个历史边界。由于单运行加单待处理，会实际执行 60 秒窗和最新 180 秒窗，120 秒窗被替换，跳过数为 1；不会生成未来 240 秒窗。

查询在分析开始前使用冻结的 `startMs/endMs` 下推 SQLite，条件为 `start_ms < window_end AND end_ms > window_start`。内存过滤条件一致。A3 验证跨左右边界均纳入，恰好碰到边界但没有重叠的片段排除，文本不切割。

修复内容：恢复方案规定的单待处理，撤回错误 FIFO 尝试；填入唯一待处理槽位不计为跳过，仅替换已存在的槽位计数；异常不会造成未处理 Promise 拒绝或阻止下轮；状态报告含累计跳过数。

## 5. B：证据键与重复提醒

新问题键：`JSON.stringify([type, stepId或null, 去重排序后的segmentIds])`，由 `deduplicate.ts` 统一生成。引文长短变化不会改变问题身份；不同话术步骤仍能区分。

B1 使用真实 orchestrator 跑 `[0,300000]`、`[60000,360000]`、`[120000,420000]`。输入是同一片段 `risk`：285000–325000ms，原文 `全网最低价，保证所有人满意`（**模拟转写**）。

样例同时包含默认绝对化规则（stepId=null）、框架绝对化规则（stepId=facts）和禁词规则。实际形成 3 个稳定问题键；每轮再次命中更新 occurrence_count，数据库始终 3 条，`analysis.issues` 的新增问题总数始终 3，不在重叠窗重复提醒。

first_seen_ms 保持 285000，last_seen_ms 为同一证据的 325000；这两字段表示证据起止，不是“最后一次模型调用”的墙上时间。不同证据 ID 将形成不同键；把多个新片段的同一持续语义问题合为一个事件，仍需额外事件聚合策略，未宣称已完成。

修复原测试：片段序号自增，避免 SQLite `UNIQUE(connection_id,source_seq,is_final)` 忽略后续片段；原来第三个 60 秒小窗并不与片段相交，已改为实际 300 秒滑窗；不再把所有规则 hits 强制写成 bannedWord 或手造错误键。

## 6. C：客观指标和 VAD

实际公式：

```text
字词总量 = 汉字数 + 英文词数
讲话字词/分钟 = 字词总量 / (speechMs / 60000)
总时字词/分钟 = 字词总量 / (totalMs / 60000)
```

C1 使用两段模拟文字，共 40 汉字、6 英文词。有效讲话 120000ms，总时间 180000ms；实际字段输出为讲话 23 字词/分钟、总时约 15.333 字词/分钟。测试直接断言两个输出字段，不再仅自行计算正确表达式。

C3 把真实数值 PCM 数组通过 orchestrator.ingestAudio 输入：16kHz 下 200ms 高能量与 200ms 全零。实际 VAD 入库一条 `[0,200]`，讲话分母为 200ms。**这里的 PCM 是人工构造波形，非真实主播录音。**

修复：从 PCM 包实时提取 VAD 区间，删除把 ASR final 片段跨度冒充讲话时长的写入；不足整包的尾部 flush 也提取 VAD。区间按窗裁剪、排序、归并，重叠不重复计时，小于 200ms 的停顿可合并。汉字和英文词同时进入双分母。

存储返回区间的 snake_case/camelCase 问题已上报，由盯播负责人在 storage 层修复；本模块使用契约字段，未做重复归一化。双分母报告展示由其负责。

限制：当前 VAD 为 Int16 平均绝对能量阈值 500；背景音乐与强噪声可能误判。语速突变沿用 5 秒片段桶近似，并非逐字对齐的精确说话速度；短桶和长 ASR 段均需真实校准。跨边界完整文本配合裁剪讲话时长可能有边界统计偏差，应标识该口径。

## 7. D：规则规格和命中样例

| 规则类型 | 默认或框架内容 | 输入原文（模拟） | 候选引文 |
|---|---|---|---|
| 禁用词 | 用户框架正则 | 全网最低 | 全网最低 |
| 绝对化 | 保证、绝对、百分之百、所有人、七天见效等 | 保证 | 保证 |
| 价格数字 | 原价及只要/只卖/现价，允许小数 | 原价399.9 / 只卖99 | 原价399.9 / 只卖99 |
| 优惠数字 | 优惠/减免/直降 | 优惠30 | 优惠30 |
| 折扣 | 数字加折 | 3.5折 | 3.5折 |
| 功效数字 | 提升/改善/减少/降低/有效率百分比 | 改善80% | 改善80% |
| 减重数字 | 瘦/减重加重量 | 减重5斤 | 减重5斤 |
| 保温数字 | 保温/保冷加小时数 | 保温24小时 | 保温24小时 |

启用规则生效，禁用规则跳过；非法正则不使分析崩溃，空字符串正则命中不进入问题清单。RuleHit 保留 stepId。热词属于覆盖线索，不再因为命中被当成风险报警。

规则引擎是候选检索，不是商品事实核查器。即使价格数字有已核实依据，也可能触发候选，unverifiedClaim 标记 needsReview。否定语境（如“不保证效果”）、中文数字、复杂优惠条件仍需语义判定。默认数字规则的上下文漏报/误报率未实测。

严重度延续既有契约：禁用词 critical，其余规则候选 warning。规则问题引用实际片段时间、命中原文和规则依据。LLM 引用风险时仅给核实建议，不认定违法。

## 8. E：Prompt、输出契约和单次修复

修复前存在三个真实缺口：未给模型输出结构说明、没传话术步骤/priority/maxWaitMs、segments 被拼成缺逗号的数组字符串。现在通过 JSON.stringify 发送真正数组，完整框架、启用规则、商品事实、双分母指标、粗粒度当前阶段、上一轮结构状态及短摘要。

输出使用工程既有 camelCase 契约，方案第 9、10 节字段概念对应：segment_ids→segmentIds、needs_review→needsReview、suggested_script→suggestedScript、start_ms/end_ms→startMs/endMs、framework_state→frameworkState、next_context_summary→frameworkStateSummary。枚举使用实际 UI/存储的 bannedWord、absolutization、unverifiedClaim、repetition、pace、silence、frameworkStep、other 和 info/warning/critical；不会接纳任意未经定义的 type/severity。

startMs/endMs 若提供必须成对、非负整数、正向且在引用证据跨度内，并与引文所在片段有交集。未提供时主调度从真实引用片段派生时间，因此不能靠伪造模型时间定位。

Zod 上下文门禁校验：枚举、必填说明、置信度范围、片段 ID 存在、稳态状态、片段时间合法且与输入窗相交、quote 完整位于单个引用片段、stepId 存在，以及结构状态只能引用真实话术步骤；摘要不超过 120 字。

框架问题必须给 stepId。Prompt 要求仅当前循环明确且等待时间超出时判断遗漏，不要求每个窗口覆盖全部步骤。结构状态和摘要可帮助理解，但不能作证据。现有粗粒度 ScriptLoopState 并不能证明每个用户步骤实际覆盖，完整循环语义准确率待真实 LLM 和人工抽检。

JSON 无法解析、结构错误、虚构证据都走一次修复请求。修复仍失败即 LLM_BAD_JSON，不因 max_retries 再次发起整组校验修复。网络失败可以按配置重试，但与修复共用轮次超时和预算。实际错误码及说明写入 analysis_runs，避免 AppError 普通对象被旧 catch 记成 unknown。

## 9. F：虚构引文硬验收实跑

模拟输入两段：

- real-1，1000–5000ms：`这款保温杯是304不锈钢的`
- real-2，5000–9000ms：`保温效果可以达到十二小时`

| 构造响应 | 结果 |
|---|---|
| 引用不存在的 nonexistent | 拒绝 |
| 引用 real-2，却写二十四小时 | 拒绝 |
| 同时引用 real-1、real-2，quote为304不锈钢的保温效果可以达到十二小时 | 拒绝；该完整引文不属于任何单段 |
| 空白或空 quote | 拒绝 |
| 引用 real-1、real-2，但quote完整为real-1中的304不锈钢 | 保留；合法多证据不被误杀 |

原 bug：先把引用段文本 join，再 includes，会制造原本不存在于单段的拼接引文。修复为逐单段 some/includes，并进入实际请求使用的 Zod gate。

F5 从 fake fetch 到真正 LlmClient.analyze，再到 orchestrator.runAnalysis、SQLite 和 UI 事件，连续给初次及修复响应一个虚构广告引文：**问题库 0 条、analysis.issues 0 次、分析运行 failed 且 error_message 含 LLM_BAD_JSON**。不仅测 verifyIssues，也验证展示前链路。

兼容 verifyIssues helper 可以过滤坏候选；实际 analyze 严格拒绝整个坏响应并请求一次修复。规则问题仍可独立保存和展示，不能拿它们冒充模型已成功。

## 10. G：20 秒整轮上限和下一窗恢复

有效超时取 `min(配置值,20000)`，为整个 analyze 轮次的期限，覆盖原请求、网络重试、JSON 解析及一次修复；配置更短时限时仍生效。

每次请求同时使用 AbortController 和 Promise.race；即使 fetch 替身忽略 abort，分析 Promise 也会按时释放。G1 在虚拟时钟 20000ms 得到 LLM_TIMEOUT，max_retries=3 也不会因超时再占满另一轮 20 秒。

G2 首窗卡住时最多保留最新一个等待窗，并精确计算被替换数。G3 首次模拟超时，第二个真正经过客户端处理的请求成功返回空问题，证明调度锁释放后下一窗继续。G4 验证运行库 status=timeout、error_message含LLM_TIMEOUT，最后 analysis.status 为 timeout，而非笼统 failed。

真实 ASR 发送不中断、界面不卡和真实网络 20 秒超时仍应由连续监听验证；本次只构造相应异步故障场景。

## 11. H：单场请求数预算

`budget_limit` 使用既有设置，单位为 LLM 请求次数。原实现仅在 analyze 入口检查且仅成功返回后加一，会导致修复/重试越界，且客户端对象跨会话复用使预算跨场累计。

现在每次网络请求发送前预留 1 次额度；初次、失败、超时、重试、修复全部计数；下一次会超限时在发送前拒绝。budget_limit=0 不发送请求，预算 1 时不得发第二次修复。新场次创建新 LlmClient，旧场次已运行的分析捕获旧实例，不污染新场额度和配置。

旧场次合法迟到响应仍写入旧场历史；当前 sessionId 守卫阻止更新新场 UI 或短摘要。既有跨场基线测试全部保留并通过。

请求数不代表 token 或金额成本。实际 token 与计费预算未实现，本报告不将请求数上限写成金额上限。

## 12. 可导入话术框架

产出 `demo/sample-framework.json`。外层 `{simulated:true,framework:{...}}` 对应前端 doImport 的 framework/raw 选择逻辑；真实 FrameworkEditSchema 校验通过，所有规则正则可编译、frameworkId一致、stepId有效。

模拟保温杯电商场景含：商品事实、8 个步骤、必须/建议/可选优先级、最长等待时间、禁用词、绝对化、价格和功效风险、核心热词。不要将虚构模板的商品数据当成真实核实事实。使用方式：话术配置→导入JSON→检查并替换实际资料→保存。

此项是实际 schema 导入逻辑的程序验证；本次未操纵正在其他成员做音频实测的 Electron 窗口，也未声称完成该窗口的点击导入验收。

## 13. 真实调用与 20 个真实候选：未实测

**供应商口径（Chief 锁定）：**只使用 `base_url=http://127.0.0.1:3425/v1`、`model=group/auto-step-5-preview`。Chief 已实测该端点存活、模型存在、原生支持 `/v1/chat/completions`。README 中的智谱/glm-4-flash、OpenAI/gpt-4o-mini、方案中的 0.39 美元示例均不是选定配置，任何人不得据此改端点、改模型或申请其他服务密钥。若用户实际提供其他供应商密钥，先与 Chief/盯播负责人确认配置再测，绝不把密钥隐式发到另一个端点。安全卡 LLM_API_KEY 由 Chief 统一申请，保存后为 `DSH_SECRET_LLM_API_KEY`，本角色不再重复申请。

运行凭据仅从 `DSH_SECRET_LLM_API_KEY` 读取。公开 base_url/model 通过 runtimeConfig 的环境或公开设置读取，不读旧 SQLite llm_api_key；ASR 同样用环境凭据。报告、测试和样例不含真实密钥。

本轮真实 LLM 调用次数：0。真实录播分析报告：未实测。真实候选抽检：0/20，尚无可审计的真实录播转写样本。所有上文文字和波形例子均为模拟测试数据。

待素材与安全环境就绪后的流程：

1. 记录真实音频来源、会话 ID 和转写片段时间，不保存或展示凭据。
2. 由实际 LlmClient 发送一个冻结窗口，保存去密钥的输入摘要、真实 issues、校验结果、错误码和时间。
3. 人工听对应音频并核对至少 20 个模型问题候选及其原话；同时标注真实存在但没被系统发现的问题，才能记录漏报。
4. 每个候选记录类型、severity、segmentIds、quote、音频时间、判定、建议以及人工复核理由；报告误报率和漏报统计的分母及抽样方法。
5. 确认端点、模型、话术框架和采样条件；只在这些证据齐备后更新“真实核心链路通过”。

## 14. 交接限制和后续责任

- 负责人并行修改的设置页最终类型检查、合并 build，由盯播负责人统一验收。
- VAD 背景噪声与音乐、短桶语速突变、拖音识别、是否真正念评论及正确互动，需要真实音频/LLM实测；单凭文字不能确认拖音。
- 现有步骤超时面板仍使用粗粒度阶段停留口径，不等价于每个用户步骤的真实覆盖完成。Prompt 传入完整步骤不代表完整步骤识别已被实测证明。
- 重复规则可检索文本重复，语义重复和跨证据持续问题聚合仍要真实验证。
- 连续静音保留为客观 VAD 指标，删除原来没有片段 ID、quote为空的“原话问题”记录；其最终实时UI呈现需专门的客观指标通道，不应伪造引用来凑问题。
- 真实直播至少20候选、误报漏报、持续性能以及macOS均未实测。

交付物：本报告、可导入模拟框架、分析端修复代码及51项专项测试。现阶段交付结论是本地分析与证据门禁可验证；真实场景验收仍待端点/安全key和真实素材。

## 15. 待安全环境就绪的真实窗口脚本

`src/main/analysis/verifyRealWindow.ts` 已准备并通过类型检查。两个脚本单测使用模拟来源 SQLite 和模拟 fetch，验证只读源库、隔离问题和分析运行、生成JSON/HTML以及凭据不落盘；不计为真实 LLM 验收。

脚本从来源数据库只读提取指定真实会话最近300秒内的稳态转写、实际框架和已记录讲话区间，复制到内存数据库。真正的 orchestrator 调用 LlmClient，Zod验证通过才保存语义问题；失败或逾时保留运行状态。之后调用既有 buildReportSummary/buildHtmlReport 生成独立报告。不启动音频采集或ASR，不改来源库，不读旧数据库密钥。

由操作人员确认 `--confirm-real-asr` 和来源标签；脚本不能只根据数据库文字证明音频为真人。来源不存在、窗口为空、未确认来源或LLM安全配置缺失时，不会用模板补数据冒充真实分析。

在负责人完成最终 build 后执行（示例中的路径/ID/时间为占位符，必须替换成实跑来源）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\ai盯播工具\app\node_modules\electron\dist\electron.exe" `
  "D:\ai盯播工具\app\dist\main\main\analysis\verifyRealWindow.js" `
  --db "<真实ASR来源数据库绝对路径>" `
  --session "<真实会话ID>" `
  --end-ms <冻结窗口终点毫秒> `
  --source-label "<录播来源或现场讲话来源说明>" `
  --confirm-real-asr `
  --output "D:\ai盯播工具\app\docs\real-window-verification.json"
```

如果来源库包含多个框架，追加 `--framework-id <实际框架ID>`。LLM密钥由安全环境注入 `DSH_SECRET_LLM_API_KEY`，不可放进命令行；公开端点和模型由已确认的环境或公开设置提供。

输出：指定JSON及同名 `.json.html`，包含来源标签、会话和冻结窗口、真实片段、实际问题、逐字证据校验、分析状态及报告。stdout仅给状态、数量和输出路径，不给凭据。请求失败仍生成失败报告；退出码为1。仅在运行success且证据均有效时退出0；问题数组可以为空，不伪造问题来凑演示。

脚本报告中 `reviewedRealCandidates=0`、required=20、误报漏报未实测，必须在人工真实抽检后另行更新。新增脚本后的最新全量为156/156；最终构建由盯播负责人统一进行。

