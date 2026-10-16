import { useEffect, useState } from "react";
import type { Framework, ScheduleConfig, Settings } from "../../shared/contracts";
import { WEEKDAY_LABEL, formatCountdown, nextScheduledStart } from "../../shared/schedule";
import type {
  AsrStatusInfo,
  CredentialKey,
  CredentialStatusResult,
  LlmStatusInfo,
} from "../../shared/api";
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
  // 密钥单独在「密钥」面板填写（加密存本机），不随本页保存。
  const [asrAppId, setAsrAppId] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");

  /**
   * 密钥编辑态：只在用户主动输入时存在，保存后即清空，永不回填明文。
   * 读取只走 `credentialStatus()`（主进程只回布尔值，不回密钥本身）。
   */
  const [secrets, setSecrets] = useState<Record<CredentialKey, string>>({
    TENCENT_ASR_SECRET_ID: "",
    TENCENT_ASR_SECRET_KEY: "",
    LLM_API_KEY: "",
  });
  /** 本机是否已存各凭证 + 环境变量是否提供 + 系统是否支持加密。 */
  const [credStatus, setCredStatus] = useState<CredentialStatusResult | null>(null);
  const [credMsg, setCredMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingCred, setSavingCred] = useState(false);

  /** 环境变量已提供时界面填写无效（主进程 env 优先），据此禁用输入框并说明。 */
  function envProvided(key: CredentialKey): boolean {
    return Boolean(credStatus?.fromEnv?.[key]);
  }
  /** 本机已存且环境变量未提供 → 显示「已配置…」，不再要求用户重填。 */
  function storedConfigured(key: CredentialKey): boolean {
    return Boolean(credStatus?.configured?.[key]) && !envProvided(key);
  }

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
    const [s, asrInfo, llmInfo, fws, cred] = await Promise.all([
      window.appApi.getSettings(),
      window.appApi.getAsrStatus(),
      window.appApi.getLlmStatus(),
      window.appApi.listFrameworks().catch(() => [] as Framework[]),
      window.appApi.credentialStatus().catch(() => null),
    ]);
    setSettings(s);
    setAsrStatus(asrInfo);
    setLlmStatus(llmInfo);
    setFrameworks(fws);
    setCredStatus(cred);
    setLlmBaseUrl(s.llm?.base_url ?? "");
    setLlmModel(s.llm?.model ?? "");
    // 必须回填已存的 App ID：doSave() 里 `if (asrAppId) {...} else { delete payload.asr }`，
    // 而 settingsSave 是整键覆盖（不是 patch）。不回填的话，用户只改「分析间隔」再保存，
    // 就会把库里已存的 App ID 静默抹掉——他明明没碰 ASR 那一栏。
    setAsrAppId(s.asr?.appId ?? asrInfo?.appId ?? "");
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
    // llm 整体是 optional，但一旦带上了就必须满足 base_url: z.string().url()。
    // 全新安装（或用户清空 Base URL）时 llmBaseUrl 是 ""，无条件塞进去会让
    // SettingsSchema 校验失败 → 保存永久失败，界面只说「字段校验未通过」却不指出是哪个字段。
    // 所以：Base URL 为空就整个不带 llm，让 schema 的 optional 生效。
    if (restLlm.base_url) {
      payload.llm = restLlm;
    } else {
      delete payload.llm;
    }
    const ok = await window.appApi.saveSettings(payload);
    setMsg(
      ok
        ? {
            ok: true,
            text: "公开配置已保存。密钥不在此处提交——请在下方「密钥」面板单独保存。",
          }
        : { ok: false, text: "保存失败：字段校验未通过" },
    );
    if (ok) await reload();
  }

  /**
   * 保存填写过的密钥（空框跳过，不覆盖本机已存的值）。
   * 保存成功后立刻清空编辑态——明文不在内存里多留一秒。
   */
  async function doSaveCredentials() {
    const filled = (Object.keys(secrets) as CredentialKey[]).filter((k) => secrets[k].trim());
    if (filled.length === 0) {
      setCredMsg({ ok: false, text: "没有填写任何密钥（留空表示不修改）。" });
      return;
    }
    setSavingCred(true);
    setCredMsg(null);
    try {
      const results = await Promise.all(
        filled.map((k) => window.appApi.setCredential(k, secrets[k].trim())),
      );
      const failed = results.filter((r) => !r.ok);
      setSecrets({ TENCENT_ASR_SECRET_ID: "", TENCENT_ASR_SECRET_KEY: "", LLM_API_KEY: "" });
      if (failed.length > 0) {
        setCredMsg({
          ok: false,
          text: failed[0].message ?? "保存失败：当前系统不支持加密存储，请改用环境变量。",
        });
      } else {
        setCredMsg({
          ok: true,
          text: `已保存 ${filled.length} 项密钥（系统钥匙串加密，绑定到本机当前账户）。`,
        });
      }
      await reload();
    } catch (err) {
      setCredMsg({ ok: false, text: `保存失败：${err instanceof Error ? err.message : "未知错误"}` });
    } finally {
      setSavingCred(false);
    }
  }

  /** 清除本机已存的全部凭证。环境变量不受影响。 */
  async function doClearCredentials() {
    setSavingCred(true);
    setCredMsg(null);
    try {
      const r = await window.appApi.clearCredentials();
      setCredMsg({ ok: r.ok, text: r.message });
      await reload();
    } finally {
      setSavingCred(false);
    }
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
    // 连接测试走 useStored：主进程按「环境变量 > 本机密文」取值。
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
                {asrStatus?.message ?? `App ID ${asrStatus?.appId ?? ""}`}
              </span>
            </>
          ) : (
            <>
              <Badge tone="dim">未配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                {asrStatus?.message ?? "需要 Secret ID 与 Secret Key（可在本页填写，或由环境变量提供）"}
              </span>
            </>
          )}
        </div>
        {/* 密钥双通道：本页填写（加密存本机）或环境变量提供，环境变量优先；不回显明文。 */}
        <SecretField
          label="Secret ID"
          hint="腾讯云控制台 → 访问密钥 → API 密钥管理"
          value={secrets.TENCENT_ASR_SECRET_ID}
          onChange={(v) => setSecrets({ ...secrets, TENCENT_ASR_SECRET_ID: v })}
          stored={storedConfigured("TENCENT_ASR_SECRET_ID")}
          fromEnv={envProvided("TENCENT_ASR_SECRET_ID")}
          disabled={!credStatus?.available}
        />
        <SecretField
          label="Secret Key"
          hint="与 Secret ID 成对，保存后不回显"
          value={secrets.TENCENT_ASR_SECRET_KEY}
          onChange={(v) => setSecrets({ ...secrets, TENCENT_ASR_SECRET_KEY: v })}
          stored={storedConfigured("TENCENT_ASR_SECRET_KEY")}
          fromEnv={envProvided("TENCENT_ASR_SECRET_KEY")}
          disabled={!credStatus?.available}
        />
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
          密钥可在本页填写（加密存本机，不回显、不入库明文），或由环境变量
          DSH_SECRET_TENCENT_ASR_SECRET_ID / DSH_SECRET_TENCENT_ASR_SECRET_KEY 提供。
          <b>环境变量优先级更高</b>，两者取其一即可。「测试连接」使用同一套取值逻辑。
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
                 {llmStatus.model} @ {llmStatus.baseUrl}（{llmStatus.message ?? "已配置"}）
              </span>
            </>
          ) : (
            <>
              <Badge tone="dim">未配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                 {llmStatus?.message ?? "需要 API Key，以及 Base URL 与模型名"}
              </span>
            </>
          )}
        </div>
        {/* 密钥双通道：本页填写（加密存本机）或环境变量提供，环境变量优先；不回显明文。 */}
        <SecretField label="API Key" hint="保存后不回显明文" value={secrets.LLM_API_KEY} onChange={(v) => setSecrets({ ...secrets, LLM_API_KEY: v })} stored={storedConfigured("LLM_API_KEY")} fromEnv={envProvided("LLM_API_KEY")} disabled={!credStatus?.available} />
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
          API Key 可在本页填写（加密存本机，不回显、不入库明文），或由环境变量
          DSH_SECRET_LLM_API_KEY 提供。<b>环境变量优先级更高</b>，两者取其一即可。
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

      <Panel title="密钥（加密存本机）">
        {credStatus && !credStatus.available ? (
          <div className="callout callout-warn" style={{ marginTop: 0, marginBottom: 10 }}>
            ⚠ 当前系统不支持加密存储（Windows DPAPI / macOS Keychain / Linux 密钥环），
            输入框已禁用以避免明文落盘。请改用环境变量启动本应用。
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: tokens.textDim, marginBottom: 10 }}>
          在上面两个面板填写后点此保存。<b>留空表示不修改</b>——已存的值不会被空框覆盖。
          保存后明文立即从内存中清空，界面只显示「已配置」，无法查看或导出。
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={doSaveCredentials} disabled={savingCred}>
            {savingCred ? "保存中…" : "保存密钥"}
          </Button>
          <Button variant="danger" onClick={doClearCredentials} disabled={savingCred}>
            清除本机凭证
          </Button>
          {credMsg ? <span className={credMsg.ok ? "toast-ok" : "toast-err"}>{credMsg.text}</span> : null}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: tokens.textDim, lineHeight: 1.8 }}>
          密文存于本机数据库，绑定当前系统账户（Windows 用 DPAPI，macOS 用 Keychain），
          换机器或换账户后无法解密，会当作未配置。它防的是「明文落盘被随手看到」，
          不防同账户下的其它程序；有环境变量时仍以环境变量为准。
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

/**
 * 密钥输入框：type="password"，永不回显明文。
 * - 已存本机 → 显示「已配置…」，不要求重填
 * - 环境变量已提供 → 禁用并标注（主进程 env 优先，填了也不生效）
 * - 系统不支持加密 → 禁用，避免明文落盘
 */
function SecretField({
  label,
  hint,
  value,
  onChange,
  stored,
  fromEnv,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  stored: boolean;
  fromEnv: boolean;
  disabled: boolean;
}) {
  const note = fromEnv
    ? "由环境变量提供（优先级更高），此处填写不会生效"
    : stored
      ? "已配置（本机加密存储），留空则不修改"
      : undefined;
  return (
    <Field label={label} hint={hint}>
      <input
        className="input"
        type="password"
        autoComplete="off"
        value={value}
        disabled={fromEnv || disabled}
        placeholder={stored || fromEnv ? "••••••••（已配置）" : ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {note ? (
        <div style={{ fontSize: 12, color: tokens.textDim, marginTop: 4 }}>{note}</div>
      ) : null}
    </Field>
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
