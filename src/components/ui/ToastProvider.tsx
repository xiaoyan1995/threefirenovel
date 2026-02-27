import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { X, CheckCircle, AlertCircle, Info, XCircle } from "lucide-react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
    id: string;
    type: ToastType;
    message: string;
}

interface ToastContextType {
    addToast: (type: ToastType, message: string) => void;
    removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const addToast = useCallback((type: ToastType, message: string) => {
        const id = Math.random().toString(36).slice(2, 9);
        setToasts((prev) => [...prev, { id, type, message }]);

        // Auto remove after 3 seconds
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 3000);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ addToast, removeToast }}>
            {children}
            <div style={{
                position: "fixed",
                top: 24,
                right: 24,
                zIndex: 9999,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                pointerEvents: "none" // Let clicks pass through empty space
            }}>
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

function ToastItem({ toast, onRemove }: { toast: Toast, onRemove: () => void }) {
    const colors = {
        success: { bg: "var(--accent-gold-dim)", text: "var(--accent-gold)", border: "var(--accent-gold)" },
        error: { bg: "#FECACA", text: "#DC2626", border: "#F87171" },
        warning: { bg: "#FEF08A", text: "#D97706", border: "#FBBF24" },
        info: { bg: "#DBEAFE", text: "#2563EB", border: "#93C5FD" }
    };

    const icons = {
        success: <CheckCircle size={16} />,
        error: <XCircle size={16} />,
        warning: <AlertCircle size={16} />,
        info: <Info size={16} />
    };

    const c = colors[toast.type];

    return (
        <div style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "var(--bg-base)",
            border: `1px solid ${c.border}`,
            padding: "12px 16px",
            borderRadius: 8,
            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
            width: 300,
            pointerEvents: "auto",
            animation: "slideInRight 0.3s ease-out forwards"
        }}>
            <div style={{ color: c.text }}>{icons[toast.type]}</div>
            <div style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
                {toast.message}
            </div>
            <button
                onClick={onRemove}
                style={{
                    background: "none", border: "none", color: "var(--text-secondary)",
                    cursor: "pointer", display: "flex", alignItems: "center", padding: 4
                }}
            >
                <X size={14} />
            </button>
            <style>
                {`
          @keyframes slideInRight {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}
            </style>
        </div>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (context === undefined) {
        throw new Error("useToast must be used within a ToastProvider");
    }
    return context;
}
