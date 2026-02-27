import { useState, useRef, useEffect } from "react";
import { Send, Users, MessageSquare, Loader2 } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { API_BASE } from "../config/api";
import { withLocalApiAuth } from "../lib/agentAuth";
import { useAgentModelDisplay } from "../hooks/useAgentModelDisplay";

interface Message {
    id: string;
    agent: string;
    name: string;
    text: string;
    isComplete: boolean;
    type: "system" | "agent";
}

export default function DebateRoom() {
    const { currentProject } = useProject();
    const { addToast } = useToast();
    const { models } = useAgentModelDisplay();
    const [topic, setTopic] = useState("");
    const [isDebating, setIsDebating] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll inside chat
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const startDebate = async () => {
        if (!topic.trim()) return;
        if (!currentProject) {
            addToast("warning", "请先选择一个项目");
            return;
        }

        setIsDebating(true);
        // Add user topic message as a system note
        setMessages([{ id: Date.now().toString(), agent: "user", name: "你抛出的话题", text: topic, isComplete: true, type: "system" }]);

        try {
            const response = await fetch(`${API_BASE}/api/debate/start`, {
                method: "POST",
                headers: withLocalApiAuth({ "Content-Type": "application/json" }),
                body: JSON.stringify({ project_id: currentProject.id, topic }),
            });

            if (!response.body) throw new Error("No response body");
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");

            let activeAgentMessageId = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.substring(6));

                            if (data.event === "system") {
                                setMessages(prev => [...prev, {
                                    id: Date.now().toString(),
                                    agent: "system", name: "系统", text: data.text, isComplete: true, type: "system"
                                }]);
                            } else if (data.event === "agent_start") {
                                const newId = Date.now().toString() + Math.random();
                                activeAgentMessageId = newId;
                                setMessages(prev => [...prev, {
                                    id: newId,
                                    agent: data.agent, name: data.name, text: "", isComplete: false, type: "agent"
                                }]);
                            } else if (data.event === "token") {
                                setMessages(prev => prev.map(m =>
                                    m.id === activeAgentMessageId
                                        ? { ...m, text: m.text + data.text }
                                        : m
                                ));
                            } else if (data.event === "agent_done") {
                                setMessages(prev => prev.map(m =>
                                    m.id === activeAgentMessageId
                                        ? { ...m, isComplete: true }
                                        : m
                                ));
                            } else if (data.event === "error") {
                                setMessages(prev => [...prev, {
                                    id: Date.now().toString(),
                                    agent: "system", name: "错误", text: data.text || "未知错误", isComplete: true, type: "system"
                                }]);
                            }
                        } catch (e) {
                            console.error("Parse error on SSE line", line, e);
                        }
                    }
                }
            }
        } catch (e) {
            addToast("error", "围读服务连接失败");
            console.error(e);
        } finally {
            setIsDebating(false);
        }
    };

    const getAgentColor = (agent: string) => {
        switch (agent) {
            case "reader": return "var(--status-active)";
            case "villain": return "#e91e63";
            case "architect": return "#ff9800";
            case "director": return "var(--accent-gold)";
            default: return "var(--text-secondary)";
        }
    };

    if (!currentProject) {
        return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先建立或选择一个项目即可开启剧本围读。</div>;
    }
    const debateModelInfo = models.debate_room;
    const debateModelText =
        debateModelInfo.secondaryModelLabel && debateModelInfo.secondaryModelLabel !== debateModelInfo.modelLabel
            ? `${debateModelInfo.modelLabel} / 导演:${debateModelInfo.secondaryModelLabel}`
            : debateModelInfo.modelLabel;

    return (
        <div style={{ padding: 40, maxWidth: 900, margin: "0 auto", height: "100%", display: "flex", flexDirection: "column" }}>
            <header style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
                <Users size={28} color="var(--accent-gold)" />
                <div>
                    <h1 style={{ margin: 0, fontSize: 24, color: "var(--text-primary)" }}>多Agent推演室 (剧本围读)</h1>
                    <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 13 }}>
                        抛出一个剧情节点难题，让挑剔读者、反派智囊、世界观构架师围坐一桌为你推演方案。
                    </p>
                    <div
                        title={`围读模型来源：${debateModelInfo.source}`}
                        style={{
                            marginTop: 8,
                            display: "inline-flex",
                            alignItems: "center",
                            borderRadius: 999,
                            border: debateModelInfo.enabled ? "1px solid rgba(233, 30, 99, 0.32)" : "1px solid rgba(233, 30, 99, 0.42)",
                            padding: "3px 10px",
                            fontSize: 11,
                            color: debateModelInfo.enabled ? "#e91e63" : "var(--text-secondary)",
                            background: debateModelInfo.enabled ? "rgba(233, 30, 99, 0.08)" : "rgba(233, 30, 99, 0.04)",
                            maxWidth: 360,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        }}
                    >
                        当前生效模型：{debateModelText}{!debateModelInfo.enabled ? "（已禁用）" : ""}
                    </div>
                </div>
            </header>

            {/* Chat Area */}
            <div style={{
                flex: 1, background: "var(--bg-sidebar)", borderRadius: 12, border: "1px solid var(--bg-border)",
                display: "flex", flexDirection: "column", overflow: "hidden"
            }}>
                {/* Messages */}
                <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
                    {messages.length === 0 ? (
                        <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", opacity: 0.6, gap: 16 }}>
                            <MessageSquare size={48} />
                            <span>在这里抛出你的剧情卡壳点，例如：“主角拿到魔剑后怎么安全下山？”</span>
                        </div>
                    ) : (
                        messages.map((m) => (
                            <div key={m.id} style={{
                                display: "flex", gap: 12,
                                justifyContent: m.type === "system" && m.agent === "user" ? "flex-end" : "flex-start"
                            }}>
                                {m.type === "agent" && (
                                    <div style={{
                                        width: 36, height: 36, borderRadius: "50%", background: getAgentColor(m.agent) + "20",
                                        color: getAgentColor(m.agent), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                                    }}>
                                        {m.agent === "villain" ? "😈" : m.agent === "reader" ? "🧐" : m.agent === "architect" ? "🌍" : "🎬"}
                                    </div>
                                )}

                                <div style={{
                                    maxWidth: "75%",
                                    background: m.type === "system" ? "transparent" : "var(--bg-card)",
                                    border: m.type === "system" ? "none" : "1px solid var(--bg-border)",
                                    padding: m.type === "system" ? "0 12px" : "12px 16px",
                                    borderRadius: 12,
                                    color: m.type === "system" ? "var(--text-secondary)" : "var(--text-primary)",
                                    fontStyle: m.type === "system" ? "italic" : "normal",
                                    fontSize: 14, lineHeight: 1.6
                                }}>
                                    {m.type === "agent" && (
                                        <div style={{ fontSize: 12, fontWeight: 600, color: getAgentColor(m.agent), marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                                            {m.name} {!m.isComplete && <span className="animate-pulse">...</span>}
                                        </div>
                                    )}
                                    <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                                </div>
                            </div>
                        ))
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Box */}
                <div style={{ padding: "16px 24px", background: "var(--bg-card)", borderTop: "1px solid var(--bg-border)", display: "flex", gap: 12, alignItems: "flex-end" }}>
                    <textarea
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        disabled={isDebating}
                        placeholder="抛出你想推演的剧情难题..."
                        style={{
                            flex: 1, background: "var(--bg-input)", border: "1px solid var(--bg-border)",
                            borderRadius: 8, padding: "12px 16px", color: "var(--text-primary)", fontSize: 14,
                            resize: "none", height: 80, fontFamily: "inherit", outline: "none"
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                startDebate();
                            }
                        }}
                    />
                    <button
                        disabled={isDebating || !topic.trim()}
                        onClick={startDebate}
                        style={{
                            width: 50, height: 50, borderRadius: "50%", border: "none", cursor: isDebating || !topic.trim() ? "not-allowed" : "pointer",
                            background: isDebating || !topic.trim() ? "var(--bg-border)" : "var(--accent-gold)",
                            color: isDebating || !topic.trim() ? "var(--text-secondary)" : "#111",
                            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.2s"
                        }}>
                        {isDebating ? <Loader2 size={24} className="animate-spin" /> : <Send size={24} />}
                    </button>
                </div>
            </div>
        </div>
    );
}
