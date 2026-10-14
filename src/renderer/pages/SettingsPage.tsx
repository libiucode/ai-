import { useEffect, useState } from "react";
import type { Settings } from "../../shared/contracts";
import type { AsrStatusInfo, LlmStatusInfo } from "../../shared/api";
import { Badge, Button, Field, Panel, tokens } from "../ui/basics";

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

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    const [s, asrInfo, llmInfo] = await Promise.all([
      window.appApi.getSettings(),
      window.appApi.getAsrStatus(),
      window.appApi.getLlmStatus(),
    ]);
    setSettings(s);
    setAsrStatus(asrInfo);
    setLlmStatus(llmInfo);
    setLlmBaseUrl(s.llm?.base_url ?? "");
    setLlmModel(s.llm?.model ?? "");
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
