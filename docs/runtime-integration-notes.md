# 本轮运行链路修复与验收边界

本轮只在本机修改、构建、验证。未部署、未发布。工程目录：`$PSScriptRoot\..`。

## 已修复的应用入口缺口

1. **Windows系统声音缺主进程处理**：`src/main/index.ts`为当前应用主frame注册`setDisplayMediaRequestHandler`。只处理Windows、有用户手势、同时请求audio/video的请求，选主屏幕采集源并返回`audio: "loopback"`。其他frame/平台/无用户手势请求拒绝。原来仅renderer调用`getDisplayMedia`，在本机报`NotSupportedError("Not supported")`；不能把此错误一概归因于系统驱动。屏幕视频仅用于建立采集流，renderer会停止不用的视频轨道。
2. **应用不读取已存环境凭证**：新增`src/main/security/runtimeConfig.ts`。ASR只读`DSH_SECRET_TENCENT_ASR_SECRET_ID`和`DSH_SECRET_TENCENT_ASR_SECRET_KEY`，公开APPID默认1502622498，可配置。LLM只读`DSH_SECRET_LLM_API_KEY`，公开base_url/model可从设置或环境取。orchestrator启动/恢复已接此接口。
3. **设置接口写明文密钥**：`src/main/ipc.ts`只保存公开配置，过滤密钥字段；settings.get过滤历史记录中的敏感字段。历史SQLite专用密钥记录未删除，运行链路不再读取它们；因此本修复不代表旧数据已被清理。
4. **讲话时段契约不一致**：`Store.querySpeechIntervals`此前将snake_case数据库行强转camelCase类型，导致分析/报告读到undefined。SQL现明确返回`sessionId/startMs/endMs`别名。
5. **测试改写共享native二进制**：删除自动调用`ensure-sqlite-abi.js`的pretest钩子；`npm test`通过`test-electron-node.js`在Electron内置Node下运行vitest，默认带`run`，不会进入watch。单元测试子进程不继承真实服务密钥。实测storage 5/5且执行前后native二进制SHA256一致。
6. **报告统计口径**：双语语速分子为汉字数+英文词数，按讲话时长/总时长分别展示。ASR连接/断线/缺口和LLM请求计数缺少持久化来源，返回null并显示未统计，不能拿analysis run数量冒充。

## 本轮已经执行的检查

- typecheck：双配置通过。
- build：renderer/main编译通过。
- renderer smoke：真实Electron下API preload、导航、四页、无console错误四项通过。存在开发模式CSP警告，不等于真实音频验收。
- runtime-config：验证settings.save不落盘密钥，settings.get不回显旧敏感配置。
- report-speech-timing：真实SQLite时段→双分母报告回归通过。
- 全量回归历史时刻：2026-10-14 22:03（北京时间）负责人复核15个文件153/153通过、双typecheck通过、build成功。
- 最新合并检查：负责人再次复核SettingsPage修复后typecheck双配置通过。新增真实窗口验证工具后，22:16全量16文件156/156通过（工具的2项测试使用模拟ASR来源和模拟fetch，不算真实LLM验收）。
- 打包native闸门已验证：目标Electron33.4.11/ABI130/win32x64能打开内存SQLite，exit0；故意给错误版本0.0.0的负例exit1阻断；native二进制SHA256前后相同。build.npmRebuild关闭，prepackage先编译再做只读闸门；不匹配时才协调重建，不在采集过程中重写binary。
- 全部代码测试通过不能替代真实直播或真实LLM请求验收。

## 本轮网络探针的准确口径

`scripts/tencent-live-probe.js`输入是12秒本地合成多频波，非语音、非直播。观测到451ms WebSocket握手、2个临时帧、1个空文本稳态帧、close1006。只证明鉴权/上传基本连通，不证明识别、字幕、正常结束或端到端延迟验收通过。脚本说明已纠正。

历史材料中10.815秒人声→3条稳态字幕是历史记录，必须另作本轮复现。

## 待补硬验收

- 当前版本真实直播系统播放声→loopback→Tencent ASR→非空时间戳字幕，需音频采集与实时转写共同提供证据。
- 麦克风完整链路与连续时长测量。此前8秒非零短测不能替代10分钟/30分钟验收。
- LLM真实请求。只读已有公开设置为`http://127.0.0.1:3425/v1`和`group/auto-step-5-preview`，服务可用性及用户当前选择尚待Chief核实。安全卡键名`LLM_API_KEY`映射`DSH_SECRET_LLM_API_KEY`，不读旧数据库密钥。
- 打包验收按Chief确认分两档：裸Explorer双击exe仅验界面启动、可操作和无崩溃，未注入凭证时ASR/LLM不可用属预期；完整采集→ASR→字幕→话术→问题→导出必须由持`DSH_SECRET_*`的Harness安全环境启动目录版exe实测。不得写永久系统环境、启动脚本、注册表或数据库注入密钥。开发模式通过不能替代打包链路验收。
- macOS采集和打包未实测。

## 协作过程问题

负责人此前为排查ABI误用全局Stop-Process，并多次执行会改变ABI的pretest，可能中断其他成员的实测。此做法已停止；后续只处理自己记录的PID，原连续测量若受中断必须重测。原scheduler FIFO派单与方案的一运行一待处理设计冲突，已撤回；按有界合并最新窗口设计验证，不改FIFO。
