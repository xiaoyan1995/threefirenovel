import { useEffect, useState, useCallback, useRef } from "react";
import { Loader2, Plus, WandSparkles } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { Loading, EmptyState, ErrorBanner, PageHeader, PrimaryButton } from "../components/ui";
import { Drawer } from "../components/ui/Drawer";
import type { Chapter, Foreshadow } from "../types";

const statusColor: Record<string, string> = { planted: "#4CAF50", hinted: "#FF9800", resolved: "#2196F3" };
const statusLabel: Record<string, string> = { planted: "已埋设", hinted: "已暗示", resolved: "已回收" };
const importanceColor: Record<string, string> = { 高: "#F44336", 中: "#FF9800", 低: "#9E9E9E" };

type ExtractPreviewItem = {
  name: string;
  description: string;
  category: string;
  importance: "高" | "中" | "低";
  status: "planted" | "hinted" | "resolved";
  plant_text: string;
  resolve_text: string;
  confidence: number;
  selected: boolean;
};

export default function Foreshadowing() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const [items, setItems] = useState<Foreshadow[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pid = currentProject?.id;
  const reqId = useRef(0);

  // Edit drawer state
  const [editingItem, setEditingItem] = useState<Foreshadow | null>(null);
  const [editForm, setEditForm] = useState<Partial<Foreshadow>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractChapterId, setExtractChapterId] = useState("");
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractSaving, setExtractSaving] = useState(false);
  const [extractItems, setExtractItems] = useState<ExtractPreviewItem[]>([]);
  const [extractNote, setExtractNote] = useState("");

  useEffect(() => { setItems([]); setError(""); setLoading(true); }, [pid]);

  const load = useCallback(() => {
    if (!pid) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true); setError("");
    api<Foreshadow[]>(`/api/content/foreshadowing?project_id=${pid}`)
      .then((d) => { if (reqId.current === id) setItems(d); })
      .catch((e: Error) => { if (reqId.current === id) setError(e.message); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [pid, api]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!pid) {
      setChapters([]);
      setExtractChapterId("");
      return;
    }
    api<Chapter[]>(`/api/chapters/?project_id=${pid}`)
      .then((list) => {
        setChapters(list);
        setExtractChapterId((prev) => prev || (list.length > 0 ? list[list.length - 1].id : ""));
      })
      .catch(() => {
        setChapters([]);
      });
  }, [pid, api]);

  const addItem = async () => {
    if (!pid) return;
    try {
      const f = await api<Foreshadow>("/api/content/foreshadowing", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, name: "新伏笔", description: "", category: "剧情", importance: "中" }),
      });
      setItems((prev) => [...prev, f]);
      openEdit(f);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const openExtractDrawer = () => {
    if (chapters.length > 0 && !extractChapterId) {
      setExtractChapterId(chapters[chapters.length - 1].id);
    }
    setExtractItems([]);
    setExtractNote("");
    setExtractOpen(true);
  };

  const runExtractPreview = async () => {
    if (!pid) return;
    if (!extractChapterId) {
      addToast("warning", "请先选择要分析的章节");
      return;
    }
    setExtractLoading(true);
    try {
      const resp = await api<{ chapter_id?: string; chapter_title?: string; note?: string; items?: any[] }>(
        "/api/content/foreshadowing/extract-preview",
        {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            chapter_id: extractChapterId,
            limit: 10,
          }),
        }
      );
      const mapped: ExtractPreviewItem[] = (resp.items || []).map((item: any) => ({
        name: String(item?.name || "").trim(),
        description: String(item?.description || "").trim(),
        category: String(item?.category || "剧情").trim() || "剧情",
        importance: (["高", "中", "低"].includes(String(item?.importance || "")) ? String(item.importance) : "中") as "高" | "中" | "低",
        status: (["planted", "hinted", "resolved"].includes(String(item?.status || "")) ? String(item.status) : "hinted") as "planted" | "hinted" | "resolved",
        plant_text: String(item?.plant_text || "").trim(),
        resolve_text: String(item?.resolve_text || "").trim(),
        confidence: Number(item?.confidence || 0),
        selected: true,
      })).filter((it) => it.name && it.description);
      setExtractItems(mapped);
      setExtractNote(String(resp.note || ""));
      if (mapped.length === 0) {
        addToast("info", "本章未识别到可入库的伏笔（这通常是正常情况）");
      } else {
        addToast("success", `已提取 ${mapped.length} 条候选，请确认后入库`);
      }
    } catch (e: unknown) {
      addToast("error", e instanceof Error ? e.message : "自动提取失败");
    } finally {
      setExtractLoading(false);
    }
  };

  const commitExtractItems = async () => {
    if (!pid) return;
    const selected = extractItems.filter((it) => it.selected && it.name.trim() && it.description.trim());
    if (selected.length === 0) {
      addToast("warning", "请至少保留一条候选后再入库");
      return;
    }
    setExtractSaving(true);
    try {
      const resp = await api<{ inserted: number; skipped: number; items?: Foreshadow[] }>(
        "/api/content/foreshadowing/extract-commit",
        {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            chapter_id: extractChapterId || null,
            items: selected.map((it) => ({
              name: it.name,
              description: it.description,
              category: it.category || "剧情",
              importance: it.importance,
              status: it.status,
              plant_text: it.plant_text,
              resolve_text: it.resolve_text,
              confidence: it.confidence,
            })),
          }),
        }
      );
      await load();
      setExtractOpen(false);
      addToast("success", `已入库 ${resp.inserted} 条，跳过重复 ${resp.skipped} 条`);
    } catch (e: unknown) {
      addToast("error", e instanceof Error ? e.message : "入库失败");
    } finally {
      setExtractSaving(false);
    }
  };

  const openEdit = (item: Foreshadow) => {
    setEditingItem(item);
    setEditForm({ ...item });
  };

  const handleSave = async () => {
    if (!editingItem || !pid) return;
    setIsSaving(true);
    try {
      const updated = await api<Foreshadow>(`/api/content/foreshadowing/${editingItem.id}`, {
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
      await api(`/api/content/foreshadowing/${editingItem.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== editingItem.id));
      setEditingItem(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const stats = [
    { label: "已埋设", count: items.filter((f) => f.status === "planted").length, color: "#4CAF50" },
    { label: "已暗示", count: items.filter((f) => f.status === "hinted").length, color: "#FF9800" },
    { label: "已回收", count: items.filter((f) => f.status === "resolved").length, color: "#2196F3" },
  ];

  if (!pid) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon="🔮" title="请先选择一个项目" description="在项目列表中选择或创建一个项目后，即可管理伏笔" />
      </div>
    );
  }

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <PageHeader
        title="伏笔追踪"
        subtitle={items.length > 0 ? `共 ${items.length} 条伏笔` : undefined}
        action={(
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={openExtractDrawer}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <WandSparkles size={14} />
              从当前章节自动提取伏笔
            </button>
            <PrimaryButton onClick={addItem}><Plus size={14} />添加伏笔</PrimaryButton>
          </div>
        )}
      />

      <div style={{ display: "flex", gap: 24 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ flex: 1, textAlign: "center", padding: 24 }}>
            <div style={{ fontSize: 40, fontWeight: 700, color: s.color }}>{s.count}</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          icon="🔮"
          title="还没有伏笔"
          description="点击右上角「添加伏笔」开始埋设伏笔"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.4fr", padding: "8px 16px", fontSize: 11, color: "var(--text-secondary)", opacity: 0.6 }}>
            <span>伏笔名称</span><span>分类</span><span>状态</span><span>重要度</span><span>埋设/回收章节</span>
          </div>
          {items.map((f) => {
            const sc = statusColor[f.status] || "#9E9E9E";
            const sl = statusLabel[f.status] || f.status;
            const ic = importanceColor[f.importance] || "#9E9E9E";
            return (
              <div key={f.id} onClick={() => openEdit(f)} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1.4fr", padding: "12px 16px", borderRadius: 8, alignItems: "center", cursor: "pointer", fontSize: 13, transition: "background 0.15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-card)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: sc }} />
                  {f.name}
                </span>
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{f.category}</span>
                <span><span style={{ padding: "2px 10px", borderRadius: 4, background: sc + "22", color: sc, fontSize: 11 }}>{sl}</span></span>
                <span><span style={{ padding: "2px 10px", borderRadius: 4, background: ic + "22", color: ic, fontSize: 11 }}>{f.importance}</span></span>
                <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                  {(f.plant_chapter || "-") + " / " + (f.resolve_chapter || "-")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 侧边编辑抽屉 */}
      <Drawer
        isOpen={!!editingItem}
        title="编辑伏笔"
        onClose={() => setEditingItem(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        isSaving={isSaving}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>伏笔名称</label>
            <input
              value={editForm.name || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="例如：神秘的老爷爷..."
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>状态</label>
              <select
                value={editForm.status || "planted"}
                onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value }))}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              >
                <option value="planted">已埋设</option>
                <option value="hinted">已暗示</option>
                <option value="resolved">已回收</option>
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>重要性</label>
              <select
                value={editForm.importance || "中"}
                onChange={(e) => setEditForm(prev => ({ ...prev, importance: e.target.value }))}
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              >
                <option value="高">高 (主线伏笔)</option>
                <option value="中">中 (支线伏笔)</option>
                <option value="低">低 (彩蛋/细节)</option>
              </select>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>分类</label>
            <input
              value={editForm.category || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, category: e.target.value }))}
              placeholder="例如：剧情、人物、物品..."
              style={{
                padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>详细描述</label>
            <textarea
              value={editForm.description || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder="详细描述这项伏笔的内容以及计划如何回收..."
              rows={10}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>埋设章节ID</label>
              <input
                value={editForm.plant_chapter_id || ""}
                onChange={(e) => setEditForm(prev => ({ ...prev, plant_chapter_id: e.target.value || null }))}
                placeholder="可留空"
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>回收章节ID</label>
              <input
                value={editForm.resolve_chapter_id || ""}
                onChange={(e) => setEditForm(prev => ({ ...prev, resolve_chapter_id: e.target.value || null }))}
                placeholder="可留空"
                style={{
                  padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                  background: "var(--bg)", color: "var(--text)", fontSize: 13,
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>埋设内容</label>
            <textarea
              value={editForm.plant_text || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, plant_text: e.target.value }))}
              placeholder="记录埋设时的具体文本或线索..."
              rows={4}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>回收内容</label>
            <textarea
              value={editForm.resolve_text || ""}
              onChange={(e) => setEditForm(prev => ({ ...prev, resolve_text: e.target.value }))}
              placeholder="记录回收时的兑现方式..."
              rows={4}
              style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
                background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical",
                lineHeight: 1.6
              }}
            />
          </div>
        </div>
      </Drawer>

      <Drawer
        isOpen={extractOpen}
        title="自动提取伏笔（预览）"
        onClose={() => setExtractOpen(false)}
        onSave={commitExtractItems}
        saveLabel="入库选中项"
        isSaving={extractSaving}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>分析章节</label>
            <select
              value={extractChapterId}
              onChange={(e) => setExtractChapterId(e.target.value)}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13,
              }}
            >
              {chapters.length === 0 ? (
                <option value="">暂无章节</option>
              ) : chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  第{ch.chapter_num}章《{ch.title || "未命名"}》
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={runExtractPreview}
            disabled={extractLoading || !extractChapterId}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              borderRadius: 8,
              border: "1px solid var(--bg-border)",
              background: extractLoading || !extractChapterId ? "var(--bg-border)" : "var(--bg-card)",
              color: extractLoading || !extractChapterId ? "var(--text-secondary)" : "var(--text)",
              cursor: extractLoading || !extractChapterId ? "not-allowed" : "pointer",
              padding: "8px 12px",
              fontSize: 13,
            }}
          >
            {extractLoading ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}
            {extractLoading ? "提取中..." : "开始提取"}
          </button>

          {extractNote && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {extractNote}
            </div>
          )}

          {extractItems.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", padding: "10px 0" }}>
              还没有候选项。点击“开始提取”生成预览；空结果也可能是正常情况。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {extractItems.map((it, idx) => (
                <div key={`${idx}-${it.name}`} style={{ border: "1px solid var(--bg-border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)" }}>
                      <input
                        type="checkbox"
                        checked={it.selected}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, selected: checked } : x));
                        }}
                      />
                      入库
                    </label>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      置信度 {Math.round((it.confidence || 0) * 100)}%
                    </div>
                    <button
                      onClick={() => setExtractItems((prev) => prev.filter((_, i) => i !== idx))}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--status-inactive)",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      移除
                    </button>
                  </div>

                  <input
                    value={it.name}
                    onChange={(e) => {
                      const value = e.target.value;
                      setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, name: value } : x));
                    }}
                    placeholder="伏笔名称"
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg)", color: "var(--text)", fontSize: 13 }}
                  />

                  <textarea
                    value={it.description}
                    onChange={(e) => {
                      const value = e.target.value;
                      setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, description: value } : x));
                    }}
                    placeholder="伏笔描述"
                    rows={3}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, resize: "vertical" }}
                  />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <input
                      value={it.category}
                      onChange={(e) => {
                        const value = e.target.value;
                        setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, category: value } : x));
                      }}
                      placeholder="分类"
                      style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
                    />
                    <select
                      value={it.importance}
                      onChange={(e) => {
                        const value = e.target.value as "高" | "中" | "低";
                        setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, importance: value } : x));
                      }}
                      style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
                    >
                      <option value="高">高</option>
                      <option value="中">中</option>
                      <option value="低">低</option>
                    </select>
                    <select
                      value={it.status}
                      onChange={(e) => {
                        const value = e.target.value as "planted" | "hinted" | "resolved";
                        setExtractItems((prev) => prev.map((x, i) => i === idx ? { ...x, status: value } : x));
                      }}
                      style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg)", color: "var(--text)", fontSize: 12 }}
                    >
                      <option value="planted">已埋设</option>
                      <option value="hinted">已暗示</option>
                      <option value="resolved">已回收</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>
    </div>
  );
}
