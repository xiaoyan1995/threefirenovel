import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Plus, Sparkles, CheckCircle2, ArchiveX, GitMerge, RefreshCw } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { Loading, EmptyState, ErrorBanner, PageHeader, PrimaryButton } from "../components/ui";
import { Drawer } from "../components/ui/Drawer";
import type { WorldItem, EntityCandidate } from "../types";
import { useToast } from "../components/ui/ToastProvider";

export default function Worldbuilding() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const [items, setItems] = useState<WorldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pid = currentProject?.id;
  const reqId = useRef(0);

  // Edit drawer state
  const [editingItem, setEditingItem] = useState<WorldItem | null>(null);
  const [editForm, setEditForm] = useState<Partial<WorldItem>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isAiGeneratingFromChapters, setIsAiGeneratingFromChapters] = useState(false);
  const [forceRewriteWorldbuilding, setForceRewriteWorldbuilding] = useState(false);
  const [pendingCandidates, setPendingCandidates] = useState<EntityCandidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateBusyId, setCandidateBusyId] = useState("");
  const [mergeTargetByCandidate, setMergeTargetByCandidate] = useState<Record<string, string>>({});
  const [activeCategory, setActiveCategory] = useState("全部");

  const normalizeCategory = (value: unknown) => {
    const text = String(value || "").trim();
    return text || "其他";
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
      // ignore json parse failure
    }
    return payload;
  };

  useEffect(() => { setItems([]); setError(""); setLoading(true); }, [pid]);

  const load = useCallback(() => {
    if (!pid) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true); setError("");
    api<WorldItem[]>(`/api/content/worldbuilding?project_id=${pid}`)
      .then((d) => { if (reqId.current === id) setItems(d); })
      .catch((e: Error) => { if (reqId.current === id) setError(e.message); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [pid, api]);

  useEffect(load, [load]);

  useEffect(() => {
    if (activeCategory === "全部") return;
    const available = new Set(items.map((item) => normalizeCategory(item.category)));
    if (!available.has(activeCategory)) {
      setActiveCategory("全部");
    }
  }, [items, activeCategory]);

  const loadPendingCandidates = useCallback(() => {
    if (!pid) {
      setPendingCandidates([]);
      return;
    }
    setCandidateLoading(true);
    api<EntityCandidate[]>(`/api/content/entity-candidates?project_id=${pid}&entity_type=worldbuilding&status=pending&limit=120`)
      .then((rows) => {
        setPendingCandidates(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        setPendingCandidates([]);
      })
      .finally(() => setCandidateLoading(false));
  }, [pid, api]);

  useEffect(() => {
    loadPendingCandidates();
  }, [loadPendingCandidates]);

  const generateWorldByAi = async () => {
    if (!pid || isAiGenerating) return;
    setIsAiGenerating(true);
    try {
      const res = await api<{ message: string }>("/api/pipeline/bootstrap", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, scope: "worldbuilding", force: forceRewriteWorldbuilding }),
      });
      await load();
      addToast("success", res.message || "AI 世界观生成完成");
    } catch (e: unknown) {
      const detail = parseApiError(e, "AI 世界观生成失败，请检查模型配置");
      addToast("error", detail);
      setError(detail);
    } finally {
      setIsAiGenerating(false);
    }
  };

  const generateWorldFromChapters = async () => {
    if (!pid || isAiGeneratingFromChapters) return;
    setIsAiGeneratingFromChapters(true);
    try {
      const res = await api<{ message: string; errors?: string[] }>(`/api/projects/${pid}/generate-from-chapters`, {
        method: "POST",
        body: JSON.stringify({ scope: "worldbuilding", force: forceRewriteWorldbuilding }),
      });
      await Promise.all([load(), loadPendingCandidates()]);
      addToast("success", res.message || "章节派生世界观生成完成");
      if (Array.isArray(res.errors) && res.errors.length > 0) {
        addToast("warning", `章节派生有告警：${res.errors.length} 条`);
      }
    } catch (e: unknown) {
      const detail = parseApiError(e, "按章节生成世界观失败，请检查模型配置");
      addToast("error", detail);
      setError(detail);
    } finally {
      setIsAiGeneratingFromChapters(false);
    }
  };

  const addItem = async () => {
    if (!pid) return;
    try {
      const w = await api<WorldItem>("/api/content/worldbuilding", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, category: "其他", title: "新设定", content: "" }),
      });
      setItems((prev) => [...prev, w]);
      openEdit(w);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const openEdit = (item: WorldItem) => {
    setEditingItem(item);
    setEditForm({ ...item });
  };

  const handleSave = async () => {
    if (!editingItem || !pid) return;
    setIsSaving(true);
    try {
      const updated = await api<WorldItem>(`/api/content/worldbuilding/${editingItem.id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      setItems((prev) => prev.map((i) => i.id === updated.id ? updated : i));
      setEditingItem(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingItem || !pid) return;
    try {
      await api(`/api/content/worldbuilding/${editingItem.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== editingItem.id));
      setEditingItem(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const handleCandidateCommit = async (
    candidate: EntityCandidate,
    action: "create" | "merge" | "ignore",
  ) => {
    if (!pid || candidateBusyId) return;
    const targetId = mergeTargetByCandidate[candidate.id] || "";
    if (action === "merge" && !targetId) {
      addToast("warning", "请先选择要合并到的世界观条目");
      return;
    }
    setCandidateBusyId(candidate.id);
    try {
      await api<{ created: number; merged: number; ignored: number; skipped: number }>(
        "/api/content/entity-candidates/commit",
        {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            operations: [
              {
                candidate_id: candidate.id,
                action,
                target_id: action === "merge" ? targetId : undefined,
              },
            ],
          }),
        },
      );
      await Promise.all([load(), loadPendingCandidates()]);
      if (action === "ignore") {
        addToast("success", "已忽略该候选");
      } else if (action === "merge") {
        addToast("success", "已合并到已有世界观");
      } else {
        addToast("success", "已入库为世界观");
      }
    } catch (e: unknown) {
      const detail = parseApiError(e, "候选处理失败");
      addToast("error", detail);
    } finally {
      setCandidateBusyId("");
    }
  };

  if (!pid) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon="🌍" title="请先选择一个项目" description="在项目列表中选择或创建一个项目后，即可管理世界观设定" />
      </div>
    );
  }

  const categoryList = Array.from(
    new Set(items.map((item) => normalizeCategory(item.category))),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const categoryButtons = ["全部", ...categoryList];
  const filteredItems = activeCategory === "全部"
    ? items
    : items.filter((item) => normalizeCategory(item.category) === activeCategory);

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <PageHeader
        title="世界观设定"
        subtitle={items.length > 0 ? `共 ${items.length} 条设定` : undefined}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryButton onClick={generateWorldByAi} disabled={isAiGenerating}>
              {isAiGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {isAiGenerating ? "生成中..." : "AI 生成设定"}
            </PrimaryButton>
            <PrimaryButton onClick={generateWorldFromChapters} disabled={isAiGeneratingFromChapters || isAiGenerating}>
              {isAiGeneratingFromChapters ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {isAiGeneratingFromChapters ? "生成中..." : "按章节生成设定"}
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
              title="开启后会覆盖已有世界观内容"
            >
                <input
                  type="checkbox"
                  checked={forceRewriteWorldbuilding}
                  onChange={(e) => setForceRewriteWorldbuilding(e.currentTarget.checked)}
                  disabled={isAiGenerating || isAiGeneratingFromChapters}
                  style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                />
              覆盖重生成
            </label>
            <PrimaryButton onClick={addItem}><Plus size={14} />添加设定</PrimaryButton>
          </div>
        }
      />

      <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, background: "var(--bg-card)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            自动提取候选（世界观）{pendingCandidates.length > 0 ? `· ${pendingCandidates.length}` : ""}
          </div>
          <button
            onClick={loadPendingCandidates}
            disabled={candidateLoading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid var(--bg-border)",
              background: "var(--bg)",
              color: "var(--text-secondary)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
              cursor: candidateLoading ? "not-allowed" : "pointer",
              opacity: candidateLoading ? 0.7 : 1,
            }}
          >
            {candidateLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            刷新
          </button>
        </div>
        {candidateLoading ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>候选加载中...</div>
        ) : pendingCandidates.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            暂无待确认候选。章节保存后会自动提取，再来这里确认入库。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" }}>
            {pendingCandidates.map((c) => {
              const busy = candidateBusyId === c.id;
              return (
                <div key={c.id} style={{ border: "1px solid var(--bg-border)", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      {c.name}
                      <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8 }}>
                        {c.category || "其他"}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      {c.chapter_num ? `第${c.chapter_num}章` : "章节未知"}
                      {typeof c.confidence === "number" ? ` · ${Math.round((c.confidence || 0) * 100)}%` : ""}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6, lineHeight: 1.6 }}>
                    {c.description || "（无描述）"}
                  </div>
                  {c.source_excerpt ? (
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6, opacity: 0.8 }}>
                      证据：{c.source_excerpt}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => handleCandidateCommit(c, "create")}
                      disabled={busy}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 12,
                        cursor: busy ? "not-allowed" : "pointer",
                        background: "rgba(34,197,94,0.18)",
                        color: "#16a34a",
                        opacity: busy ? 0.7 : 1,
                      }}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                      入库
                    </button>
                    <select
                      value={mergeTargetByCandidate[c.id] || ""}
                      onChange={(e) =>
                        setMergeTargetByCandidate((prev) => ({ ...prev, [c.id]: e.target.value }))
                      }
                      style={{
                        minWidth: 160,
                        borderRadius: 6,
                        border: "1px solid var(--bg-border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 12,
                        padding: "5px 8px",
                      }}
                    >
                      <option value="">选择合并对象</option>
                      {items.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.title}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleCandidateCommit(c, "merge")}
                      disabled={busy}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 12,
                        cursor: busy ? "not-allowed" : "pointer",
                        background: "rgba(59,130,246,0.16)",
                        color: "#2563eb",
                        opacity: busy ? 0.7 : 1,
                      }}
                    >
                      <GitMerge size={12} />
                      合并
                    </button>
                    <button
                      onClick={() => handleCandidateCommit(c, "ignore")}
                      disabled={busy}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        border: "none",
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 12,
                        cursor: busy ? "not-allowed" : "pointer",
                        background: "rgba(239,68,68,0.14)",
                        color: "#dc2626",
                        opacity: busy ? 0.7 : 1,
                      }}
                    >
                      <ArchiveX size={12} />
                      忽略
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon="🌍"
          title="还没有世界观设定"
          description="点击右上角「添加设定」开始构建你的世界"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {categoryButtons.map((category) => {
              const selected = activeCategory === category;
              const count = category === "全部"
                ? items.length
                : items.filter((item) => normalizeCategory(item.category) === category).length;
              return (
                <button
                  key={category}
                  onClick={() => setActiveCategory(category)}
                  style={{
                    borderRadius: 999,
                    border: selected ? "1px solid var(--accent-gold)" : "1px solid var(--bg-border)",
                    background: selected ? "rgba(212,165,116,0.16)" : "var(--bg-card)",
                    color: selected ? "var(--text)" : "var(--text-secondary)",
                    fontSize: 12,
                    fontWeight: selected ? 700 : 500,
                    padding: "5px 10px",
                    cursor: "pointer",
                  }}
                >
                  {category} · {count}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {filteredItems.map((item) => (
              <div key={item.id} onClick={() => openEdit(item)} style={{
                padding: 20, borderRadius: 12, border: "1px solid var(--bg-border)",
                cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
              }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent-gold)"; e.currentTarget.style.background = "rgba(212,165,116,0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--bg-border)"; e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</div>
                  <span style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-active)", borderRadius: 4, color: "var(--text-secondary)" }}>{normalizeCategory(item.category)}</span>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, margin: 0, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>{item.content || "暂无内容"}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 侧边编辑抽屉 */}
      <Drawer
        isOpen={!!editingItem}
        title="编辑设定"
        onClose={() => setEditingItem(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        isSaving={isSaving}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>设定名称</label>
            <input
              value={editForm.title || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, title: e.target.value }))}
              placeholder="例如：修仙境界、魔法体系..."
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>分类</label>
            <input
              value={editForm.category || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, category: e.target.value }))}
              placeholder="例如：地理、门派、力量体系..."
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>具体内容</label>
            <textarea
              value={editForm.content || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, content: e.target.value }))}
              placeholder="详细描述这项世界观设定..."
              rows={15}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
        </div>
      </Drawer>
    </div>
  );
}
