import type { CSSProperties, ReactNode } from "react";

/* Minimal UI primitives shared across pages. Inline styles keep the MVP
   dependency-free; layout tokens are defined once here. */

export const tokens = {
  bg: "#f7f8fa",
  panel: "#ffffff",
  border: "#e5e7eb",
  text: "#1f2937",
  textDim: "#6b7280",
  accent: "#2563eb",
  accentSoft: "#eff6ff",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  warn: "#b45309",
  warnSoft: "#fffbeb",
  ok: "#047857",
  okSoft: "#ecfdf5",
  radius: 8,
} as const;

export function Page({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0, color: tokens.text }}>{title}</h1>
        <div style={{ display: "flex", gap: 8 }}>{actions}</div>
      </div>
      {children}
    </div>
  );
}

export function Panel({ title, children, style, actions }: { title?: string; children: ReactNode; style?: CSSProperties; actions?: ReactNode }) {
  return (
    <div style={{ background: tokens.panel, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius, padding: 16, ...style }}>
      {title ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{title}</div>
          {actions ? <div style={{ display: "flex", gap: 8 }}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Button(props: {
  onClick?: () => void;
  children: ReactNode;
  variant?: "primary" | "default" | "danger" | "ghost";
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const { variant = "default", ...rest } = props;
  const base: CSSProperties = {
    padding: "6px 14px",
    borderRadius: 6,
    fontSize: 13,
    cursor: props.disabled ? "not-allowed" : "pointer",
    border: `1px solid ${tokens.border}`,
    background: "#fff",
    color: tokens.text,
    opacity: props.disabled ? 0.5 : 1,
  };
  if (variant === "primary") {
    base.background = tokens.accent;
    base.borderColor = tokens.accent;
    base.color = "#fff";
  } else if (variant === "danger") {
    base.background = tokens.dangerSoft;
    base.borderColor = tokens.danger;
    base.color = tokens.danger;
  } else if (variant === "ghost") {
    base.background = "transparent";
  }
  return <button {...rest} style={{ ...base, ...props.style }} />;
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "info" | "dim"; children: ReactNode }) {
  const map = {
    ok: { bg: tokens.okSoft, fg: tokens.ok },
    warn: { bg: tokens.warnSoft, fg: tokens.warn },
    danger: { bg: tokens.dangerSoft, fg: tokens.danger },
    info: { bg: tokens.accentSoft, fg: tokens.accent },
    dim: { bg: "#f3f4f6", fg: tokens.textDim },
  } as const;
  const c = map[tone];
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 12, background: c.bg, color: c.fg }}>
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 13, color: tokens.text, marginBottom: 4 }}>{label}</div>
      {children}
      {hint ? <div style={{ fontSize: 12, color: tokens.textDim, marginTop: 4 }}>{hint}</div> : null}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 10px",
  borderRadius: 6,
  border: `1px solid ${tokens.border}`,
  fontSize: 13,
  color: tokens.text,
  background: "#fff",
};

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const SEVERITY_TONE: Record<string, "danger" | "warn" | "info" | "dim"> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  warning: "警告",
  info: "提示",
};

export const TYPE_LABEL: Record<string, string> = {
  bannedWord: "禁用词",
  absolutization: "绝对化用语",
  unverifiedClaim: "未核实宣称",
  repetition: "话术重复",
  pace: "语速异常",
  silence: "长时间静音",
  frameworkStep: "话术步骤缺失",
  other: "其他",
};

export const CAPTURE_STATE_LABEL: Record<string, string> = {
  idle: "未启动",
  capturing: "采集中",
  paused: "已暂停",
  error: "采集错误",
};

export const ASR_STATE_LABEL: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "识别中",
  reconnecting: "重连中",
  closed: "已断开",
  error: "错误",
};
