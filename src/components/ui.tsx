import type { ReactNode } from "react";

/* ── Loading Spinner ── */
export function Loading({ text = "加载中…" }: { text?: string }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: 64, gap: 12, color: "var(--text-secondary)",
    }}>
      <span style={{
        width: 28, height: 28, border: "3px solid var(--border)",
        borderTopColor: "var(--accent)", borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }} />
      <span style={{ fontSize: 14 }}>{text}</span>
    </div>
  );
}

/* ── Empty State ── */
export function EmptyState({
  icon, title, description, action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: 64, gap: 12, color: "var(--text-secondary)",
    }}>
      {icon && <span style={{ fontSize: 40, opacity: 0.4 }}>{icon}</span>}
      <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>{title}</span>
      {description && <span style={{ fontSize: 13, maxWidth: 320, textAlign: "center" }}>{description}</span>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/* ── Error Banner ── */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
      background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
      borderRadius: 8, margin: "12px 0", color: "#f87171", fontSize: 13,
    }}>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 6, padding: "4px 12px", color: "#f87171", cursor: "pointer",
          fontSize: 12,
        }}>
          重试
        </button>
      )}
    </div>
  );
}

/* ── Page Header ── */
export function PageHeader({
  title, subtitle, action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      marginBottom: 24,
    }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: 0 }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0" }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── Primary Button ── */
export function PrimaryButton({
  children, onClick, disabled, loading,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "8px 18px", borderRadius: 8, border: "none",
        background: disabled ? "var(--border)" : "var(--accent)",
        color: disabled ? "var(--text-secondary)" : "#000",
        fontWeight: 600, fontSize: 13, cursor: disabled ? "default" : "pointer",
        opacity: loading ? 0.7 : 1, transition: "all 0.15s",
      }}
    >
      {loading && <span style={{
        width: 14, height: 14, border: "2px solid rgba(0,0,0,0.2)",
        borderTopColor: "#000", borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }} />}
      {children}
    </button>
  );
}

/* ── Badge ── */
export function Badge({ children, color = "var(--text-secondary)" }: { children: ReactNode; color?: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      color, fontSize: 11, fontWeight: 600,
    }}>
      {children}
    </span>
  );
}
