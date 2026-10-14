import { useEffect, useState } from "react";
import type { Framework, ScheduleConfig, Settings } from "../../shared/contracts";
import { WEEKDAY_LABEL, formatCountdown, nextScheduledStart } from "../../shared/schedule";
import type { AsrStatusInfo, LlmStatusInfo } from "../../shared/api";
import { Badge, Button, Field, Panel, tokens } from "../ui/basics";

/** 默认排期：每天 20:00–23:00 系统声音。 */
const DEFAULT_SCHEDULE: ScheduleConfig = {
  enabled: false,
  startTime: "20:00",
  endTime: "23:00",
  weekdays: [],
  audioSource: "systemLoopback",
  frameworkId: null,
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrStatusInfo | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatusInfo | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asrMsg, setAsrMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [llmMsg, setLlmMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState<"asr" | "llm" | null>(null);

  // 只保留公开配置的编辑态：App ID、Base URL、模型名。
  // 密钥一律来自进程环境变量，界面不提供任何 secret 输入。
  const [asrAppId, setAsrAppId] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");

  /** 配置来源是否为环境变量（主进程从进程 env 读密钥）。 */
  const asrFromEnv = asrStatus?.source === "environment";
  const llmFromEnv = llmStatus?.source === "environment";
  /** 话术框架列表，供排期选择"用哪个框架"。 */
  const [frameworks, setFrameworks] = useState<Framework[]>([]);
  /** 每秒心跳，让"下次自动开始"倒计时会走。 */
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    const [s, asrInfo, llmInfo, fws] = await Promise.all([
      window.appApi.getSettings(),
      window.appApi.getAsrStatus(),
      window.appApi.getLlmStatus(),
      window.appApi.listFrameworks().catch(() => [] as Framework[]),
    ]);
    setSettings(s);
    setAsrStatus(asrInfo);
    setLlmStatus(llmInfo);
    setFrameworks(fws);
    setLlmBaseUrl(s.llm?.base_url ?? "");
    setLlmModel(s.llm?.model ?? "");
  }

  const schedule: ScheduleConfig = settings?.schedule ?? DEFAULT_SCHEDULE;
  const nextStart = nextScheduledStart(schedule, now);

  /** 更新排期配置（只改本地编辑态，点「保存全部设置」才落库）。 */
  function updateSchedule(patch: Partial<ScheduleConfig>) {
    if (!settings) return;
    setSettings({ ...settings, schedule: { ...schedule, ...patch } });
    setMsg(null);
  }

  async function doSave() {
    if (!settings) return;
    const payload: Settings = { ...settings };
    // 只保存公开配置。密钥字段一律不传：主进程只认环境变量，
    // 传了也会被忽略，还会诱导用户以为"填了就能生效"。
    if (asrAppId) {
      payload.asr = { provider: "tencent", appId: asrAppId, secretId: "", secretKey: "" };
    } else {
      delete payload.asr;
    }
    const { api_key: _dropKey, ...restLlm } = { ...payload.llm, base_url: llmBaseUrl, model: llmModel };
    payload.llm = restLlm;
    const ok = await window.appApi.saveSettings(payload);
    setMsg(
      ok
        ? {
            ok: true,
            text: "公开配置已保存。密钥由环境变量提供，不会经过界面、也不会写入本地数据库。",
          }
        : { ok: false, text: "保存失败：字段校验未通过" },
    );
    if (ok) await reload();
  }

  async function testAsr() {
    setTesting("asr");
    setAsrMsg(null);
    // 连接测试统一走 useStored：主进程读环境变量里的密钥，
    // 界面没有也不可能有 secret 输入框。
    if (asrAppId && !/^\d+$/.test(asrAppId)) {
      setTesting(null);
      setAsrMsg({ ok: false, text: `App ID 应为纯数字（腾讯云控制台 → 账号信息里的 APPID，如 1258899888），当前填的是「${asrAppId}」` });
      return;
    }
    try {
      const result = await window.appApi.testAsrConnection({ useStored: true });
      setAsrMsg(
        result.ok
          ? { ok: true, text: "环境密钥连接成功" }
          : { ok: false, text: `连接失败：${result.error?.message ?? "未知错误"}` },
      );
    } catch (err) {
      setAsrMsg({ ok: false, text: `连接失败：${err instanceof Error ? err.message : "未知错误"}` });
    } finally {
      setTesting(null);
    }
  }

  async function testLlm() {
    setTesting("llm");
    setLlmMsg(null);
    // 与 ASR 同理：密钥只从环境变量读，界面没有也不该有 key 输入。
    try {
      const result = await window.appApi.testLlmConnection({ useStored: true });
      setLlmMsg(
        result.ok
          ? { ok: true, text: "环境密钥连接成功" }
          : { ok: false, text: `连接失败：${result.error?.message ?? "未知错误"}` },
      );
    } catch (err) {
      setLlmMsg({ ok: false, text: `连接失败：${err instanceof Error ? err.message : "未知错误"}` });
    } finally {
      setTesting(null);
    }
  }

  if (!settings) return <div className="loading">加载中…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 760 }}>
      <Panel title="腾讯云 ASR（实时语音识别）">
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          状态：
          {asrStatus?.configured ? (
            <>
              <Badge tone="ok">已配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                {asrFromEnv
                  ? `密钥来自环境变量（App ID ${asrStatus.appId}）`
                  : "密钥来自本机数据库（旧版配置，建议改用环境变量）"}
              </span>
            </>
          ) : (
            <>
              <Badge tone="dim">未配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                需要 DSH_SECRET_TENCENT_ASR_SECRET_ID / DSH_SECRET_TENCENT_ASR_SECRET_KEY 环境变量
              </span>
            </>
          )}
        </div>
        {/*
          密钥一律来自进程环境变量，主进程只从 env 读、不接界面传入的 secret。
          这里因此不再提供 Secret ID / Secret Key 输入框——填了也会被忽略，
          摆两个能输入的框子只会让人误以为改这里就能换密钥。改密钥请改启动环境。
        */}
        <Field label="App ID" hint="腾讯云账号 APPID（公开信息，可在此修改后保存）">
          <input
            className="input"
            value={asrAppId}
            onChange={(e) => setAsrAppId(e.target.value)}
            placeholder={asrStatus?.appId || "1502622498"}
          />
        </Field>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={testAsr} disabled={testing === "asr"}>
            {testing === "asr" ? "测试中…" : "测试连接"}
          </Button>
        </div>
        {asrMsg ? (
          <div style={{ marginTop: 8, fontSize: 13, color: asrMsg.ok ? tokens.ok : tokens.danger }}>{asrMsg.text}</div>
        ) : null}
        <div style={{ marginTop: 8, fontSize: 12, color: tokens.textDim, lineHeight: 1.8 }}>
          密钥来源：环境变量 DSH_SECRET_TENCENT_ASR_SECRET_ID / DSH_SECRET_TENCENT_ASR_SECRET_KEY。
          「测试连接」同样只使用环境里的密钥，界面无法查看或替换。
        </div>
      </Panel>

      <Panel title="LLM（OpenAI 兼容接口）">
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          状态：
          {llmStatus?.configured ? (
            <>
              <Badge tone="ok">已配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                {llmStatus.model} @ {llmStatus.baseUrl}
                {llmFromEnv ? "（密钥来自环境变量）" : "（密钥来自本机数据库，建议改用环境变量）"}
              </span>
            </>
          ) : (
            <>
              <Badge tone="dim">未配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                需要环境变量 DSH_SECRET_LLM_API_KEY，以及 Base URL 与模型名
              </span>
            </>
          )}
        </div>
        {/*
          与 ASR 同理：LLM 密钥同样只从环境变量读，主进程会忽略界面传入的 api_key。
          这里不摆 API Key 输入框，只留公开配置（Base URL / 模型名）。
        */}
        <Field label="Base URL" hint="例如 https://api.openai.com/v1 或其他兼容服务地址">
          <input className="input" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="模型名">
          <input className="input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="gpt-4o-mini / glm-4-flash / …" />
        </Field>
        <Button onClick={testLlm} disabled={testing === "llm"}>
          {testing === "llm" ? "测试中…" : "测试连接"}
        </Button>
        {llmMsg ? (
          <div style={{ marginTop: 8, fontSize: 13, color: llmMsg.ok ? tokens.ok : tokens.danger }}>{llmMsg.text}</div>
        ) : null}
        <div style={{ marginTop: 8, fontSize: 12, color: tokens.textDim, lineHeight: 1.8 }}>
          密钥来源：环境变量 DSH_SECRET_LLM_API_KEY。「测试连接」只使用环境里的密钥，界面无法查看或替换。
        </div>
      </Panel>

      <Panel title="分析设置">
        <Field label="分析间隔">
          <select
            className="input select"
            value={settings.windowIntervalSec}
            onChange={(e) => setSettings({ ...settings, windowIntervalSec: Number(e.target.value) as Settings["windowIntervalSec"] })}
          >
            <option value={30}>30 秒</option>
            <option value={60}>60 秒</option>
            <option value={120}>120 秒</option>
          </select>
        </Field>
        <Field label="分析窗口">
          <select
            className="input select"
            value={settings.windowSizeSec}
            onChange={(e) => setSettings({ ...settings, windowSizeSec: Number(e.target.value) as Settings["windowSizeSec"] })}
          >
            <option value={180}>3 分钟</option>
            <option value={300}>5 分钟</option>
            <option value={600}>10 分钟</option>
          </select>
        </Field>
        <Field label="请求超时（毫秒）">
          <input
            type="number"
            className="input"
            value={settings.llm?.request_timeout_ms ?? 30000}
            onChange={(e) =>
              setSettings({
                ...settings,
                llm: { ...settings.llm, request_timeout_ms: Math.max(1000, Number(e.target.value)) },
              })
            }
          />
        </Field>
        <Field label="单场预算上限（LLM 请求数）" hint="超过后停止 LLM 分析（本地规则仍生效），防止费用失控。">
          <input
            type="number"
            className="input"
            value={settings.llm?.budget_limit ?? 10}
            onChange={(e) =>
              setSettings({
                ...settings,
                llm: { ...settings.llm, budget_limit: Math.max(1, Number(e.target.value)) },
              })
            }
          />
        </Field>
      </Panel>

      <Panel title="定时监听（无人值守）">
        {/*
          诚实提示：本轮只落配置与计算，"到点自动开录"尚未接通。
          原因见 docs/unattended-capture-research.md —— 采集入口受 Chromium user activation 约束，
          定时器/启动回调都无法触发 getDisplayMedia，必须先解决一次性授权复用或原生采集。
          这里必须写明，否则用户配好时间等一晚上没开录，会以为是 bug。
        */}
        <div className="callout callout-warn" style={{ marginTop: 0, marginBottom: 12 }}>
          ⚠ <b>该功能尚未接通</b>：本页配置会被保存，但到点<b>不会自动开始录制</b>。
          受浏览器安全模型限制（系统声音采集需要用户当次手动授权），自动开录需要先完成
          「一次性授权复用」改造。当前请仍手动点「监听系统声音」。
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) => updateSchedule({ enabled: e.target.checked })}
          />
          启用定时监听排期
        </label>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Field label="开始时间">
            <input
              className="input"
              type="time"
              style={{ width: 140 }}
              value={schedule.startTime}
              onChange={(e) => updateSchedule({ startTime: e.target.value })}
            />
          </Field>
          <Field label="结束时间">
            <input
              className="input"
              type="time"
              style={{ width: 140 }}
              value={schedule.endTime}
              onChange={(e) => updateSchedule({ endTime: e.target.value })}
            />
          </Field>
        </div>
        {schedule.endTime <= schedule.startTime ? (
          <div style={{ fontSize: 12, color: tokens.textDim, marginTop: -6, marginBottom: 12 }}>
            结束时间早于开始时间，将按<b>跨天</b>处理（{schedule.startTime} 开始，次日 {schedule.endTime} 结束）。
          </div>
        ) : null}

        <Field label="生效星期" hint="不选任何一天表示每天生效。">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {WEEKDAY_LABEL.map((label, idx) => {
              const on = schedule.weekdays.includes(idx);
              return (
                <button
                  key={idx}
                  type="button"
                  className={`btn${on ? " btn-primary" : ""}`}
                  style={{ padding: "4px 10px" }}
                  onClick={() =>
                    updateSchedule({
                      weekdays: on
                        ? schedule.weekdays.filter((d) => d !== idx)
                        : [...schedule.weekdays, idx].sort((a, b) => a - b),
                    })
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="音源">
          <select
            className="input select"
            value={schedule.audioSource}
            onChange={(e) => updateSchedule({ audioSource: e.target.value as ScheduleConfig["audioSource"] })}
          >
            <option value="systemLoopback">系统声音</option>
            <option value="microphone">麦克风</option>
          </select>
        </Field>

        <Field label="话术框架" hint="不选则使用框架列表中的第一个。">
          <select
            className="input select"
            value={schedule.frameworkId ?? ""}
            onChange={(e) => updateSchedule({ frameworkId: e.target.value || null })}
          >
            <option value="">（默认：第一个框架）</option>
            {frameworks.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </Field>

        <div style={{ fontSize: 13, marginTop: 4 }}>
          下次自动开始：
          {nextStart ? (
            <>
              <b>{nextStart.toLocaleString()}</b>
              <span style={{ color: tokens.textDim, marginLeft: 8 }}>（{formatCountdown(nextStart, now)}）</span>
            </>
          ) : (
            <span style={{ color: tokens.textDim }}>未启用或无有效排期</span>
          )}
        </div>
      </Panel>

      <Panel title="本地数据">
        <div style={{ fontSize: 13, color: tokens.textDim, marginBottom: 10 }}>
          所有数据（会话、转写、问题、设置）保存在本机 userData/live-monitor.db。删除会话会同时删除其转写与问题记录。
        </div>
        <DeleteSessionControl onDeleted={() => setMsg({ ok: true, text: "会话已删除" })} />
      </Panel>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button variant="primary" onClick={doSave}>保存全部设置</Button>
        {msg ? <span className={msg.ok ? "toast-ok" : "toast-err"}>{msg.text}</span> : null}
      </div>
    </div>
  );
}

function DeleteSessionControl({ onDeleted }: { onDeleted: () => void }) {
  const [sessions, setSessions] = useState<Array<{ id: string; startedAtIso: string; issueCount: number }>>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    window.appApi
      .listSessions()
      .then((r) => setSessions(r.sessions.map((s) => ({ id: s.id, startedAtIso: s.startedAtIso, issueCount: s.issueCount }))))
      .catch(() => setSessions([]));
  }, []);

  return (
    <div>
      {sessions.length === 0 ? <div style={{ fontSize: 13, color: tokens.textDim }}>没有历史会话。</div> : null}
      {sessions.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${tokens.border}` }}>
          <span style={{ fontSize: 13, flex: 1 }}>
            {s.id.slice(0, 8)} · {new Date(s.startedAtIso).toLocaleString()} · {s.issueCount} 条问题
          </span>
          {confirmId === s.id ? (
            <>
              <Button variant="danger" onClick={async () => { await window.appApi.deleteSession(s.id); setConfirmId(null); onDeleted(); }}>
                确认删除
              </Button>
              <Button variant="ghost" onClick={() => setConfirmId(null)}>取消</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmId(s.id)}>删除会话</Button>
          )}
        </div>
      ))}
    </div>
  );
}
