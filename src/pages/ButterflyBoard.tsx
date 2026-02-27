import { useState } from "react";
import { Send, Loader2, GitMerge, AlertCircle, AlertTriangle, AlertOctagon, CheckCircle2 } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { useAgentModelDisplay } from "../hooks/useAgentModelDisplay";
import type { ButterflyResponse } from "../types";

export default function ButterflyBoard() {
    const { currentProject, api } = useProject();
    const { addToast } = useToast();
    const { models } = useAgentModelDisplay();

    const [supposition, setSupposition] = useState("");
    const [isSimulating, setIsSimulating] = useState(false);
    const [result, setResult] = useState<ButterflyResponse | null>(null);

    const runSimulation = async () => {
        if (!supposition.trim()) return;
        if (!currentProject) {
            addToast("warning", "请先选择项目！");
            return;
        }

        setIsSimulating(true);
        setResult(null);
        try {
            const resp = await api<ButterflyResponse>("/api/butterfly/simulate", {
                method: "POST",
                body: JSON.stringify({ project_id: currentProject.id, supposition })
            });
            setResult(resp);
            if (resp.impacts.length === 0) {
                addToast("success", "推演完成，该假设没有掀起蝴蝶效应。");
            } else {
                addToast("warning", `推演完成，发现 ${resp.impacts.length} 个受波及的节点！`);
            }
        } catch (e) {
            addToast("error", "骨牌推演失败，检查后台或大纲内容");
        } finally {
            setIsSimulating(false);
        }
    };

    const getSeverityColor = (sev: string) => {
        switch (sev) {
            case "high": return "#f44336"; // Red
            case "medium": return "#ff9800"; // Orange
            default: return "#4caf50"; // Green
        }
    };

    const getSeverityIcon = (sev: string) => {
        switch (sev) {
            case "high": return <AlertOctagon size={18} color="#f44336" />;
            case "medium": return <AlertTriangle size={18} color="#ff9800" />;
            default: return <AlertCircle size={18} color="#4caf50" />;
        }
    };

    const getSeverityLabel = (sev: string) => {
        switch (sev) {
            case "high": return "严重破坏 (需重写)";
            case "medium": return "中度冲突 (需打补丁)";
            default: return "轻微波及";
        }
    };

    if (!currentProject) {
        return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先建立或选择一个项目即可开启推演。</div>;
    }
    const butterflyModelInfo = models.butterfly_simulator;

    return (
        <div style={{ padding: 40, maxWidth: 900, margin: "0 auto", height: "100%", display: "flex", flexDirection: "column" }}>
            <header style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
                <GitMerge size={28} color="var(--accent-gold)" />
                <div>
                    <h1 style={{ margin: 0, fontSize: 24, color: "var(--text-primary)" }}>蝴蝶效应推演板</h1>
                    <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 13 }}>
                        当你想修改一个关键设定时，在这里输入你的假设。AI 会帮你沿时间轴推演哪些后续章节会因此崩坏。
                    </p>
                    <div
                        title={`蝴蝶推演模型来源：${butterflyModelInfo.source}`}
                        style={{
                            marginTop: 8,
                            display: "inline-flex",
                            alignItems: "center",
                            borderRadius: 999,
                            border: butterflyModelInfo.enabled ? "1px solid var(--accent-gold-dim)" : "1px solid rgba(233, 30, 99, 0.4)",
                            padding: "3px 10px",
                            fontSize: 11,
                            color: butterflyModelInfo.enabled ? "var(--accent-gold)" : "#e91e63",
                            background: butterflyModelInfo.enabled ? "rgba(255, 215, 0, 0.08)" : "rgba(233, 30, 99, 0.08)",
                            maxWidth: 320,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        }}
                    >
                        当前生效模型：{butterflyModelInfo.modelLabel}{!butterflyModelInfo.enabled ? "（已禁用）" : ""}
                    </div>
                </div>
            </header>

            {/* Input Area */}
            <div style={{ background: "var(--bg-card)", padding: 24, borderRadius: 12, border: "1px solid var(--bg-border)", marginBottom: 24 }}>
                <h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "var(--text-primary)" }}>你的“悔棋”脑洞假设：</h3>
                <textarea
                    value={supposition}
                    onChange={(e) => setSupposition(e.target.value)}
                    disabled={isSimulating}
                    placeholder="例如：假如第三章师傅没有死，而是被绑架了？"
                    style={{
                        width: "100%", background: "var(--bg-input)", border: "1px solid var(--bg-border)",
                        borderRadius: 8, padding: "12px 16px", color: "var(--text-primary)", fontSize: 14,
                        resize: "none", height: 80, fontFamily: "inherit", outline: "none", marginBottom: 16,
                        boxSizing: "border-box"
                    }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                        disabled={isSimulating || !supposition.trim()}
                        onClick={runSimulation}
                        style={{
                            padding: "10px 24px", borderRadius: 8, border: "none", cursor: isSimulating || !supposition.trim() ? "not-allowed" : "pointer",
                            background: isSimulating || !supposition.trim() ? "var(--bg-border)" : "var(--accent-gold)",
                            color: isSimulating || !supposition.trim() ? "var(--text-secondary)" : "#111",
                            display: "flex", alignItems: "center", gap: 8, fontWeight: 600, transition: "all 0.2s"
                        }}>
                        {isSimulating ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                        开始多米诺推演
                    </button>
                </div>
            </div>

            {/* Result Area */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>
                {isSimulating && (
                    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", opacity: 0.6, gap: 16 }}>
                        <GitMerge size={48} className="animate-pulse" />
                        <span>正在沿着时间走廊检查因果链崩塌进度...</span>
                    </div>
                )}

                {result && (
                    <>
                        {/* Summary Info Box */}
                        <div style={{
                            padding: "16px", borderRadius: 8,
                            background: result.impacts.length === 0 ? "rgba(76, 175, 80, 0.1)" : "rgba(244, 67, 54, 0.1)",
                            border: `1px solid ${result.impacts.length === 0 ? "rgba(76, 175, 80, 0.2)" : "rgba(244, 67, 54, 0.2)"}`,
                            color: "var(--text-primary)", fontSize: 14, lineHeight: 1.6,
                            display: "flex", gap: 12, alignItems: "flex-start"
                        }}>
                            {result.impacts.length === 0 ? <CheckCircle2 size={20} color="#4CAF50" style={{ marginTop: 2 }} /> : <AlertOctagon size={20} color="#f44336" style={{ marginTop: 2 }} />}
                            <div>
                                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                                    {result.impacts.length === 0 ? "安全边界！" : `警告：检测到 ${result.impacts.length} 处因果崩塌点`}
                                </div>
                                <div style={{ opacity: 0.9 }}>{result.summary}</div>
                            </div>
                        </div>

                        {/* Domino Effect Cards */}
                        {result.impacts.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                                <div style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 600 }}>受波及的节点列表：</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "relative" }}>
                                    {/* Connecting Line */}
                                    <div style={{ position: "absolute", left: 15, top: 20, bottom: 20, width: 2, background: "var(--bg-border)", zIndex: 0 }} />

                                    {result.impacts.map((imp, idx) => (
                                        <div key={idx} style={{ position: "relative", zIndex: 1, display: "flex", gap: 16 }}>

                                            {/* Timeline Node */}
                                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                                                <div style={{
                                                    width: 32, height: 32, borderRadius: "50%", background: "var(--bg-card)",
                                                    border: `2px solid ${getSeverityColor(imp.severity)}`,
                                                    display: "flex", alignItems: "center", justifyContent: "center"
                                                }}>
                                                    {getSeverityIcon(imp.severity)}
                                                </div>
                                            </div>

                                            {/* Card Content */}
                                            <div style={{
                                                flex: 1, background: "var(--bg-card)", border: `1px solid var(--bg-border)`,
                                                borderRadius: 8, padding: 16, borderLeft: `4px solid ${getSeverityColor(imp.severity)}`
                                            }}>
                                                {(() => {
                                                    const titleText = String(imp.chapter_title || "未命名").trim();
                                                    const chapterNum = Number(imp.chapter_num || 0);
                                                    const chapterLabel = chapterNum > 0 ? `第${chapterNum}章` : "";
                                                    const titleWithoutChapterPrefix = titleText
                                                        .replace(/^第\s*\d+\s*章(?:\s*[·・\-—:：]\s*)?/u, "")
                                                        .trim();
                                                    const displayTitle = chapterLabel
                                                        ? (titleWithoutChapterPrefix || titleText)
                                                        : titleText;
                                                    return (
                                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                                        {chapterLabel && (
                                                            <span
                                                                style={{
                                                                    flexShrink: 0,
                                                                    fontSize: 11,
                                                                    fontWeight: 700,
                                                                    color: "var(--accent-gold)",
                                                                    background: "rgba(255, 215, 0, 0.14)",
                                                                    border: "1px solid var(--accent-gold-dim)",
                                                                    borderRadius: 999,
                                                                    padding: "2px 8px",
                                                                }}
                                                            >
                                                                {chapterLabel}
                                                            </span>
                                                        )}
                                                        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text-primary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                            {displayTitle}
                                                        </div>
                                                    </div>
                                                    <div style={{ fontSize: 12, color: getSeverityColor(imp.severity), background: getSeverityColor(imp.severity) + "20", padding: "4px 8px", borderRadius: 4, fontWeight: 600 }}>
                                                        {getSeverityLabel(imp.severity)}
                                                    </div>
                                                </div>
                                                    );
                                                })()}

                                                <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 16, lineHeight: 1.5 }}>
                                                    <strong style={{ opacity: 0.6, fontSize: 12 }}>崩坏原因：</strong><br />
                                                    {imp.reason}
                                                </div>

                                                <div style={{ fontSize: 13, color: "var(--text-primary)", background: "rgba(76, 175, 80, 0.1)", border: "1px solid rgba(76, 175, 80, 0.2)", padding: 12, borderRadius: 6, lineHeight: 1.5 }}>
                                                    <strong style={{ color: "#4caf50", fontSize: 12, display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}><CheckCircle2 size={12} /> 补丁建议：</strong>
                                                    {imp.suggestion}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
