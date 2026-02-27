import { ReactNode } from "react";


export function Loading() {
    return (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>
            加载中...
        </div>
    );
}

export function EmptyState({ title, desc }: { title: string; desc: string }) {
    return (
        <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)", background: "var(--bg-card)", borderRadius: 12, border: "1px dashed var(--bg-border)" }}>
            <p style={{ fontSize: 15, marginBottom: 8, color: "var(--text-primary)", fontWeight: 500 }}>{title}</p>
            <p style={{ fontSize: 13 }}>{desc}</p>
        </div>
    );
}

export function ErrorBanner({ error }: { error: string }) {
    return (
        <div style={{ padding: 16, background: "rgba(240, 68, 68, 0.1)", color: "#f04444", borderRadius: 8, marginBottom: 20 }}>
            {error}
        </div>
    );
}

export function PageHeader({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32 }}>
            <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>{title}</h1>
                <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>{desc}</p>
            </div>
            {action && <div>{action}</div>}
        </div>
    );
}

export function PrimaryButton({ onClick, icon: Icon, label, disabled = false }: { onClick: () => void; icon?: any; label: string; disabled?: boolean }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 20px",
                borderRadius: 8, border: "none", cursor: disabled ? "not-allowed" : "pointer",
                background: disabled ? "var(--bg-border)" : "var(--accent-gold)",
                color: disabled ? "var(--text-secondary)" : "#000",
                fontSize: 14, fontWeight: 600, transition: "opacity 0.2s",
                opacity: disabled ? 0.7 : 1
            }}
        >
            {Icon && <Icon size={16} />}
            {label}
        </button>
    );
}

export function Badge({ children, color = "var(--text-secondary)", bg = "var(--bg-card)" }: { children: ReactNode; color?: string; bg?: string }) {
    return (
        <span style={{
            padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: bg, color, display: "inline-flex", alignItems: "center"
        }}>
            {children}
        </span>
    );
}
