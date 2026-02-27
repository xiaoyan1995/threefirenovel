import { ReactNode } from "react";
import { X, Trash2, Save } from "lucide-react";
import { PrimaryButton } from "../ui";

interface DrawerProps {
    isOpen: boolean;
    title: string;
    onClose: () => void;
    onSave?: () => void;
    saveLabel?: string;
    onDelete?: () => void;
    children: ReactNode;
    isSaving?: boolean;
}

export function Drawer({ isOpen, title, onClose, onSave, saveLabel, onDelete, children, isSaving }: DrawerProps) {
    if (!isOpen) return null;

    return (
        <>
            <div
                style={{
                    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                    background: "rgba(0,0,0,0.5)", zIndex: 1000,
                    backdropFilter: "blur(2px)",
                    transition: "opacity 0.2s"
                }}
                onClick={onClose}
            />
            <div
                className="drawer-content solid-popup"
                style={{
                    position: "fixed", top: 0, right: 0, bottom: 0,
                    width: 480, maxWidth: "100vw",
                    background: "var(--bg-popup)", borderLeft: "1px solid var(--bg-border)",
                    zIndex: 1001, display: "flex", flexDirection: "column",
                    boxShadow: "-4px 0 24px rgba(0,0,0,0.2)",
                    transform: isOpen ? "translateX(0)" : "translateX(100%)",
                    transition: "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)"
                }}
            >
                <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "20px 24px", borderBottom: "1px solid var(--bg-border)",
                }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
                    <button onClick={onClose} style={{
                        background: "transparent", border: "none", color: "var(--text-secondary)",
                        cursor: "pointer", display: "flex", padding: 4, borderRadius: 4,
                    }}>
                        <X size={20} />
                    </button>
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                    {children}
                </div>

                <div style={{
                    padding: "16px 24px", borderTop: "1px solid var(--bg-border)",
                    display: "flex", justifyContent: onDelete ? "space-between" : "flex-end",
                    background: "var(--bg-popup-soft)",
                }}>
                    {onDelete && (
                        <button onClick={() => { if (window.confirm("确定要删除吗？此操作无法恢复。")) onDelete(); }} style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "8px 16px",
                            background: "transparent", border: "1px solid rgba(239,68,68,0.3)",
                            color: "#f87171", borderRadius: 8, cursor: "pointer", fontSize: 13,
                        }}>
                            <Trash2 size={14} />删除
                        </button>
                    )}
                    <div style={{ display: "flex", gap: 12 }}>
                        <button onClick={onClose} style={{
                            padding: "8px 16px", background: "transparent", border: "1px solid var(--bg-border)",
                            color: "var(--text)", borderRadius: 8, cursor: "pointer", fontSize: 13,
                        }}>
                            取消
                        </button>
                        {onSave && (
                            <PrimaryButton onClick={onSave} loading={isSaving}>
                                <Save size={14} /> {saveLabel || "保存"}
                            </PrimaryButton>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
