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
  const [showSecrets, setShowSecrets] = useState(false);

  // ASR / LLM form drafts (separate from saved settings until tested+saved)
  const [asrAppId, setAsrAppId] = useState("");
  const [asrSecretId, setAsrSecretId] = useState("");
  const [asrSecretKey, setAsrSecretKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");

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
    if (s.llm) {
      setLlmBaseUrl(s.llm.base_url ?? "");
      setLlmModel(s.llm.model ?? "");
    }
    // asr fields are not returned (masked), only status flags
  }

  async function doSave() {
    if (!settings) return;
    const payload: Settings = { ...settings };
    // attach fresh credentials only if user typed them; otherwise keep stored ones
    const asrFilled = asrAppId && asrSecretId && asrSecretKey;
    if (asrFilled) {
      payload.asr = {
        provider: "tencent",
        appId: asrAppId,
        secretId: asrSecretId,
        secretKey: asrSecretKey,
      };
    }
    const llmFilled = llmBaseUrl && llmModel && llmApiKey;
    if (llmFilled) {
      payload.llm = { ...payload.llm, base_url: llmBaseUrl, model: llmModel, api_key: llmApiKey };
    } else if (llmBaseUrl && llmModel) {
      payload.llm = { ...payload.llm, base_url: llmBaseUrl, model: llmModel };
    }
    const ok = await window.appApi.saveSettings(payload);
    setMsg(ok ? { ok: true, text: "设置已保存。密钥仅存储在本地数据库，不会出现在日志或导出中。" } : { ok: false, text: "保存失败：字段校验未通过" });
    if (ok) {
      setAsrSecretId("");
      setAsrSecretKey("");
      setLlmApiKey("");
      await reload();
    }
  }

  async function testAsr() {
    setTesting("asr");
    setAsrMsg(null);
    // 三项留空但已配置过 → 让主进程读库里已存配置测（渲染层不接触明文）
    const useStored = !asrAppId && !asrSecretId && !asrSecretKey && !!asrStatus?.configured;
    // 防呆：App ID 必须是纯数字（填成“腾讯”这类会绕一圈问服务器才报 4001）
    if (!useStored && asrAppId && !/^\d+$/.test(asrAppId)) {
      setTesting(null);
      setAsrMsg({ ok: false, text: `App ID 应为纯数字（腾讯云控制台 → 账号信息里的 APPID，如 1258899888），当前填的是「${asrAppId}」` });
      return;
    }
    try {
      const result = await window.appApi.testAsrConnection(
        useStored
          ? { useStored: true }
          : { provider: "tencent", appId: asrAppId, secretId: asrSecretId, secretKey: asrSecretKey },
      );
      setAsrMsg(
        result.ok
          ? { ok: true, text: "腾讯云 ASR 连接成功" }
          : { ok: false, text: `连接失败：${result.error?.message ?? "未知错误"}` },
      );
    } catch (err) {
      // 没有 catch 时 invoke 拒绝会静默吞掉，用户看到一个“没反应”的按钮
      setAsrMsg({ ok: false, text: `连接失败：${err instanceof Error ? err.message : "未知错误"}` });
    } finally {
      setTesting(null);
    }
  }

  async function testLlm() {
    setTesting("llm");
    setLlmMsg(null);
    const useStored = !llmBaseUrl && !llmModel && !llmApiKey && !!llmStatus?.configured;
    try {
      const result = await window.appApi.testLlmConnection(
        useStored
          ? { useStored: true }
          : {
              base_url: llmBaseUrl,
              model: llmModel,
              api_key: llmApiKey,
              request_timeout_ms: 10000,
              max_retries: 0,
            },
      );
      setLlmMsg(
        result.ok
          ? { ok: true, text: "LLM 连接成功" }
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
                AppId {asrStatus.appId} · SecretId 尾号 {asrStatus.secretIdTail}
              </span>
            </>
          ) : (
            <Badge tone="dim">未配置</Badge>
          )}
        </div>
        <Field label="App ID">
          <input className="input" value={asrAppId} onChange={(e) => setAsrAppId(e.target.value)} placeholder="腾讯云账号 APPID" />
        </Field>
        <Field label="Secret ID">
          <input
            className="input"
            type={showSecrets ? "text" : "password"}
            value={asrSecretId}
            onChange={(e) => setAsrSecretId(e.target.value)}
            placeholder={asrStatus?.configured ? "已存储（输入新值可覆盖）" : "AKID…"}
          />
        </Field>
        <Field label="Secret Key" hint="密钥不会明文显示，不会写入日志或任何导出文件。">
          <input
            className="input"
            type={showSecrets ? "text" : "password"}
            value={asrSecretKey}
            onChange={(e) => setAsrSecretKey(e.target.value)}
            placeholder={asrStatus?.configured ? "已存储（输入新值可覆盖）" : ""}
          />
        </Field>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={testAsr} disabled={testing === "asr"}>
            {testing === "asr" ? "测试中…" : "测试连接"}
          </Button>
          <Button variant="ghost" onClick={() => setShowSecrets((v) => !v)}>{showSecrets ? "隐藏明文" : "临时显示明文"}</Button>
        </div>
        {asrMsg ? (
          <div style={{ marginTop: 8, fontSize: 13, color: asrMsg.ok ? tokens.ok : tokens.danger }}>{asrMsg.text}</div>
        ) : null}
      </Panel>

      <Panel title="LLM（OpenAI 兼容接口）">
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          状态：
          {llmStatus?.configured ? (
            <>
              <Badge tone="ok">已配置</Badge>
              <span style={{ marginLeft: 8, color: tokens.textDim }}>
                {llmStatus.model} @ {llmStatus.baseUrl} · Key 尾号 {llmStatus.keyTail}
              </span>
            </>
          ) : (
            <Badge tone="dim">未配置</Badge>
          )}
        </div>
        <Field label="Base URL" hint="例如 https://api.openai.com/v1 或其他兼容服务地址">
          <input className="input" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="模型名">
          <input className="input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="gpt-4o-mini / glm-4-flash / …" />
        </Field>
        <Field label="API Key" hint="仅保存在本地数据库 settings 表，界面只显示脱敏尾部。">
          <input
            className="input"
            type={showSecrets ? "text" : "password"}
            value={llmApiKey}
            onChange={(e) => setLlmApiKey(e.target.value)}
            placeholder={llmStatus?.configured ? "已存储（输入新值可覆盖）" : "sk-…"}
          />
        </Field>
        <Button onClick={testLlm} disabled={testing === "llm"}>
          {testing === "llm" ? "测试中…" : "测试连接"}
        </Button>
        {llmMsg ? (
          <div style={{ marginTop: 8, fontSize: 13, color: llmMsg.ok ? tokens.ok : tokens.danger }}>{llmMsg.text}</div>
        ) : null}
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
