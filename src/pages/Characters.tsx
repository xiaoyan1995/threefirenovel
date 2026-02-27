import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Plus, Search, Sparkles, CheckCircle2, ArchiveX, GitMerge, RefreshCw } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { Loading, EmptyState, ErrorBanner, PageHeader, PrimaryButton } from "../components/ui";
import { Drawer } from "../components/ui/Drawer";
import type { Character, CharacterRelation, EntityCandidate } from "../types";
import { useToast } from "../components/ui/ToastProvider";

const categories = ["全部", "主角", "反派", "配角", "其他"] as const;
const genders = ["", "男", "女", "非二元"] as const;
const categoryColors: Record<string, string> = { 主角: "#4ADE80", 反派: "#F87171", 配角: "#60A5FA", 其他: "#9CA3AF" };
type EditableRelation = { id?: string; target_id: string; relation_type: string; description: string };

export default function Characters() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const [chars, setChars] = useState<Character[]>([]);
  const [filter, setFilter] = useState("全部");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pid = currentProject?.id;
  const reqId = useRef(0);
  const detailReqId = useRef(0);

  // Edit drawer state
  const [editingChar, setEditingChar] = useState<Character | null>(null);
  const [editForm, setEditForm] = useState<Partial<Character>>({});
  const [editRelations, setEditRelations] = useState<EditableRelation[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isAiGeneratingFromChapters, setIsAiGeneratingFromChapters] = useState(false);
  const [isAiCreatingSingle, setIsAiCreatingSingle] = useState(false);
  const [forceRewriteCharacters, setForceRewriteCharacters] = useState(false);
  const [pendingCandidates, setPendingCandidates] = useState<EntityCandidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateBusyId, setCandidateBusyId] = useState("");
  const [mergeTargetByCandidate, setMergeTargetByCandidate] = useState<Record<string, string>>({});

  useEffect(() => { setChars([]); setError(""); setLoading(true); }, [pid]);

  const load = useCallback(() => {
    if (!pid) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true); setError("");
    api<Character[]>(`/api/characters/?project_id=${pid}`)
      .then((d) => { if (reqId.current === id) setChars(d); })
      .catch((e: Error) => { if (reqId.current === id) setError(e.message); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [pid, api]);

  useEffect(load, [load]);

  const loadPendingCandidates = useCallback(() => {
    if (!pid) {
      setPendingCandidates([]);
      return;
    }
    setCandidateLoading(true);
    api<EntityCandidate[]>(`/api/content/entity-candidates?project_id=${pid}&entity_type=character&status=pending&limit=120`)
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

  const generateCharactersByAi = async () => {
    if (!pid || isAiGenerating) return;
    setIsAiGenerating(true);
    try {
      const res = await api<{ message: string }>("/api/pipeline/bootstrap", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, scope: "characters", force: forceRewriteCharacters }),
      });
      await load();
      addToast("success", res.message || "AI 角色生成完成");
    } catch (e: unknown) {
      addToast("error", "AI 角色生成失败，请检查模型配置");
      setError(e instanceof Error ? e.message : "AI 角色生成失败");
    } finally {
      setIsAiGenerating(false);
    }
  };

  const generateCharactersFromChapters = async () => {
    if (!pid || isAiGeneratingFromChapters) return;
    setIsAiGeneratingFromChapters(true);
    try {
      const res = await api<{ message: string; errors?: string[] }>(`/api/projects/${pid}/generate-from-chapters`, {
        method: "POST",
        body: JSON.stringify({ scope: "characters", force: forceRewriteCharacters }),
      });
      await Promise.all([load(), loadPendingCandidates()]);
      addToast("success", res.message || "章节派生角色生成完成");
      if (Array.isArray(res.errors) && res.errors.length > 0) {
        addToast("warning", `章节派生有告警：${res.errors.length} 条`);
      }
    } catch (e: unknown) {
      addToast("error", "按章节生成角色失败，请检查模型配置");
      setError(e instanceof Error ? e.message : "按章节生成角色失败");
    } finally {
      setIsAiGeneratingFromChapters(false);
    }
  };

  const createChar = async () => {
    if (!pid) return;
    try {
      const c = await api<Character>("/api/characters/", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, name: "新角色", category: "配角" }),
      });
      setChars((prev) => [...prev, c]);
      void openEdit(c);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const normalizeEditableRelations = (rows: CharacterRelation[] | undefined): EditableRelation[] =>
    (rows || []).map((rel) => ({
      id: rel.id,
      target_id: rel.character_b_id,
      relation_type: rel.relation_type || "",
      description: rel.description || "",
    }));

  const openEdit = async (c: Character) => {
    const rid = ++detailReqId.current;
    setEditingChar(c);
    setEditForm({ ...c });
    setEditRelations(normalizeEditableRelations(c.outgoing_relations));
    if (!pid) return;
    setLoadingDetail(true);
    try {
      const detail = await api<Character>(`/api/characters/${c.id}`);
      if (rid !== detailReqId.current) return;
      setEditingChar(detail);
      setEditForm({ ...detail });
      setEditRelations(normalizeEditableRelations(detail.outgoing_relations));
    } catch {
      // 详情加载失败时保留列表数据，不阻断编辑。
    } finally {
      if (rid === detailReqId.current) {
        setLoadingDetail(false);
      }
    }
  };

  const createCharByAi = async () => {
    if (!pid || isAiCreatingSingle) return;
    setIsAiCreatingSingle(true);
    try {
      const c = await api<Character>("/api/characters/ai-generate", {
        method: "POST",
        body: JSON.stringify({ project_id: pid }),
      });
      await load();
      addToast("success", `AI 新增角色：${c.name}`);
      void openEdit(c);
    } catch (e: unknown) {
      addToast("error", "AI 单角色生成失败，请检查模型配置");
      setError(e instanceof Error ? e.message : "AI 单角色生成失败");
    } finally {
      setIsAiCreatingSingle(false);
    }
  };

  const handleSave = async () => {
    if (!editingChar || !pid) return;
    setIsSaving(true);
    try {
      const updated = await api<Character>(`/api/characters/${editingChar.id}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      const relationPayload = editRelations
        .map((rel) => ({
          target_id: (rel.target_id || "").trim(),
          relation_type: (rel.relation_type || "").trim(),
          description: (rel.description || "").trim(),
        }))
        .filter((rel) => rel.target_id && rel.target_id !== editingChar.id);
      await api(`/api/characters/${editingChar.id}/relations`, {
        method: "PUT",
        body: JSON.stringify({ relations: relationPayload }),
      });
      setChars((prev) => prev.map((c) => c.id === updated.id ? updated : c));
      setEditingChar(null);
      setEditRelations([]);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingChar || !pid) return;
    try {
      await api(`/api/characters/${editingChar.id}`, { method: "DELETE" });
      setChars((prev) => prev.filter((c) => c.id !== editingChar.id));
      setEditingChar(null);
      setEditRelations([]);
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
      addToast("warning", "请先选择要合并到的角色");
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
        addToast("success", "已合并到已有角色");
      } else {
        addToast("success", "已入库为角色");
      }
    } catch (e: unknown) {
      addToast("error", e instanceof Error ? e.message : "候选处理失败");
    } finally {
      setCandidateBusyId("");
    }
  };

  const keyword = search.trim();
  const filtered = chars.filter((c) =>
    (filter === "全部" || c.category === filter) &&
    (!keyword ||
      [
        c.name,
        c.gender,
        c.identity,
        c.appearance,
        c.personality,
        c.motivation,
        c.backstory,
        c.arc,
        c.usage_notes,
      ].some((value) => (value || "").includes(keyword)))
  );

  if (!pid) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon="👤" title="请先选择一个项目" description="在项目列表中选择或创建一个项目后，即可管理角色" />
      </div>
    );
  }

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <PageHeader
        title="角色管理"
        subtitle={chars.length > 0 ? `共 ${chars.length} 个角色` : undefined}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryButton onClick={generateCharactersByAi} disabled={isAiGenerating}>
              {isAiGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {isAiGenerating ? "生成中..." : "AI 生成角色"}
            </PrimaryButton>
            <PrimaryButton onClick={generateCharactersFromChapters} disabled={isAiGeneratingFromChapters || isAiGenerating}>
              {isAiGeneratingFromChapters ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {isAiGeneratingFromChapters ? "生成中..." : "按章节生成角色"}
            </PrimaryButton>
            <PrimaryButton onClick={createCharByAi} disabled={isAiCreatingSingle || isAiGenerating || isAiGeneratingFromChapters}>
              {isAiCreatingSingle ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {isAiCreatingSingle ? "生成中..." : "AI 新增1个"}
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
              title="开启后会覆盖已有角色内容"
            >
                <input
                  type="checkbox"
                  checked={forceRewriteCharacters}
                  onChange={(e) => setForceRewriteCharacters(e.currentTarget.checked)}
                  disabled={isAiGenerating || isAiGeneratingFromChapters}
                  style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                />
              覆盖重生成
            </label>
            <div style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--text-secondary)" }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索角色..."
                style={{ height: 36, borderRadius: 8, border: "none", paddingLeft: 32, paddingRight: 10, background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13, outline: "none", width: 180 }} />
            </div>
            <PrimaryButton onClick={createChar}><Plus size={14} />新建角色</PrimaryButton>
          </div>
        }
      />

      <div style={{ display: "flex", gap: 4 }}>
        {categories.map((cat) => (
          <button key={cat} onClick={() => setFilter(cat)} style={{
            padding: "6px 16px", borderRadius: 6, border: "none", fontSize: 12, cursor: "pointer",
            background: filter === cat ? "var(--accent-gold-dim)" : "transparent",
            color: filter === cat ? "var(--accent-gold)" : "var(--text-secondary)",
            transition: "all 0.15s",
          }}>{cat}</button>
        ))}
      </div>

      <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, background: "var(--bg-card)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            自动提取候选（角色）{pendingCandidates.length > 0 ? `· ${pendingCandidates.length}` : ""}
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
                        {c.category || "配角"}{c.gender ? ` · ${c.gender}` : ""}{c.age ? ` · ${c.age}` : ""}
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
                        minWidth: 140,
                        borderRadius: 6,
                        border: "1px solid var(--bg-border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 12,
                        padding: "5px 8px",
                      }}
                    >
                      <option value="">选择合并对象</option>
                      {chars.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.name}
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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🎭"
          title={chars.length === 0 ? "还没有角色" : "没有匹配的角色"}
          description={chars.length === 0 ? "点击右上角「新建角色」开始创建" : "尝试调整筛选条件"}
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {filtered.map((c) => {
            const color = categoryColors[c.category] || "#9CA3AF";
            return (
              <div key={c.id} onClick={() => { void openEdit(c); }} style={{
                padding: 20, borderRadius: 12, border: "1px solid var(--bg-border)",
                display: "flex", gap: 16, cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
              }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = color; e.currentTarget.style.background = color + "08"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--bg-border)"; e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ width: 48, height: 48, borderRadius: "50%", background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", color, fontSize: 18, fontWeight: 700, flexShrink: 0 }}>
                  {c.name[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 4, background: color + "22", color, fontSize: 10, fontWeight: 500 }}>{c.category}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                    {c.identity || "未填写身份"}
                    {c.gender ? ` · ${c.gender}` : ""}
                    {c.age ? ` · ${c.age}` : ""}
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", opacity: 0.7, lineHeight: 1.5, margin: 0, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {c.appearance || c.personality || "未填写外貌/性格"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 侧边编辑抽屉 */}
      <Drawer
        isOpen={!!editingChar}
        title="编辑角色信息"
        onClose={() => {
          detailReqId.current += 1;
          setLoadingDetail(false);
          setEditingChar(null);
          setEditRelations([]);
        }}
        onSave={handleSave}
        onDelete={handleDelete}
        isSaving={isSaving}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {loadingDetail ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              <Loader2 size={14} className="animate-spin" />
              正在加载角色详情...
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>姓名</label>
            <input
              value={editForm.name || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="例如：李逍遥"
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160, flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>类别</label>
              <select
                value={editForm.category || "配角"}
                onChange={(e) => setEditForm(prev => ({ ...prev, category: e.target.value }))}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              >
                {categories.filter(c => c !== "全部").map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 120 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>性别</label>
              <select
                value={editForm.gender || ""}
                onChange={(e) => setEditForm(prev => ({ ...prev, gender: e.target.value }))}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              >
                {genders.map(g => (
                  <option key={g || "__empty__"} value={g}>{g || "未设置"}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 120 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>年龄</label>
              <input
                value={editForm.age || ""}
                onChange={(e) => setEditForm(prev => ({ ...prev, age: e.target.value }))}
                placeholder="例如：24岁"
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 140 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>状态</label>
              <select
                value={editForm.status || "active"}
                onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value }))}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              >
                <option value="active">启用</option>
                <option value="inactive">停用</option>
              </select>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>身份/职业</label>
            <input
              value={editForm.identity || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, identity: e.target.value }))}
              placeholder="例如：蜀山派弟子、客栈小二..."
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>外貌描写</label>
            <textarea
              value={editForm.appearance || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, appearance: e.target.value }))}
              placeholder="例如：眉骨锋利，右眼下有淡淡疤痕..."
              rows={4}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>性格特征</label>
            <textarea
              value={editForm.personality || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, personality: e.target.value }))}
              placeholder="例如：冷静克制，但对家人会冲动护短..."
              rows={6}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>核心动机</label>
            <textarea
              value={editForm.motivation || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, motivation: e.target.value }))}
              placeholder="例如：夺回家族名誉，证明自己不是替代品..."
              rows={4}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>背景经历</label>
            <textarea
              value={editForm.backstory || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, backstory: e.target.value }))}
              placeholder="例如：少年时目睹师门覆灭，被迫隐姓埋名..."
              rows={6}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>角色弧光</label>
            <textarea
              value={editForm.arc || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, arc: e.target.value }))}
              placeholder="例如：从复仇执念到学会与过去和解..."
              rows={5}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>使用建议</label>
            <textarea
              value={editForm.usage_notes || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, usage_notes: e.target.value }))}
              placeholder="例如：前期制造信息差，中期推动冲突升级，后期承担价值抉择..."
              rows={5}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>关系网络（外发关系）</label>
              <button
                type="button"
                onClick={() =>
                  setEditRelations((prev) => [...prev, { target_id: "", relation_type: "", description: "" }])
                }
                style={{
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-card)",
                  color: "var(--text-secondary)",
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                新增关系
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              仅保存“当前角色到目标角色”的关系；反向关系请到对方角色中编辑。
            </div>
            {editRelations.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>暂无关系，点击“新增关系”添加。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {editRelations.map((rel, index) => (
                  <div key={rel.id || `new_${index}`} style={{ border: "1px solid var(--bg-border)", borderRadius: 8, padding: 8 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <select
                        value={rel.target_id}
                        onChange={(e) =>
                          setEditRelations((prev) =>
                            prev.map((row, i) => (i === index ? { ...row, target_id: e.target.value } : row)),
                          )
                        }
                        style={{
                          flex: 1,
                          padding: "7px 10px",
                          borderRadius: 8,
                          border: "1px solid var(--bg-border)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontSize: 12,
                        }}
                      >
                        <option value="">选择目标角色</option>
                        {chars
                          .filter((target) => target.id !== editingChar?.id)
                          .map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.name}
                            </option>
                          ))}
                      </select>
                      <input
                        value={rel.relation_type}
                        onChange={(e) =>
                          setEditRelations((prev) =>
                            prev.map((row, i) => (i === index ? { ...row, relation_type: e.target.value } : row)),
                          )
                        }
                        placeholder="关系类型（如：师徒）"
                        style={{
                          width: 130,
                          padding: "7px 10px",
                          borderRadius: 8,
                          border: "1px solid var(--bg-border)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontSize: 12,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setEditRelations((prev) => prev.filter((_row, i) => i !== index))
                        }
                        style={{
                          border: "1px solid rgba(239,68,68,0.4)",
                          background: "transparent",
                          color: "#ef4444",
                          borderRadius: 6,
                          padding: "6px 8px",
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <textarea
                      value={rel.description}
                      onChange={(e) =>
                        setEditRelations((prev) =>
                          prev.map((row, i) => (i === index ? { ...row, description: e.target.value } : row)),
                        )
                      }
                      placeholder="关系说明（可选）"
                      rows={2}
                      style={{
                        marginTop: 8,
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--bg-border)",
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 12,
                        resize: "vertical",
                        lineHeight: 1.6,
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Drawer>
    </div>
  );
}
