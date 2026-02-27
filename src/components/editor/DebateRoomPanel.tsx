import { useState, useRef, useEffect } from "react";
import { Send, Loader2, MessageSquare, X, FileText } from "lucide-react";
import { useProject } from "../../context/ProjectContext";
import { useToast } from "../ui/ToastProvider";
import { API_BASE } from "../../config/api";
import { withLocalApiAuth } from "../../lib/agentAuth";

interface Message {
    id: string;
    agent: string;
    name: string;
    text: string;
    isComplete: boolean;
    type: "system" | "agent";
}

interface DebateRoomPanelProps {
    /** 从编辑器传入的引用文本（选中拖入的文字） */
    quotedText: string;
    /** 清除引用文本的回调 */
    onClearQuote: () => void;
}

const getAgentColor = (agent: string) => {
    switch (agent) {
        case "reader": return "var(--status-active)";
        case "villain": return "#e91e63";
        case "architect": return "#ff9800";
        case "director": return "var(--accent-gold)";
        default: return "var(--text-secondary)";
    }
};

const getAgentEmoji = (agent: string) => {
    switch (agent) {
        case "reader": return "🧐";
        case "villain": return "😈";
        case "architect": return "🌍";
        case "director": return "🎬";
        default: return "💬";
    }
};

export function DebateRoomPanel({ quotedText, onClearQuote }: DebateRoomPanelProps) {
    const { currentProject } = useProject();
    const { addToast } = useToast();
    const [topic, setTopic] = useState("");
    const [isDebating, setIsDebating] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [showFullQuote, setShowFullQuote] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const dropZoneRef = useRef<HTMLDivElement>(null);
    const [isDragOver, setIsDragOver] = useState(false);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // 处理拖拽放置
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    };

    const handleDragLeave = () => {
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        const droppedText = e.dataTransfer.getData("text/plain");
        if (droppedText.trim()) {
            // 通过 Workshop 的 state 来设置 quotedText
            // 这里触发一个自定义事件让 Workshop 知道
            window.dispatchEvent(new CustomEvent("debate-drop-text", { detail: droppedText }));
        }
    };

    const startDebate = async () => {
        if (!topic.trim() && !quotedText.trim()) return;
        if (!currentProject) {
            addToast("warning", "请先选择一个项目");
            return;
        }

        setIsDebating(true);

        // 组合发送内容：引用块 + 用户诉求
        const fullTopic = quotedText
            ? `【参考文本】\n${quotedText}\n\n【我的问题】\n${topic || "请围绕以上文本进行围读讨论"}`
            : topic;

        // 显示用户消息
        const userDisplay = quotedText
            ? `📋 [引用 ${quotedText.length} 字]\n${topic || "请围绕以上文本进行围读讨论"}`
            : topic;

        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            agent: "user", name: "你", text: userDisplay, isComplete: true, type: "system"
        }]);

        try {
            const response = await fetch(`${API_BASE}/api/debate/start`, {
                method: "POST",
                headers: withLocalApiAuth({ "Content-Type": "application/json" }),
                body: JSON.stringify({ project_id: currentProject.id, topic: fullTopic }),
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
                                    m.id === activeAgentMessageId ? { ...m, text: m.text + data.text } : m
                                ));
                            } else if (data.event === "agent_done") {
                                setMessages(prev => prev.map(m =>
                                    m.id === activeAgentMessageId ? { ...m, isComplete: true } : m
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
            setTopic("");
            onClearQuote();
        }
    };

    // 引用块预览文字（前80字）
    const quotePreview = quotedText.length > 80
        ? quotedText.substring(0, 80) + "..."
        : quotedText;

    return (
        <div
            ref={dropZoneRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
                display: "flex", flexDirection: "column", height: "100%",
                border: isDragOver ? "2px dashed var(--accent-gold)" : "none",
                borderRadius: 8,
                transition: "border 0.2s",
            }}
        >
            {/* 拖拽提示遮罩 */}
            {isDragOver && (
                <div style={{
                    position: "absolute", inset: 0, background: "rgba(255,193,7,0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    borderRadius: 8, zIndex: 10, pointerEvents: "none"
                }}>
                    <span style={{ fontSize: 13, color: "var(--accent-gold)", fontWeight: 600 }}>
                        📋 松手即可引用到围读
                    </span>
                </div>
            )}

            {/* 消息区 */}
            <div style={{
                flex: 1, overflowY: "auto", padding: 12,
                display: "flex", flexDirection: "column", gap: 10,
                background: "var(--bg-card)", borderRadius: 8,
            }}>
                {messages.length === 0 ? (
                    <div style={{
                        height: "100%", display: "flex", flexDirection: "column",
                        alignItems: "center", justifyContent: "center",
                        color: "var(--text-secondary)", opacity: 0.5, gap: 8, textAlign: "center"
                    }}>
                        <MessageSquare size={28} />
                        <span style={{ fontSize: 11, lineHeight: 1.5 }}>
                            选中左侧文字拖到这里，<br />或直接输入你的剧情卡壳点
                        </span>
                    </div>
                ) : (
                    messages.map((m) => (
                        <div key={m.id} style={{
                            display: "flex", gap: 8,
                            justifyContent: m.type === "system" && m.agent === "user" ? "flex-end" : "flex-start"
                        }}>
                            {m.type === "agent" && (
                                <div style={{
                                    width: 24, height: 24, borderRadius: "50%",
                                    background: getAgentColor(m.agent) + "20",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    flexShrink: 0, fontSize: 12
                                }}>
                                    {getAgentEmoji(m.agent)}
                                </div>
                            )}
                            <div style={{
                                maxWidth: "85%",
                                background: m.type === "system" ? "transparent" : "var(--bg)",
                                border: m.type === "system" ? "none" : "1px solid var(--bg-border)",
                                padding: m.type === "system" ? "0 8px" : "8px 10px",
                                borderRadius: 8,
                                color: m.type === "system" ? "var(--text-secondary)" : "var(--text-primary)",
                                fontStyle: m.type === "system" ? "italic" : "normal",
                                fontSize: 12, lineHeight: 1.6
                            }}>
                                {m.type === "agent" && (
                                    <div style={{
                                        fontSize: 10, fontWeight: 600, color: getAgentColor(m.agent),
                                        marginBottom: 2, display: "flex", alignItems: "center", gap: 4
                                    }}>
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

            {/* 引用文本块 */}
            {quotedText && (
                <div style={{
                    margin: "8px 0 0",
                    padding: "8px 10px",
                    background: "var(--bg-input)",
                    border: "1px solid var(--accent-gold-dim)",
                    borderRadius: 8,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    position: "relative",
                }}>
                    <div style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        marginBottom: 4
                    }}>
                        <span style={{
                            fontSize: 10, fontWeight: 600, color: "var(--accent-gold)",
                            display: "flex", alignItems: "center", gap: 4
                        }}>
                            <FileText size={10} /> 引用文本 · {quotedText.length}字
                        </span>
                        <button onClick={onClearQuote} style={{
                            background: "none", border: "none", cursor: "pointer",
                            color: "var(--text-secondary)", padding: 0, display: "flex"
                        }}>
                            <X size={12} />
                        </button>
                    </div>
                    <div
                        onClick={() => setShowFullQuote(!showFullQuote)}
                        style={{
                            cursor: "pointer", lineHeight: 1.5,
                            maxHeight: showFullQuote ? 120 : 32, overflow: "hidden",
                            transition: "max-height 0.2s"
                        }}
                    >
                        {showFullQuote ? quotedText : quotePreview}
                    </div>
                    {quotedText.length > 80 && (
                        <span style={{
                            fontSize: 10, color: "var(--accent-gold)", cursor: "pointer"
                        }} onClick={() => setShowFullQuote(!showFullQuote)}>
                            {showFullQuote ? "收起" : "展开全文"}
                        </span>
                    )}
                </div>
            )}

            {/* 输入区 */}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') startDebate(); }}
                    disabled={isDebating}
                    placeholder={quotedText ? "说说你的诉求..." : "抛出剧情难题..."}
                    style={{
                        flex: 1, height: 34, borderRadius: 8, border: "none", padding: "0 10px",
                        background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 12, outline: "none",
                    }}
                />
                <button
                    onClick={startDebate}
                    disabled={isDebating || (!topic.trim() && !quotedText.trim())}
                    style={{
                        width: 34, height: 34, borderRadius: 8, border: "none",
                        background: (isDebating || (!topic.trim() && !quotedText.trim())) ? "var(--bg-border)" : "var(--accent-gold)",
                        color: (isDebating || (!topic.trim() && !quotedText.trim())) ? "var(--text-secondary)" : "#000",
                        cursor: (isDebating || (!topic.trim() && !quotedText.trim())) ? "not-allowed" : "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "all 0.2s"
                    }}
                >
                    {isDebating ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                </button>
            </div>
        </div>
    );
}
