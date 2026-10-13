import type { CSSProperties, ReactNode } from "react";

/* Minimal UI primitives shared across pages. Visual styling now lives in
   styles.css (design tokens + component classes); components are thin
   structural wrappers. `tokens` is kept for the few inline color spots. */

export const tokens = {
  bg: "#f5f6f8",
  panel: "#ffffff",
  border: "#e5e7eb",
  text: "#111827",
  textDim: "#6b7280",
  accent: "#2563eb",
  accentSoft: "#eff6ff",
  danger: "#dc2626",
  dangerSoft: "#fef2f2",
  warn: "#d97706",
  warnSoft: "#fffbeb",
  ok: "#059669",
  okSoft: "#ecfdf5",
  radius: 10,
} as const;

export function Page({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="content-inner">
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Panel({
  title,
  children,
  className,
  actions,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      {title ? (
        <div className="panel-head">
          <div className="panel-title">{title}</div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Button(props: {
  onClick?: () => void;
  children: ReactNode;
  variant?: "primary" | "default" | "danger" | "ghost";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const { variant = "default", className, children, ...rest } = props;
  return (
    <button {...rest} className={`btn${variant !== "default" ? ` btn-${variant}` : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </button>
  );
}

export function Badge({
  tone,
  children,
  className,
  pulse,
}: {
  tone: "ok" | "warn" | "danger" | "info" | "dim";
  children: ReactNode;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}${className ? ` ${className}` : ""}`}>
      {pulse ? <span className="dot dot-pulse" /> : null}
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </label>
  );
}

/** Layout-only; visuals come from the .input/.select/.textarea classes. */
export const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
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
