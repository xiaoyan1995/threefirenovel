import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { Loading, EmptyState, ErrorBanner, PageHeader, PrimaryButton } from "../components/ui";
import { Drawer } from "../components/ui/Drawer";
import { useToast } from "../components/ui/ToastProvider";

interface OutlinePhase {
  id: string; phase: string; title: string; content: string;
  word_range: string; phase_order: number; structure: string;
}

interface VolumePlan {
  volume_index: number;
  title: string;
  start_chapter: number;
  end_chapter: number;
  goal?: string;
  key_turning_point?: string;
  end_hook?: string;
}

interface VolumePlanCheck {
  ok: boolean;
  issues: string[];
  total_chapter_count: number;
}

const phaseColors: Record<string, string> = { "起": "#D4A574", "承": "#A78BFA", "转": "#4ADE80", "合": "#60A5FA" };

const resolveOutlinePhaseLabels = (structure?: string, customStructure?: string): string[] => {
  if (structure === "三幕式") return ["第一幕", "第二幕", "第三幕"];
  if (structure === "英雄之旅") {
    return ["平凡世界", "冒险召唤", "跨越门槛", "试炼与盟友", "重大考验", "获得奖励", "归途", "重生"];
  }
  if (structure === "自定义") {
    const tokens = String(customStructure || "")
      .split(/[,，；;\n|/→\-]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length > 0) return tokens.slice(0, 12);
  }
  return ["起", "承", "转", "合"];
};

export default function Outline() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const [phases, setPhases] = useState<OutlinePhase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGeneratingFromChapters, setAiGeneratingFromChapters] = useState(false);
  const [forceRewriteOutline, setForceRewriteOutline] = useState(false);
  const [viewMode, setViewMode] = useState<"outline" | "volume">("outline");
  const [volumePlans, setVolumePlans] = useState<VolumePlan[]>([]);
  const [volumeCheck, setVolumeCheck] = useState<VolumePlanCheck | null>(null);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [volumeError, setVolumeError] = useState("");
  const [isVolumeGenerating, setIsVolumeGenerating] = useState(false);
  const [targetVolumeCount, setTargetVolumeCount] = useState("8");
  const pid = currentProject?.id;
  const outlineReqId = useRef(0);
  const volumeReqId = useRef(0);

  // Edit drawer state
  const [editingPhase, setEditingPhase] = useState<OutlinePhase | null>(null);
  const [editForm, setEditForm] = useState<Partial<OutlinePhase>>({});
  const [isSaving, setIsSaving] = useState(false);
  const currentStructure = String(currentProject?.structure || "起承转合");
  const currentCustomStructure = String(currentProject?.custom_structure || "");
  const phaseLabels = resolveOutlinePhaseLabels(currentStructure, currentCustomStructure);
  const structureDisplay = currentStructure === "自定义" && currentCustomStructure
    ? `${currentStructure}（${currentCustomStructure}）`
    : currentStructure;

  useEffect(() => {
    setPhases([]);
    setError("");
    setLoading(true);
    setVolumePlans([]);
    setVolumeCheck(null);
    setVolumeError("");
  }, [pid]);

  const load = useCallback(() => {
    if (!pid) { setLoading(false); return; }
    const id = ++outlineReqId.current;
    setLoading(true); setError("");
    api<OutlinePhase[]>(`/api/content/outlines?project_id=${pid}`)
      .then((d) => { if (outlineReqId.current === id) setPhases(d); })
      .catch((e: Error) => { if (outlineReqId.current === id) setError(e.message); })
      .finally(() => { if (outlineReqId.current === id) setLoading(false); });
  }, [pid, api]);

  useEffect(load, [load]);

  const loadVolumePlans = useCallback(async () => {
    if (!pid) return;
    const id = ++volumeReqId.current;
    setVolumeLoading(true);
    setVolumeError("");
    try {
      const [plans, check] = await Promise.all([
        api<VolumePlan[]>(`/api/pipeline/volume-plans?project_id=${pid}`),
        api<VolumePlanCheck>(`/api/pipeline/volume-plans/check?project_id=${pid}`).catch(() => null),
      ]);
      if (volumeReqId.current !== id) return;
      setVolumePlans(Array.isArray(plans) ? plans : []);
      setVolumeCheck(check || null);
    } catch (e: unknown) {
      if (volumeReqId.current !== id) return;
      setVolumeError(e instanceof Error ? e.message : "卷计划加载失败");
    } finally {
      if (volumeReqId.current === id) setVolumeLoading(false);
    }
  }, [pid, api]);

  useEffect(() => {
    if (viewMode === "volume") {
      void loadVolumePlans();
    }
  }, [viewMode, loadVolumePlans]);

  const generateOutlineByAi = async () => {
    if (!pid || aiGenerating) return;
    setAiGenerating(true);
    try {
      const res = await api<{ inserted: { outline: number }; skipped: { outline: number }; message: string }>("/api/pipeline/bootstrap", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, scope: "outline", force: forceRewriteOutline }),
      });
      await load();
      addToast("success", res.message || "AI 大纲生成完成");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "AI 大纲生成失败";
      setError(msg);
      addToast("error", "AI 生成大纲失败，请检查模型配置");
    } finally {
      setAiGenerating(false);
    }
  };

  const parseApiError = (err: unknown, fallback: string) => {
    const raw = err instanceof Error ? err.message : String(err || "");
    const payload = raw.replace(/^API\s+\d+\s*:\s*/i, "").trim();
    if (!payload) return fallback;
    try {
      const parsed = JSON.parse(payload) as { detail?: unknown; message?: unknown };
      if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // ignore parse failure
    }
    return payload;
  };

  const generateOutlineFromChapters = async () => {
    if (!pid || aiGeneratingFromChapters) return;
    setAiGeneratingFromChapters(true);
    try {
      const res = await api<{ message: string; errors?: string[] }>(`/api/projects/${pid}/generate-from-chapters`, {
        method: "POST",
        body: JSON.stringify({ scope: "outline", force: forceRewriteOutline }),
      });
      await load();
      addToast("success", res.message || "章节派生大纲生成完成");
      if (Array.isArray(res.errors) && res.errors.length > 0) {
        addToast("warning", `章节派生有告警：${res.errors.length} 条`);
      }
    } catch (e: unknown) {
      const msg = parseApiError(e, "按章节生成大纲失败，请检查模型配置");
      setError(msg);
      addToast("error", msg);
    } finally {
      setAiGeneratingFromChapters(false);
    }
  };

  const generateVolumePlansByAi = async () => {
    if (!pid || isVolumeGenerating) return;
    const parsedCount = Number(targetVolumeCount);
    if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 36) {
      addToast("warning", "目标卷数请输入 1-36");
      return;
    }
    if (volumePlans.length > 0) {
      const ok = window.confirm("将覆盖已有卷计划，是否继续？");
      if (!ok) return;
    }
    setIsVolumeGenerating(true);
    try {
      let chapterCountHint = Number(volumeCheck?.total_chapter_count || 0);
      if (!Number.isFinite(chapterCountHint) || chapterCountHint <= 0) {
        try {
          const check = await api<VolumePlanCheck>(`/api/pipeline/volume-plans/check?project_id=${pid}`);
          chapterCountHint = Number(check?.total_chapter_count || 0);
        } catch {
          chapterCountHint = 0;
        }
      }
      const res = await api<{ items: VolumePlan[]; message: string }>("/api/pipeline/volume-plans/generate", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          target_volume_count: Math.floor(parsedCount),
          target_word_count: currentProject?.word_target,
          chapter_count: chapterCountHint > 0 ? Math.floor(chapterCountHint) : undefined,
          force: true,
        }),
      });
      setVolumePlans(Array.isArray(res.items) ? res.items : []);
      await loadVolumePlans();
      addToast("success", res.message || "卷计划生成完成");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "AI 卷计划生成失败";
      setVolumeError(msg);
      addToast("error", msg);
    } finally {
      setIsVolumeGenerating(false);
    }
  };

  const addPhase = async () => {
    if (!pid) return;
    try {
      const order = phases.length;
      const newPhaseName = phaseLabels[order % Math.max(1, phaseLabels.length)] || `阶段${order + 1}`;
      const p = await api<OutlinePhase>("/api/content/outlines", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid, structure: currentStructure,
          phase: newPhaseName, phase_order: order,
          title: "新阶段", content: "", word_range: "",
        }),
      });
      setPhases((prev) => [...prev, p]);
      openEdit(p);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const openEdit = (p: OutlinePhase) => {
    setEditingPhase(p);
    setEditForm({ ...p });
  };

  const handleSave = async () => {
    if (!editingPhase || !pid) return;
    setIsSaving(true);
    try {
      const updated = await api<OutlinePhase>(`/api/content/outlines/${editingPhase.id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      setPhases((prev) => prev.map((p) => p.id === updated.id ? updated : p));
      setEditingPhase(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingPhase || !pid) return;
    try {
      await api(`/api/content/outlines/${editingPhase.id}`, { method: "DELETE" });
      setPhases((prev) => prev.filter((p) => p.id !== editingPhase.id));
      setEditingPhase(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  if (!pid) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon="📖" title="请先选择一个项目" description="在项目列表中选择或创建一个项目后，即可管理故事大纲" />
      </div>
    );
  }

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <PageHeader
        title="故事大纲"
        subtitle={viewMode === "outline"
          ? `叙事结构: ${structureDisplay} · 共${phases.length}个阶段`
          : `卷级规划 · 共${volumePlans.length}卷${volumeCheck?.total_chapter_count ? ` · 目标${volumeCheck.total_chapter_count}章` : ""}`}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--bg-border)", borderRadius: 8, overflow: "hidden" }}>
              <button
                onClick={() => setViewMode("outline")}
                style={{
                  height: 34,
                  padding: "0 12px",
                  border: "none",
                  borderRight: "1px solid var(--bg-border)",
                  background: viewMode === "outline" ? "var(--accent-gold-dim)" : "transparent",
                  color: viewMode === "outline" ? "var(--accent-gold)" : "var(--text-secondary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                骨架视图
              </button>
              <button
                onClick={() => setViewMode("volume")}
                style={{
                  height: 34,
                  padding: "0 12px",
                  border: "none",
                  background: viewMode === "volume" ? "var(--accent-gold-dim)" : "transparent",
                  color: viewMode === "volume" ? "var(--accent-gold)" : "var(--text-secondary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                卷级视图
              </button>
            </div>
            {viewMode === "outline" ? (
              <>
                <PrimaryButton onClick={generateOutlineByAi} disabled={aiGenerating}>
                  {aiGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {aiGenerating ? "生成中..." : "AI 生成大纲"}
                </PrimaryButton>
                <PrimaryButton onClick={generateOutlineFromChapters} disabled={aiGeneratingFromChapters || aiGenerating}>
                  {aiGeneratingFromChapters ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {aiGeneratingFromChapters ? "生成中..." : "按章节生成大纲"}
                </PrimaryButton>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    userSelect: "none",
                  }}
                  title="开启后会覆盖已有大纲内容"
                >
                  <input
                    type="checkbox"
                    checked={forceRewriteOutline}
                    onChange={(e) => setForceRewriteOutline(e.currentTarget.checked)}
                    disabled={aiGenerating || aiGeneratingFromChapters}
                    style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                  />
                  覆盖重生成
                </label>
                <button onClick={addPhase} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer", transition: "border-color 0.15s" }}>
                  <Plus size={14} />添加阶段
                </button>
              </>
            ) : (
              <>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", border: "1px solid var(--bg-border)", borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>目标卷数</span>
                  <input
                    type="number"
                    min={1}
                    max={36}
                    value={targetVolumeCount}
                    onChange={(e) => setTargetVolumeCount(e.target.value)}
                    disabled={isVolumeGenerating}
                    style={{
                      width: 56,
                      height: 26,
                      borderRadius: 6,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-input)",
                      color: "var(--text)",
                      padding: "0 8px",
                      fontSize: 12,
                      outline: "none",
                    }}
                  />
                </div>
                <PrimaryButton onClick={generateVolumePlansByAi} disabled={isVolumeGenerating}>
                  {isVolumeGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {isVolumeGenerating ? "生成中..." : "AI 生成卷计划"}
                </PrimaryButton>
              </>
            )}
          </div>
        }
      />

      {viewMode === "outline" ? (
        <>
          {error && <ErrorBanner message={error} onRetry={load} />}
          {loading ? (
            <Loading />
          ) : phases.length === 0 ? (
            <EmptyState
              icon="📖"
              title="暂无大纲"
              description="点击「AI 生成大纲」或「添加阶段」开始"
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {phases.map((p) => {
                const color = phaseColors[p.phase] || "#9CA3AF";
                return (
                  <div key={p.id} onClick={() => openEdit(p)} style={{
                    padding: 24, borderRadius: 12, border: "1px solid var(--bg-border)",
                    display: "flex", gap: 20, cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = color; e.currentTarget.style.background = color + "08"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--bg-border)"; e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ width: 48, height: 48, borderRadius: "50%", background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", color, fontSize: 20, fontWeight: 700, flexShrink: 0 }}>
                      {p.phase}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</span>
                      </div>
                      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: 8 }}>{p.content || "暂无内容"}</p>
                      {p.word_range && <span style={{ fontSize: 11, color: "var(--text-secondary)", opacity: 0.7 }}>字数范围: {p.word_range}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {volumeError && <ErrorBanner message={volumeError} onRetry={loadVolumePlans} />}
          {volumeCheck && !volumeCheck.ok && volumeCheck.issues.length > 0 && (
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--status-warning)", color: "var(--status-warning)", fontSize: 12 }}>
              卷计划一致性提示：{volumeCheck.issues.join("；")}
            </div>
          )}
          {volumeLoading ? (
            <Loading />
          ) : volumePlans.length === 0 ? (
            <EmptyState
              icon="📚"
              title="暂无卷计划"
              description="点击「AI 生成卷计划」自动创建按卷范围规划"
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {volumePlans.map((v) => (
                <div
                  key={v.volume_index}
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-card)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{v.title || `第${v.volume_index}卷`}</div>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>第{v.start_chapter}-{v.end_chapter}章</span>
                  </div>
                  {v.goal && <div style={{ fontSize: 13, color: "var(--text-secondary)" }}><strong style={{ color: "var(--text)" }}>目标：</strong>{v.goal}</div>}
                  {v.key_turning_point && <div style={{ fontSize: 13, color: "var(--text-secondary)" }}><strong style={{ color: "var(--text)" }}>转折：</strong>{v.key_turning_point}</div>}
                  {v.end_hook && <div style={{ fontSize: 13, color: "var(--text-secondary)" }}><strong style={{ color: "var(--text)" }}>卷尾钩子：</strong>{v.end_hook}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 侧边编辑抽屉 */}
      <Drawer
        isOpen={!!editingPhase}
        title="编辑大纲阶段"
        onClose={() => setEditingPhase(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        isSaving={isSaving}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>阶段</label>
            <select
              value={editForm.phase || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, phase: e.target.value }))}
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            >
              {phaseLabels.map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
              {editForm.phase && !phaseLabels.includes(String(editForm.phase)) ? (
                <option value={String(editForm.phase)}>{String(editForm.phase)}</option>
              ) : null}
              <option value="新">新阶段 (自定义)</option>
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>标题</label>
            <input
              value={editForm.title || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, title: e.target.value }))}
              placeholder="例如：初入江湖"
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>内容描述</label>
            <textarea
              value={editForm.content || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, content: e.target.value }))}
              placeholder="描述这个阶段发生的主要剧情片段..."
              rows={8}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>字数范围</label>
            <input
              value={editForm.word_range || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, word_range: e.target.value }))}
              placeholder="例如：1-10章"
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
        </div>
      </Drawer>
    </div>
  );
}
