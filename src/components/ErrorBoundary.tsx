import React, { type ReactNode } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : "未知错误";
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-base, #121212)",
          color: "var(--text-primary, #f3f3f3)",
          padding: 24,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 560,
            background: "var(--bg-card, #1e1e1e)",
            border: "1px solid var(--bg-border, #333)",
            borderRadius: 12,
            padding: 20,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20 }}>页面出现错误</h2>
          <p style={{ margin: "10px 0 0", color: "var(--text-secondary, #aaa)", lineHeight: 1.6 }}>
            应用已阻止白屏扩散。你可以刷新页面继续创作。
          </p>
          {this.state.message ? (
            <pre
              style={{
                marginTop: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "rgba(0,0,0,0.18)",
                borderRadius: 8,
                padding: 10,
                fontSize: 12,
                color: "#ffb3b3",
              }}
            >
              {this.state.message}
            </pre>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "8px 14px",
                background: "var(--accent-gold, #f5c242)",
                color: "#111",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              刷新应用
            </button>
          </div>
        </div>
      </div>
    );
  }
}
