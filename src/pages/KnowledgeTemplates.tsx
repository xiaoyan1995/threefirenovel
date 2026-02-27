import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, RefreshCw } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";

type ReferenceType = "general" | "character" | "plot" | "scene" | "world" | "item" | "hook";

interface KnowledgeCollection {
  id: string;
  name: string;
}

interface TemplateItem {
  id: string;
  template_id: string;
  title: string;
  reference_type: ReferenceType;
  content: string;
}

interface GlobalTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  item_count: number;
  updated_at?: string;
}

interface GlobalTemplateDetail extends GlobalTemplate {
  items: TemplateItem[];
}

const panelStyle: CSSProperties = {
  border: "1px solid var(--bg-border)",
  borderRadius: 12,
  background: "var(--bg-card)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const btnStyle: CSSProperties = {
  border: "1px solid var(--bg-border)",
  borderRadius: 8,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
};

const inputStyle: CSSProperties = {
  width: "100%",
  height: 36,
  borderRadius: 8,
  border: "1px solid var(--bg-border)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: 13,
  padding: "0 10px",
};

const textAreaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 90,
  height: 90,
  padding: 10,
  resize: "vertical",
  lineHeight: 1.6,
};

const referenceOptions: Array<{ value: ReferenceType; label: string }> = [
  { value: "general", label: "通用参考" },
  { value: "character", label: "角色参考" },
  { value: "plot", label: "情节参考" },
  { value: "scene", label: "场景参考" },
  { value: "world", label: "世界观参考" },
  { value: "item", label: "道具参考" },
  { value: "hook", label: "钩子参考" },
];

export default function KnowledgeTemplates() {
  const navigate = useNavigate();
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [loading, setLoading] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [importingTemplate, setImportingTemplate] = useState(false);
  const [creatingFromCollection, setCreatingFromCollection] = useState(false);

  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [templates, setTemplates] = useState<GlobalTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [detail, setDetail] = useState<GlobalTemplateDetail | null>(null);

  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateDesc, setNewTemplateDesc] = useState("");
  const [newTemplateCategory, setNewTemplateCategory] = useState("");

  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [importCollectionName, setImportCollectionName] = useState("");

  const [itemTitle, setItemTitle] = useState("");
  const [itemContent, setItemContent] = useState("");
  const [itemReferenceType, setItemReferenceType] = useState<ReferenceType>("general");
  const [editingItemId, setEditingItemId] = useState("");

  const [fromCollectionId, setFromCollectionId] = useState("");
  const [fromCollectionTemplateName, setFromCollectionTemplateName] = useState("");
  const [fromCollectionTemplateDesc, setFromCollectionTemplateDesc] = useState("");
  const [fromCollectionTemplateCategory, setFromCollectionTemplateCategory] = useState("");
  const refreshBaseReqId = useRef(0);
  const detailReqId = useRef(0);

  const refreshBase = useCallback(async () => {
    if (!pid) return;
    const id = refreshBaseReqId.current + 1;
    refreshBaseReqId.current = id;
    setLoading(true);
    try {
      const [nextTemplates, nextCollections] = await Promise.all([
        api<GlobalTemplate[]>("/api/knowledge/template-library/templates"),
        api<KnowledgeCollection[]>(`/api/knowledge/collections?project_id=${pid}`),
      ]);
      if (refreshBaseReqId.current !== id) return;
      setTemplates(nextTemplates || []);
      setCollections(nextCollections || []);
      setSelectedTemplateId((prev) => {
        if (prev && (nextTemplates || []).some((x) => x.id === prev)) return prev;
        return (nextTemplates || [])[0]?.id || "";
      });
      setFromCollectionId((prev) => {
        if (prev && (nextCollections || []).some((x) => x.id === prev)) return prev;
        return (nextCollections || [])[0]?.id || "";
      });
    } catch {
      if (refreshBaseReqId.current !== id) return;
      addToast("error", "模板库数据加载失败");
    } finally {
      if (refreshBaseReqId.current === id) setLoading(false);
    }
  }, [pid, api, addToast]);

  const loadTemplateDetail = useCallback(async () => {
    if (!selectedTemplateId) {
      setDetail(null);
      setEditName("");
      setEditDesc("");
      setEditCategory("");
      return;
    }
    const id = detailReqId.current + 1;
    detailReqId.current = id;
    setLoadingDetail(true);
    try {
      const data = await api<GlobalTemplateDetail>(`/api/knowledge/template-library/templates/${selectedTemplateId}`);
      if (detailReqId.current !== id) return;
      setDetail(data);
      setEditName(data.name || "");
      setEditDesc(data.description || "");
      setEditCategory(data.category || "");
      setImportCollectionName(data.name || "");
    } catch {
      if (detailReqId.current !== id) return;
      setDetail(null);
      addToast("error", "模板详情加载失败");
    } finally {
      if (detailReqId.current === id) setLoadingDetail(false);
    }
  }, [selectedTemplateId, api, addToast]);

  useEffect(() => {
    if (!pid) {
      setTemplates([]);
      setCollections([]);
      setSelectedTemplateId("");
      setDetail(null);
      return;
    }
    refreshBase();
  }, [pid, refreshBase]);

  useEffect(() => {
    loadTemplateDetail();
  }, [loadTemplateDetail]);

  const createTemplate = async () => {
    if (!newTemplateName.trim()) {
      addToast("warning", "请填写模板名称");
      return;
    }
    setCreatingTemplate(true);
    try {
      const created = await api<GlobalTemplate>("/api/knowledge/template-library/templates", {
        method: "POST",
        body: JSON.stringify({
          name: newTemplateName.trim(),
          description: newTemplateDesc.trim(),
          category: newTemplateCategory.trim(),
        }),
      });
      addToast("success", "模板已创建");
      setNewTemplateName("");
      setNewTemplateDesc("");
      setNewTemplateCategory("");
      await refreshBase();
      setSelectedTemplateId(created.id);
    } catch {
      addToast("error", "创建模板失败");
    } finally {
      setCreatingTemplate(false);
    }
  };

  const saveTemplateMeta = async () => {
    if (!detail) return;
    setSavingTemplate(true);
    try {
      await api(`/api/knowledge/template-library/templates/${detail.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: editName.trim() || detail.name,
          description: editDesc.trim(),
          category: editCategory.trim(),
        }),
      });
      addToast("success", "模板信息已保存");
      refreshBase();
      loadTemplateDetail();
    } catch {
      addToast("error", "模板保存失败");
    } finally {
      setSavingTemplate(false);
    }
  };

  const deleteTemplate = async () => {
    if (!detail) return;
    if (!window.confirm(`确认删除模板「${detail.name}」？`)) return;
    try {
      await api(`/api/knowledge/template-library/templates/${detail.id}`, { method: "DELETE" });
      addToast("success", "模板已删除");
      setSelectedTemplateId("");
      refreshBase();
    } catch {
      addToast("error", "删除模板失败");
    }
  };

  const resetItemEditor = () => {
    setEditingItemId("");
    setItemTitle("");
    setItemContent("");
    setItemReferenceType("general");
  };

  const saveItem = async () => {
    if (!selectedTemplateId || !itemTitle.trim() || !itemContent.trim()) {
      addToast("warning", "条目标题和内容不能为空");
      return;
    }
    setSavingItem(true);
    try {
      if (editingItemId) {
        await api(`/api/knowledge/template-library/items/${editingItemId}`, {
          method: "PUT",
          body: JSON.stringify({
            title: itemTitle.trim(),
            content: itemContent,
            reference_type: itemReferenceType,
          }),
        });
        addToast("success", "模板条目已更新");
      } else {
        await api(`/api/knowledge/template-library/templates/${selectedTemplateId}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: itemTitle.trim(),
            content: itemContent,
            reference_type: itemReferenceType,
            metadata: {},
          }),
        });
        addToast("success", "模板条目已新增");
      }
      resetItemEditor();
      refreshBase();
      loadTemplateDetail();
    } catch {
      addToast("error", "保存条目失败");
    } finally {
      setSavingItem(false);
    }
  };

  const startEditItem = (item: TemplateItem) => {
    setEditingItemId(item.id);
    setItemTitle(item.title);
    setItemContent(item.content);
    setItemReferenceType(item.reference_type);
  };

  const deleteItem = async (itemId: string) => {
    if (!window.confirm("确认删除该模板条目？")) return;
    try {
      await api(`/api/knowledge/template-library/items/${itemId}`, { method: "DELETE" });
      addToast("success", "条目已删除");
      if (editingItemId === itemId) resetItemEditor();
      refreshBase();
      loadTemplateDetail();
    } catch {
      addToast("error", "删除条目失败");
    }
  };

  const importTemplateToProject = async () => {
    if (!pid || !detail) return;
    setImportingTemplate(true);
    try {
      await api("/api/knowledge/template-library/import", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          template_id: detail.id,
          collection_name: importCollectionName.trim() || detail.name,
        }),
      });
      addToast("success", "模板已导入当前项目（会生成新的资料夹）");
      navigate("/knowledge-assets");
    } catch {
      addToast("error", "模板导入失败");
    } finally {
      setImportingTemplate(false);
    }
  };

  const createTemplateFromCollection = async () => {
    if (!pid || !fromCollectionId) {
      addToast("warning", "请先选择资料夹");
      return;
    }
    setCreatingFromCollection(true);
    try {
      const created = await api<GlobalTemplate>("/api/knowledge/template-library/create-from-collection", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          collection_id: fromCollectionId,
          name: fromCollectionTemplateName.trim(),
          description: fromCollectionTemplateDesc.trim(),
          category: fromCollectionTemplateCategory.trim(),
        }),
      });
      addToast("success", "已从资料夹生成全局模板");
      setFromCollectionTemplateName("");
      setFromCollectionTemplateDesc("");
      setFromCollectionTemplateCategory("");
      await refreshBase();
      setSelectedTemplateId(created.id);
    } catch {
      addToast("error", "从资料夹生成模板失败");
    } finally {
      setCreatingFromCollection(false);
    }
  };

  const sortedTemplates = useMemo(() => templates, [templates]);

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, color: "#27456d" }}>全局模板库</h1>
          <p style={{ margin: "2px 0 0", color: "var(--text-secondary)", fontSize: 12 }}>管理可复用模板，并可导入当前项目形成资料夹。</p>
        </div>
        <button onClick={refreshBase} style={btnStyle} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 10 }}>
        <aside style={{ ...panelStyle, minHeight: 730 }}>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-assets")}>
            个人知识库
          </button>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-rules")}>
            规则包中心
          </button>
          <button
            style={{ ...btnStyle, justifyContent: "flex-start", background: "var(--accent-gold-dim)", color: "var(--accent-gold)", fontWeight: 700 }}
            onClick={() => navigate("/knowledge-templates")}
          >
            全局模板库
          </button>

          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>从项目资料夹提取为可复用模板：</div>
          <select style={inputStyle} value={fromCollectionId} onChange={(e) => setFromCollectionId(e.target.value)}>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input style={inputStyle} value={fromCollectionTemplateName} onChange={(e) => setFromCollectionTemplateName(e.target.value)} placeholder="模板名（可选）" />
          <input style={inputStyle} value={fromCollectionTemplateCategory} onChange={(e) => setFromCollectionTemplateCategory(e.target.value)} placeholder="分类（可选）" />
          <textarea style={textAreaStyle} value={fromCollectionTemplateDesc} onChange={(e) => setFromCollectionTemplateDesc(e.target.value)} placeholder="模板说明（可选）" />
          <button onClick={createTemplateFromCollection} style={btnStyle} disabled={creatingFromCollection}>
            {creatingFromCollection ? <Loader2 size={13} className="animate-spin" /> : null}
            从资料夹生成模板
          </button>
        </aside>

        <section style={{ ...panelStyle, minHeight: 730, gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>新建模板</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
            <input style={inputStyle} value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} placeholder="模板名称" />
            <input style={inputStyle} value={newTemplateCategory} onChange={(e) => setNewTemplateCategory(e.target.value)} placeholder="分类（可选）" />
            <input style={inputStyle} value={newTemplateDesc} onChange={(e) => setNewTemplateDesc(e.target.value)} placeholder="描述（可选）" />
            <button onClick={createTemplate} style={btnStyle} disabled={creatingTemplate}>
              {creatingTemplate ? <Loader2 size={13} className="animate-spin" /> : null}
              创建
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 10, minHeight: 0, flex: 1 }}>
            <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 8, background: "var(--bg-input)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>模板列表（{sortedTemplates.length}）</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", maxHeight: 520 }}>
                {sortedTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => setSelectedTemplateId(tpl.id)}
                    style={{
                      ...btnStyle,
                      justifyContent: "space-between",
                      background: selectedTemplateId === tpl.id ? "var(--accent-gold-dim)" : "var(--bg-card)",
                      color: selectedTemplateId === tpl.id ? "var(--accent-gold)" : "var(--text-primary)",
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tpl.item_count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 10, background: "var(--bg-input)", display: "flex", flexDirection: "column", gap: 8 }}>
              {loadingDetail ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>加载模板详情中...</div>
              ) : !detail ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>请选择一个模板。</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>模板信息</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="模板名称" />
                    <input style={inputStyle} value={editCategory} onChange={(e) => setEditCategory(e.target.value)} placeholder="分类" />
                  </div>
                  <textarea style={textAreaStyle} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="模板描述" />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveTemplateMeta} style={btnStyle} disabled={savingTemplate}>
                      {savingTemplate ? <Loader2 size={13} className="animate-spin" /> : null}
                      保存模板
                    </button>
                    <button onClick={deleteTemplate} style={btnStyle}>删除模板</button>
                  </div>

                  <div style={{ borderTop: "1px solid var(--bg-border)", paddingTop: 8, marginTop: 2 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{editingItemId ? "编辑模板条目" : "新增模板条目"}</div>
                    <input style={inputStyle} value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} placeholder="条目标题" />
                    <select style={{ ...inputStyle, marginTop: 8 }} value={itemReferenceType} onChange={(e) => setItemReferenceType(e.target.value as ReferenceType)}>
                      {referenceOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <textarea style={{ ...textAreaStyle, marginTop: 8, minHeight: 110, height: 110 }} value={itemContent} onChange={(e) => setItemContent(e.target.value)} placeholder="条目内容" />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={saveItem} style={btnStyle} disabled={savingItem}>
                        {savingItem ? <Loader2 size={13} className="animate-spin" /> : null}
                        {editingItemId ? "更新条目" : "添加条目"}
                      </button>
                      {editingItemId && (
                        <button onClick={resetItemEditor} style={btnStyle}>取消编辑</button>
                      )}
                    </div>
                  </div>

                  <div style={{ borderTop: "1px solid var(--bg-border)", paddingTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>条目列表（{detail.items?.length || 0}）</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                      {(detail.items || []).map((item) => (
                        <div
                          key={item.id}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 8,
                            padding: 8,
                            background: "var(--bg-card)",
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
                            <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{referenceOptions.find((x) => x.value === item.reference_type)?.label || "通用"}</div>
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => startEditItem(item)} style={btnStyle}>编辑</button>
                            <button onClick={() => deleteItem(item.id)} style={btnStyle}>删除</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ borderTop: "1px solid var(--bg-border)", paddingTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>导入到当前项目</div>
                    <input
                      style={inputStyle}
                      value={importCollectionName}
                      onChange={(e) => setImportCollectionName(e.target.value)}
                      placeholder="导入后资料夹名称"
                    />
                    <button onClick={importTemplateToProject} style={{ ...btnStyle, marginTop: 8 }} disabled={importingTemplate}>
                      {importingTemplate ? <Loader2 size={13} className="animate-spin" /> : null}
                      导入到当前项目
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
