import { useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { ModelConfig, ProviderConfig, inputStyle, labelStyle } from "./types";
import { ModelSelect } from "./ModelSelect";

export interface AgentConfig {
    agentType: string; label: string; description: string;
    model: string; temperature: number; maxTokens: number; systemPrompt: string; enabled: boolean;
}

export const defaultAgentConfigs: AgentConfig[] = [
    { agentType: "writer_assistant", label: "写作助手对话", description: "工坊底部问答助手，支持跟随项目主模型或独立配置", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "outline_writer", label: "大纲策划", description: "设计故事结构、阶段规划和关键转折", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "character_designer", label: "角色设计", description: "创建角色档案、关系网络和成长弧光", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "chapter_writer", label: "章节写作", description: "根据大纲和角色设定撰写章节内容", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "reviewer", label: "审核编辑", description: "四维审核：剧情逻辑、人物塑造、文笔风格、节奏把控", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "editor", label: "文字润色", description: "润色文字、优化句式、提升文学性", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "conflict_reviewer", label: "冲突审查", description: "检测逻辑/人设/世界观/时间线冲突并给修复建议", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "ner_extractor", label: "实体识别（NER）", description: "识别人物/地点/组织/道具等实体，辅助上下文洞察", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "debate_room", label: "剧本围读", description: "多视角围读讨论，输出剧情落地建议", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "butterfly_simulator", label: "蝴蝶效应推演", description: "评估剧情改动对章节时间轴的连锁影响", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
    { agentType: "knowledge_profile_builder", label: "知识规则包提炼", description: "从知识库资料提炼写作规则包（知识库页面）", model: "", temperature: -1, maxTokens: -1, systemPrompt: "", enabled: true },
];

const AGENT_TOKEN_HINTS: Record<string, string> = {
    writer_assistant: "建议 800-2200，默认 1200",
    outline_writer: "建议 2500-6000，默认 4096",
    character_designer: "建议 2000-5000，默认 4096",
    chapter_writer: "建议 3000-8000，默认 4096",
    reviewer: "建议 800-2200，默认 1200",
    editor: "建议 800-2200，默认 4096",
    conflict_reviewer: "建议 1000-2600，默认 1500",
    ner_extractor: "建议 500-1200，默认 800",
    debate_room: "建议 600-1800，默认 600",
    butterfly_simulator: "建议 1000-2600，默认 1500",
    knowledge_profile_builder: "建议 1800-4200，默认 2200",
};

const normalizeMaxTokens = (value: unknown) => {
    const raw = String(value ?? "").trim();
    if (raw === "") return -1;
    const num = Number(value);
    if (!Number.isFinite(num)) return -1;
    if (num < 0) return -1;
    return Math.floor(num);
};

export function AgentConfigSection({
    agents,
    expandedAgent,
    setExpandedAgent,
    updateAgent,
    modelConfigs,
    providerConfigs,
    defaultPrompts,
    mode = "full",
}: {
    agents: AgentConfig[];
    expandedAgent: string | null;
    setExpandedAgent: (id: string | null) => void;
    updateAgent: (agentType: string, field: keyof AgentConfig, value: string | number | boolean) => void;
    modelConfigs: ModelConfig[];
    providerConfigs: ProviderConfig[];
    defaultPrompts?: Record<string, string>;
    mode?: "full" | "model" | "prompt";
}) {
    const [showBuiltinPromptByAgent, setShowBuiltinPromptByAgent] = useState<Record<string, boolean>>({});

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {agents.map((agent) => {
                const isExpanded = expandedAgent === agent.agentType;
                const showBuiltin = !!showBuiltinPromptByAgent[agent.agentType];
                const builtinPrompt = (defaultPrompts?.[agent.agentType] || "").trim();
                const showModelControls = mode !== "prompt";
                const showPromptControls = mode !== "model";
                return (
                    <div key={agent.agentType} style={{ borderRadius: 10, border: "1px solid var(--bg-border)", overflow: "hidden" }}>
                        <button onClick={() => setExpandedAgent(isExpanded ? null : agent.agentType)} style={{
                            display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "14px 16px",
                            background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
                        }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: agent.enabled ? "#4CAF50" : "var(--bg-border)" }} />
                            <div style={{ flex: 1 }}>
                                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{agent.label}</span>
                                <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: 8 }}>{agent.description}</span>
                            </div>
                            {showModelControls && agent.model && <span style={{ padding: "2px 8px", borderRadius: 4, background: "var(--accent-gold-dim)", color: "var(--accent-gold)", fontSize: 11 }}>
                                {modelConfigs.find((m) => m.model_id === agent.model)?.model_label || agent.model}
                            </span>}
                            {isExpanded ? <ChevronUp size={16} color="var(--text-secondary)" /> : <ChevronDown size={16} color="var(--text-secondary)" />}
                        </button>
                        {isExpanded && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
                                {showModelControls && (
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 80px", gap: 12, alignItems: "end" }}>
                                    <div><label style={labelStyle}>模型 (留空用默认)</label>
                                        <ModelSelect value={agent.model} onChange={(v) => updateAgent(agent.agentType, "model", v)} allowEmpty emptyLabel="跟随项目默认" modelConfigs={modelConfigs} providerConfigs={providerConfigs} /></div>
                                    <div><label style={labelStyle}>温度 (-1 用默认)</label>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <input type="range" min={-1} max={1} step={0.1} value={agent.temperature}
                                                onChange={(e) => updateAgent(agent.agentType, "temperature", +e.target.value)} style={{ flex: 1 }} />
                                            <span style={{ fontSize: 12, minWidth: 24, color: "var(--text-secondary)" }}>
                                                {agent.temperature < 0 ? "默认" : agent.temperature}
                                            </span>
                                        </div></div>
                                    <div>
                                        <label style={labelStyle}>输出Token (-1 默认)</label>
                                        <input
                                            style={inputStyle}
                                            type="number"
                                            min={-1}
                                            step={1}
                                            value={agent.maxTokens}
                                            onChange={(e) => updateAgent(agent.agentType, "maxTokens", normalizeMaxTokens(e.target.value))}
                                        />
                                        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-secondary)" }}>
                                            {AGENT_TOKEN_HINTS[agent.agentType] || "建议 1000-3000"}
                                        </div>
                                    </div>
                                    <div><label style={labelStyle}>启用</label>
                                        <button onClick={() => updateAgent(agent.agentType, "enabled", !agent.enabled)} style={{
                                            height: 40, width: "100%", borderRadius: 8, border: "none", fontSize: 12, cursor: "pointer",
                                            background: agent.enabled ? "rgba(76,175,80,0.15)" : "var(--bg-input)",
                                            color: agent.enabled ? "#4CAF50" : "var(--text-secondary)", fontWeight: 500,
                                        }}>{agent.enabled ? "已启用" : "已禁用"}</button></div>
                                    </div>
                                )}
                                {showPromptControls && (
                                    <div>
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                                        <label style={{ ...labelStyle, marginBottom: 0 }}>自定义系统提示词 (留空用内置默认)</label>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setShowBuiltinPromptByAgent((prev) => ({
                                                    ...prev,
                                                    [agent.agentType]: !prev[agent.agentType],
                                                }))
                                            }
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: 5,
                                                border: "1px solid var(--bg-border)",
                                                borderRadius: 8,
                                                background: "var(--bg-card)",
                                                color: "var(--text-secondary)",
                                                fontSize: 12,
                                                padding: "6px 10px",
                                                cursor: "pointer",
                                            }}
                                        >
                                            {showBuiltin ? <EyeOff size={13} /> : <Eye size={13} />}
                                            {showBuiltin ? "隐藏内置提示词" : "查看内置提示词"}
                                        </button>
                                    </div>
                                    <textarea value={agent.systemPrompt} onChange={(e) => updateAgent(agent.agentType, "systemPrompt", e.target.value)}
                                        placeholder="留空则使用内置的默认提示词..."
                                        style={{ ...inputStyle, height: 100, maxHeight: 300, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }} /></div>
                                )}
                                {showPromptControls && showBuiltin && (
                                    <div>
                                        <label style={labelStyle}>内置系统提示词（只读，可拉伸）</label>
                                        <textarea
                                            readOnly
                                            value={builtinPrompt || "该 Agent 暂无可展示的内置提示词。"}
                                            style={{
                                                ...inputStyle,
                                                height: 140,
                                                maxHeight: 320,
                                                overflowY: "auto",
                                                padding: "10px 12px",
                                                resize: "vertical",
                                                fontFamily: "monospace",
                                                fontSize: 12,
                                                lineHeight: 1.6,
                                                opacity: 0.95,
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
