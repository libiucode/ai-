import { useCallback, useEffect, useRef, useState } from "react";
import type { FrameworkRule } from "../../shared/contracts";
import { Badge, Button, Panel } from "../ui/basics";
import {
  FrameworkEditSchema,
  PRIORITY_LABEL,
  RULE_TYPE_LABEL,
  type FrameworkEdit,
} from "./frameworkSchema";

const RULE_TYPES: FrameworkRule["ruleType"][] = [
  "bannedWord",
  "absolutization",
  "unverifiedClaim",
  "repetition",
  "hotWord",
];
const PRIORITIES: Array<0 | 1 | 2> = [2, 1, 0];

export function FrameworkPage() {
  const [framework, setFramework] = useState<FrameworkEdit | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    window.appApi
      .listFrameworks()
      .then((fws) => {
        if (fws.length > 0) setFramework(fws[0] as FrameworkEdit);
        else {
          setFramework({
            id: crypto.randomUUID(),
            name: "默认话术框架",
            productFacts: "",
            steps: [],
            rules: [],
            updatedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => setSaveMsg({ ok: false, text: "加载话术失败" }));
  }, []);

  const update = useCallback((patch: Partial<FrameworkEdit>) => {
    setFramework((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveMsg(null);
  }, []);

  function validate(): FrameworkEdit | null {
    if (!framework) return null;
    const parsed = FrameworkEditSchema.safeParse(framework);
    if (!parsed.success) {
      setValidationErrors(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      return null;
    }
    // regex sanity check for user-provided patterns
    const regexErrors: string[] = [];
    for (const r of parsed.data.rules) {
      try {
        new RegExp(r.pattern);
      } catch {
        regexErrors.push(`规则 “${r.pattern}” 不是合法的正则表达式`);
      }
    }
    if (regexErrors.length) {
      setValidationErrors(regexErrors);
      return null;
    }
    setValidationErrors([]);
    return parsed.data;
  }

  async function doSave() {
    const valid = validate();
    if (!valid) {
      setSaveMsg({ ok: false, text: "校验未通过，请修正下方错误" });
      return;
    }
    const ok = await window.appApi.saveFramework({ ...valid, updatedAt: new Date().toISOString() });
    setSaveMsg(
      ok
        ? { ok: true, text: "已保存" }
        : { ok: false, text: "保存失败（服务端校验未通过）" },
    );
  }

  function doExport() {
    if (!framework) return;
    const blob = new Blob([JSON.stringify({ framework, simulated: false }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `framework-${framework.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport(file: File) {
    try {
      const text = await file.text();
      const raw = JSON.parse(text) as { framework?: unknown } | Record<string, unknown>;
      const candidate = (raw as { framework?: unknown }).framework ?? raw;
      const parsed = FrameworkEditSchema.safeParse(candidate);
      if (!parsed.success) {
        setValidationErrors(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
        setSaveMsg({ ok: false, text: "导入失败：JSON 结构不符合话术 Schema" });
        return;
      }
      setFramework(parsed.data);
      setValidationErrors([]);
      setSaveMsg({ ok: true, text: "导入成功，检查内容后请保存" });
    } catch {
      setSaveMsg({ ok: false, text: "导入失败：不是合法 JSON" });
    }
  }

  if (!framework) return <div className="loading">加载中…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel title="基本信息">
        <label className="field">
          <div className="field-label">话术名称</div>
          <input
            className="input"
            value={framework.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <label className="field">
          <div className="field-label">
            已核实商品事实
            <Badge tone="info">允许作为 AI 判断输入</Badge>
          </div>
          <textarea
            className="input textarea"
            style={{ height: 80 }}
            placeholder={"只填写经核实的客观事实，每行一条。例如：\n304不锈钢内胆\n实验室恒温测试12小时（25℃环境）"}
            value={framework.productFacts}
            onChange={(e) => update({ productFacts: e.target.value })}
          />
          <div className="field-hint">
            与“建议参考话术”不同：这里的内容会被 AI 当作已核实事实用于判断，未核实的内容不要填写。
          </div>
        </label>
      </Panel>

      <Panel
        title={`话术步骤（${framework.steps.length}）`}
        actions={
          <Button
            onClick={() =>
              update({
                steps: [
                  ...framework.steps,
                  { id: crypto.randomUUID(), frameworkId: framework.id, name: "新步骤", priority: 1, maxWaitMs: 120000 },
                ],
              })
            }
          >
            + 添加步骤
          </Button>
        }
      >
        {framework.steps.length === 0 ? <Empty text="还没有步骤。话术步骤用于检测讲解覆盖情况。" /> : null}
        {framework.steps.map((step, idx) => (
          <div key={step.id} className="edit-row">
            <input
              className="input"
              style={{ flex: 2 }}
              value={step.name}
              onChange={(e) => {
                const steps = [...framework.steps];
                steps[idx] = { ...step, name: e.target.value };
                update({ steps });
              }}
            />
            <select
              className="input select"
              style={{ flex: 1 }}
              value={step.priority}
              onChange={(e) => {
                const steps = [...framework.steps];
                const found = PRIORITIES.find((p) => p === Number(e.target.value));
                steps[idx] = { ...step, priority: found ?? 0 };
                update({ steps });
              }}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
            <input
              type="number"
              className="input"
              style={{ flex: 1 }}
              value={Math.round(step.maxWaitMs / 1000)}
              min={0}
              onChange={(e) => {
                const steps = [...framework.steps];
                steps[idx] = { ...step, maxWaitMs: Math.max(0, Number(e.target.value)) * 1000 };
                update({ steps });
              }}
              title="最长等待时间（秒）"
            />
            <span className="field-hint" style={{ width: 90 }}>秒内需完成</span>
            <Button variant="ghost" onClick={() => update({ steps: framework.steps.filter((s) => s.id !== step.id) })}>删除</Button>
          </div>
        ))}
      </Panel>

      <Panel
        title={`自定义规则（${framework.rules.length}）`}
        actions={
          <Button
            onClick={() =>
              update({
                rules: [
                  ...framework.rules,
                  { id: crypto.randomUUID(), frameworkId: framework.id, stepId: null, ruleType: "bannedWord", pattern: "", enabled: true },
                ],
              })
            }
          >
            + 添加规则
          </Button>
        }
      >
        <div className="field-hint" style={{ marginBottom: 8 }}>
          禁用词/高风险词命中标记为严重；热词命中仅作提示（<Badge tone="dim">风险表达只触发提示，不直接判定违法</Badge>）。
          支持正则表达式。
        </div>
        {framework.rules.length === 0 ? <Empty text="还没有自定义规则。默认规则（绝对化用语/未核实宣称）始终生效。" /> : null}
        {framework.rules.map((rule, idx) => (
          <div key={rule.id} className="edit-row">
            <select
              className="input select"
              value={rule.ruleType}
              onChange={(e) => {
                const rules = [...framework.rules];
                rules[idx] = { ...rule, ruleType: e.target.value as FrameworkRule["ruleType"] };
                update({ rules });
              }}
            >
              {RULE_TYPES.map((t) => (
                <option key={t} value={t}>{RULE_TYPE_LABEL[t]}</option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="词或正则，如 最好|第一"
              value={rule.pattern}
              onChange={(e) => {
                const rules = [...framework.rules];
                rules[idx] = { ...rule, pattern: e.target.value };
                update({ rules });
              }}
            />
            <select
              className="input select"
              value={rule.stepId ?? ""}
              onChange={(e) => {
                const rules = [...framework.rules];
                rules[idx] = { ...rule, stepId: e.target.value || null };
                update({ rules });
              }}
            >
              <option value="">不绑定步骤</option>
              {framework.steps.map((s) => (
                <option key={s.id} value={s.id}>仅步骤：{s.name}</option>
              ))}
            </select>
            <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => {
                  const rules = [...framework.rules];
                  rules[idx] = { ...rule, enabled: e.target.checked };
                  update({ rules });
                }}
              />
              启用
            </label>
            <Button variant="ghost" onClick={() => update({ rules: framework.rules.filter((r) => r.id !== rule.id) })}>删除</Button>
          </div>
        ))}
      </Panel>

      <Panel title="保存与导入导出">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={doSave}>保存（Zod 校验）</Button>
          <Button onClick={doExport}>导出 JSON</Button>
          <Button onClick={() => fileRef.current?.click()}>导入 JSON</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
              e.target.value = "";
            }}
          />
          {saveMsg ? <span className={saveMsg.ok ? "toast-ok" : "toast-err"}>{saveMsg.text}</span> : null}
        </div>
        {validationErrors.length > 0 ? (
          <div className="callout callout-danger">
            {validationErrors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
