export const inputStyle = {
    height: 40, borderRadius: 8, border: "none", padding: "0 12px",
    background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
    outline: "none", width: "100%",
} as const;

export const labelStyle = { fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, display: "block" } as const;

export const providerLabels: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    deepseek: "DeepSeek",
    qwen: "通义千问",
    glm: "智谱 GLM",
    moonshot: "月之暗面",
    custom: "自定义中转",
};

export interface ModelConfig {
    id: string;
    provider: string;
    model_id: string;
    model_label: string;
    visible: number;
    is_custom: number;
    sort_order: number;
}

export interface ProviderConfig {
    id: string;
    provider: string;
    label: string;
    visible: number;
}
