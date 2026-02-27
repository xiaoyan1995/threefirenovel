import { useState } from "react";
import { AlertTriangle, Lightbulb, Users, Globe, Clock, ShieldX, CheckCircle2, Wand2, Loader2 } from "lucide-react";
import type { ConflictItem } from "../../types";

export function ConflictPanel({
    conflicts,
    summary,
    loading,
    onGenerateRewriteSuggestion,
    generatingRewriteIndex,
    onGenerateChapterRewriteSuggestion,
    generatingChapterRewrite,
    onApplyAllRewriteSuggestions,
    applyingAllRewrite
}: {
    conflicts: ConflictItem[],
    summary: string,
    loading: boolean,
    onGenerateRewriteSuggestion?: (conflict: ConflictItem, index: number) => void,
    generatingRewriteIndex?: number | null,
    onGenerateChapterRewriteSuggestion?: () => void,
    generatingChapterRewrite?: boolean,
    onApplyAllRewriteSuggestions?: () => void,
    applyingAllRewrite?: boolean,
}) {
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

    if (loading) {
        return (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 13, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", justifyContent: "center", height: 200 }}>
                <div className="animate-pulse" style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--bg-input)" }} />
                系统正在检索全库设定和历史段落...<br />
                <span style={{ fontSize: 11, opacity: 0.6 }}>AI Reviewer 正在进行交叉比对</span>
            </div>
        );
    }

    if (!summary && conflicts.length === 0) {
        return (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 12, opacity: 0.6 }}>
                暂未扫描。点击顶部的【逻辑扫描】按钮检查当前章节。
            </div>
        );
    }

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'character': return <Users size={14} color="#f44336" />;
            case 'worldbuilding': return <Globe size={14} color="#ff9800" />;
            case 'chronology': return <Clock size={14} color="#9c27b0" />;
            default: return <ShieldX size={14} color="#e91e63" />;
        }
    };

    const getTypeLabel = (type: string) => {
        switch (type) {
            case 'character': return '人设/能力冲突';
            case 'worldbuilding': return '世界观违背';
            case 'chronology': return '时空连贯性异常';
            default: return '通用事件逻辑漏洞';
        }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* 总结卡片 */}
            <div style={{
                padding: "12px 16px",
                borderRadius: 8,
                background: conflicts.length === 0 ? "rgba(76, 175, 80, 0.1)" : "rgba(244, 67, 54, 0.1)",
                border: `1px solid ${conflicts.length === 0 ? "rgba(76, 175, 80, 0.2)" : "rgba(244, 67, 54, 0.2)"}`,
                color: "var(--text-primary)",
                fontSize: 13,
                lineHeight: 1.5,
                display: "flex", gap: 10, alignItems: "flex-start"
            }}>
                {conflicts.length === 0 ? <CheckCircle2 size={16} color="#4CAF50" style={{ marginTop: 2 }} /> : <AlertTriangle size={16} color="#f44336" style={{ marginTop: 2 }} />}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>{summary}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {onApplyAllRewriteSuggestions && conflicts.length > 0 && (
                            <button
                                onClick={onApplyAllRewriteSuggestions}
                                disabled={!!applyingAllRewrite || !!generatingChapterRewrite}
                                style={{
                                    alignSelf: "flex-start",
                                    borderRadius: 8,
                                    border: "1px solid rgba(33, 150, 243, 0.35)",
                                    background: (applyingAllRewrite || generatingChapterRewrite) ? "rgba(33, 150, 243, 0.12)" : "rgba(33, 150, 243, 0.18)",
                                    color: "#1565c0",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    padding: "4px 9px",
                                    cursor: (applyingAllRewrite || generatingChapterRewrite) ? "not-allowed" : "pointer",
                                }}
                                title="逐条生成并直接替换所有可定位冲突片段"
                            >
                                {(applyingAllRewrite || generatingChapterRewrite) ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                {applyingAllRewrite ? "一键修复中..." : "一键修复可定位片段"}
                            </button>
                        )}
                        {conflicts.length >= 4 && onGenerateChapterRewriteSuggestion && (
                            <button
                                onClick={onGenerateChapterRewriteSuggestion}
                                disabled={!!generatingChapterRewrite || !!applyingAllRewrite}
                                style={{
                                    alignSelf: "flex-start",
                                    borderRadius: 8,
                                    border: "1px solid rgba(255, 152, 0, 0.35)",
                                    background: (generatingChapterRewrite || applyingAllRewrite) ? "rgba(255, 152, 0, 0.12)" : "rgba(255, 152, 0, 0.18)",
                                    color: "#ef6c00",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    padding: "4px 9px",
                                    cursor: (generatingChapterRewrite || applyingAllRewrite) ? "not-allowed" : "pointer",
                                }}
                                title="问题较多时，先给整章建议正文再决定是否替换"
                            >
                                {(generatingChapterRewrite || applyingAllRewrite) ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                {generatingChapterRewrite ? "生成中..." : "生成全章重写建议"}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* 冲突项列表 */}
            {conflicts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>发现 {conflicts.length} 处疑似错误：</div>

                    {conflicts.map((c, i) => {
                        const isExpanded = expandedIndex === i;
                        return (
                            <div key={i} style={{
                                background: "var(--bg-card)",
                                borderRadius: 8,
                                border: "1px solid var(--bg-border)",
                                overflow: "hidden"
                            }}>
                                <button
                                    onClick={() => setExpandedIndex(isExpanded ? null : i)}
                                    style={{
                                        width: "100%", padding: "10px 12px", border: "none", background: "transparent",
                                        display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left",
                                        borderBottom: isExpanded ? "1px solid var(--bg-border)" : "none"
                                    }}
                                >
                                    {getTypeIcon(c.type)}
                                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", flex: 1 }}>{getTypeLabel(c.type)}</span>
                                    <span style={{ fontSize: 18, color: "var(--text-secondary)", transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
                                </button>

                                {isExpanded && (
                                    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 10, fontSize: 12, lineHeight: 1.5 }}>
                                        <div style={{ background: "var(--bg-input)", padding: 8, borderRadius: 6, color: "var(--text-secondary)", fontStyle: "italic", borderLeft: "2px solid #666" }}>
                                            "{c.quote}"
                                        </div>
                                        <div style={{ color: "var(--text-primary)" }}>
                                            <strong style={{ color: "#f44336" }}>错误说明：</strong><br />
                                            {c.description}
                                        </div>
                                        <div style={{ color: "var(--text-primary)", background: "rgba(255,152,0,0.1)", padding: 8, borderRadius: 6, border: "1px solid rgba(255,152,0,0.2)" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#ff9800", fontWeight: 600, marginBottom: 4 }}>
                                                <Lightbulb size={12} /> 修改建议
                                            </div>
                                            {c.suggestion}
                                        </div>
                                        {onGenerateRewriteSuggestion && (
                                            <button
                                                onClick={() => onGenerateRewriteSuggestion(c, i)}
                                                disabled={generatingRewriteIndex === i || !!generatingChapterRewrite || !!applyingAllRewrite}
                                                style={{
                                                    alignSelf: "flex-start",
                                                    borderRadius: 8,
                                                    border: "1px solid rgba(33, 150, 243, 0.35)",
                                                    background: (generatingRewriteIndex === i || generatingChapterRewrite || applyingAllRewrite) ? "rgba(33, 150, 243, 0.12)" : "rgba(33, 150, 243, 0.18)",
                                                    color: (generatingRewriteIndex === i || generatingChapterRewrite || applyingAllRewrite) ? "rgba(21, 101, 192, 0.82)" : "#1565c0",
                                                    fontSize: 11,
                                                    fontWeight: 600,
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: 4,
                                                    padding: "4px 9px",
                                                    cursor: (generatingRewriteIndex === i || generatingChapterRewrite || applyingAllRewrite) ? "not-allowed" : "pointer",
                                                }}
                                                title="按此条冲突自动生成建议正文（需确认后才替换）"
                                            >
                                                {generatingRewriteIndex === i ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                                {generatingRewriteIndex === i ? "生成中..." : "生成建议正文"}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
