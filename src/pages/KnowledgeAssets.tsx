import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, FileUp, Folder, FolderPlus, LayoutGrid, List, RefreshCw, Search } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";

type ReferenceType = "general" | "character" | "plot" | "scene" | "world" | "item" | "hook";

interface KnowledgeCollection {
  id: string;
  project_id: string;
  name: string;
  description: string;
  created_at?: string;
  updated_at?: string;
}

interface KnowledgeSource {
  id: string;
  title: string;
  source_type: string;
  collection_id: string | null;
  reference_type: ReferenceType;
  enabled: number | boolean;
  created_at?: string;
  preview_text?: string;
}

interface MenuState {
  x: number;
  y: number;
  kind: "collection" | "source";
  id: string;
}

interface PlanningKnowledgeDragPayload {
  kind: "knowledge_source";
  project_id: string;
  source_id: string;
  title: string;
  reference_type: ReferenceType;
}

const KNOWLEDGE_SOURCE_DND_MIME = "application/x-sanhuoai-knowledge-source";

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
  minHeight: 100,
  height: 100,
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

function parseApiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || "");
  const payload = raw.replace(/^API\s+\d+\s*:\s*/i, "").trim();
  if (!payload) return "未知错误";
  try {
    const parsed = JSON.parse(payload) as { detail?: unknown; message?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // ignore json parse failure
  }
  return payload;
}

function toTypeTag(source: KnowledgeSource): string {
  const parts = source.title.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1].trim().toLowerCase() : "";
  if (ext) {
    if (ext === "markdown") return "MD";
    if (ext === "docx") return "WORD";
    return ext.toUpperCase();
  }
  const st = (source.source_type || "").toLowerCase();
  if (st === "markdown") return "MD";
  if (st === "docx") return "WORD";
  if (st) return st.toUpperCase();
  return "FILE";
}

function toPreviewText(source: KnowledgeSource): string {
  const raw = (source.preview_text || "").replace(/\r/g, "").trim();
  if (raw) return raw;
  return "暂无文本预览";
}

function toPageTag(source: KnowledgeSource): string {
  const length = (source.preview_text || "").length;
  const total = Math.max(1, Math.ceil(length / 120));
  return `1/${total}`;
}

export default function KnowledgeAssets() {
  const navigate = useNavigate();
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [loading, setLoading] = useState(false);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("all");
  const [selectedSourceId, setSelectedSourceId] = useState("");

  const [searchKeyword, setSearchKeyword] = useState("");
  const [filterType, setFilterType] = useState<"all" | ReferenceType>("all");
  const [viewMode, setViewMode] = useState<"card" | "list">("list");

  const [importTitle, setImportTitle] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importReferenceType, setImportReferenceType] = useState<ReferenceType>("general");
  const [importingText, setImportingText] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showAdvancedImport, setShowAdvancedImport] = useState(false);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const refreshReqId = useRef(0);

  const refreshData = useCallback(async () => {
    if (!pid) return;
    const id = refreshReqId.current + 1;
    refreshReqId.current = id;
    setLoading(true);
    try {
      const [nextCollections, nextSources] = await Promise.all([
        api<KnowledgeCollection[]>(`/api/knowledge/collections?project_id=${pid}`),
        api<KnowledgeSource[]>(`/api/knowledge/sources?project_id=${pid}`),
      ]);
      if (refreshReqId.current !== id) return;
      setCollections(nextCollections || []);
      setSources(nextSources || []);
      setSelectedCollectionId((prev) => {
        if (prev === "all") return "all";
        return (nextCollections || []).some((x) => x.id === prev) ? prev : "all";
      });
      setSelectedSourceId((prev) => {
        if (!prev) return (nextSources || [])[0]?.id || "";
        return (nextSources || []).some((x) => x.id === prev) ? prev : (nextSources || [])[0]?.id || "";
      });
    } catch {
      if (refreshReqId.current !== id) return;
      addToast("error", "知识库数据加载失败");
    } finally {
      if (refreshReqId.current === id) setLoading(false);
    }
  }, [pid, api, addToast]);

  useEffect(() => {
    if (!pid) {
      setCollections([]);
      setSources([]);
      setSelectedCollectionId("all");
      setSelectedSourceId("");
      return;
    }
    refreshData();
  }, [pid, refreshData]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const collectionNameMap = useMemo(() => {
    return new Map(collections.map((x) => [x.id, x.name]));
  }, [collections]);

  const visibleSources = useMemo(() => {
    if (selectedCollectionId === "all") return sources;
    return sources.filter((x) => x.collection_id === selectedCollectionId);
  }, [sources, selectedCollectionId]);

  const filteredSources = useMemo(() => {
    const key = searchKeyword.trim().toLowerCase();
    return visibleSources.filter((x) => {
      if (filterType !== "all" && x.reference_type !== filterType) return false;
      if (!key) return true;
      return x.title.toLowerCase().includes(key);
    });
  }, [visibleSources, searchKeyword, filterType]);

  const openMenu = (e: MouseEvent, kind: "collection" | "source", id: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind, id });
  };

  const handleSourceDragStart = (e: DragEvent<HTMLButtonElement>, source: KnowledgeSource) => {
    if (!pid) return;
    const payload: PlanningKnowledgeDragPayload = {
      kind: "knowledge_source",
      project_id: pid,
      source_id: source.id,
      title: source.title,
      reference_type: source.reference_type,
    };
    const raw = JSON.stringify(payload);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(KNOWLEDGE_SOURCE_DND_MIME, raw);
    e.dataTransfer.setData("text/x-sanhuoai-knowledge-source", raw);
    e.dataTransfer.setData("application/json", raw);
    e.dataTransfer.setData("text/plain", raw);
  };

  const createCollection = async () => {
    if (!pid) return;
    const name = window.prompt("资料夹名称", "新资料夹");
    if (!name || !name.trim()) return;
    try {
      await api("/api/knowledge/collections", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, name: name.trim(), description: "" }),
      });
      addToast("success", "资料夹已创建");
      refreshData();
    } catch {
      addToast("error", "创建资料夹失败");
    }
  };

  const renameCollection = async (collectionId: string) => {
    const target = collections.find((x) => x.id === collectionId);
    if (!target) return;
    const name = window.prompt("重命名资料夹", target.name);
    if (!name || !name.trim()) return;
    try {
      await api(`/api/knowledge/collections/${collectionId}`, {
        method: "PUT",
        body: JSON.stringify({ name: name.trim() }),
      });
      addToast("success", "资料夹已重命名");
      refreshData();
    } catch {
      addToast("error", "重命名失败");
    }
  };

  const deleteCollection = async (collectionId: string) => {
    const target = collections.find((x) => x.id === collectionId);
    if (!target) return;
    if (!window.confirm(`确认删除资料夹「${target.name}」？文件会变成未分组。`)) return;
    try {
      await api(`/api/knowledge/collections/${collectionId}`, { method: "DELETE" });
      addToast("success", "资料夹已删除");
      if (selectedCollectionId === collectionId) setSelectedCollectionId("all");
      refreshData();
    } catch {
      addToast("error", "删除资料夹失败");
    }
  };

  const renameSource = async (sourceId: string) => {
    if (!pid) return;
    const target = sources.find((x) => x.id === sourceId);
    if (!target) return;
    const name = window.prompt("重命名文件", target.title);
    if (!name || !name.trim()) return;
    try {
      await api(`/api/knowledge/sources/${sourceId}`, {
        method: "PUT",
        body: JSON.stringify({ project_id: pid, title: name.trim() }),
      });
      addToast("success", "文件已重命名");
      refreshData();
    } catch {
      addToast("error", "重命名失败");
    }
  };

  const quickSetReferenceType = async (sourceId: string, refType: ReferenceType) => {
    if (!pid) return;
    try {
      await api(`/api/knowledge/sources/${sourceId}/reference-type?project_id=${pid}&reference_type=${refType}`, {
        method: "PUT",
      });
      refreshData();
    } catch {
      addToast("error", "参考类型更新失败");
    }
  };

  const deleteSource = async (sourceId: string) => {
    if (!pid) return;
    const target = sources.find((x) => x.id === sourceId);
    if (!target) return;
    if (!window.confirm(`确认删除文件「${target.title}」？`)) return;
    try {
      await api(`/api/knowledge/sources/${sourceId}?project_id=${pid}`, { method: "DELETE" });
      addToast("success", "文件已删除");
      if (selectedSourceId === sourceId) setSelectedSourceId("");
      refreshData();
    } catch {
      addToast("error", "删除文件失败");
    }
  };

  const importText = async () => {
    if (!pid) return;
    if (!importContent.trim()) {
      addToast("warning", "请先输入要导入的文本");
      return;
    }
    setImportingText(true);
    try {
      await api("/api/knowledge/import", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          title: importTitle.trim() || "未命名资料",
          content: importContent.trim(),
          source_type: "text",
          collection_id: selectedCollectionId === "all" ? null : selectedCollectionId,
          reference_type: importReferenceType,
        }),
      });
      setImportContent("");
      setImportTitle("");
      addToast("success", "文本导入成功");
      refreshData();
    } catch (err) {
      addToast("error", `文本导入失败：${parseApiError(err)}`);
    } finally {
      setImportingText(false);
    }
  };

  const importFiles = async (files: FileList | null) => {
    if (!pid || !files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    let fail = 0;
    const failReasons: string[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("project_id", pid);
      fd.append("title", importTitle.trim());
      fd.append("collection_id", selectedCollectionId === "all" ? "" : selectedCollectionId);
      fd.append("reference_type", importReferenceType);
      fd.append("file", file);
      try {
        await api("/api/knowledge/import-file", { method: "POST", body: fd });
        ok += 1;
      } catch (err) {
        fail += 1;
        failReasons.push(parseApiError(err));
      }
    }
    setUploading(false);
    if (ok > 0) addToast("success", `已导入 ${ok} 个文件`);
    if (fail > 0) {
      const uniqueReasons = Array.from(new Set(failReasons.filter(Boolean)));
      const reason = uniqueReasons[0] || "未知错误";
      if (fail === 1) {
        addToast("error", `1 个文件导入失败：${reason}`);
      } else {
        addToast("error", `${fail} 个文件导入失败：${reason}${uniqueReasons.length > 1 ? `（另有 ${uniqueReasons.length - 1} 种错误）` : ""}`);
      }
    }
    refreshData();
  };

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, color: "#27456d" }}>个人知识库</h1>
          <p style={{ margin: "2px 0 0", color: "var(--text-secondary)", fontSize: 12 }}>1. 选择资料夹 2. 导入文件 3. 生成规则包</p>
        </div>
        <div>
          <button onClick={refreshData} style={btnStyle} disabled={loading}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 10, minHeight: 0 }}>
        <aside style={{ ...panelStyle, minHeight: 730 }}>
          <button
            style={{ ...btnStyle, justifyContent: "flex-start", background: "var(--accent-gold-dim)", color: "var(--accent-gold)", fontWeight: 700 }}
            onClick={() => navigate("/knowledge-assets")}
          >
            个人知识库
          </button>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-rules")}>
            规则包中心
          </button>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-templates")}>
            全局模板库
          </button>

          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            资料集=文件夹。右键文件夹可重命名/删除，右键文件可改参考类型。
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>我创建的</div>
            <button onClick={createCollection} style={btnStyle}>
              <FolderPlus size={13} />
            </button>
          </div>
          <button
            onClick={() => setSelectedCollectionId("all")}
            style={{
              ...btnStyle,
              justifyContent: "flex-start",
              background: selectedCollectionId === "all" ? "var(--accent-gold-dim)" : "var(--bg-card)",
              color: selectedCollectionId === "all" ? "var(--accent-gold)" : "var(--text-primary)",
            }}
          >
            <Folder size={14} /> 个人知识库
          </button>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
            {collections.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedCollectionId(item.id)}
                onContextMenu={(e) => openMenu(e, "collection", item.id)}
                style={{
                  ...btnStyle,
                  justifyContent: "space-between",
                  background: selectedCollectionId === item.id ? "var(--accent-gold-dim)" : "var(--bg-card)",
                  color: selectedCollectionId === item.id ? "var(--accent-gold)" : "var(--text-primary)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <Folder size={14} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {sources.filter((x) => x.collection_id === item.id).length}
                </span>
              </button>
            ))}
            {collections.length === 0 && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>暂无资料夹</div>}
          </div>
        </aside>

        <section style={{ ...panelStyle, minHeight: 730, gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 150px 86px 86px", gap: 8 }}>
            <div style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--text-secondary)" }} />
              <input
                style={{ ...inputStyle, paddingLeft: 30 }}
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                placeholder="搜索文件..."
              />
            </div>
            <select style={inputStyle} value={filterType} onChange={(e) => setFilterType(e.target.value as "all" | ReferenceType)}>
              <option value="all">全部类型</option>
              {referenceOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button onClick={() => setViewMode("card")} style={{ ...btnStyle, background: viewMode === "card" ? "var(--accent-gold-dim)" : "var(--bg-card)" }}>
              <LayoutGrid size={13} /> 卡片
            </button>
            <button onClick={() => setViewMode("list")} style={{ ...btnStyle, background: viewMode === "list" ? "var(--accent-gold-dim)" : "var(--bg-card)" }}>
              <List size={13} /> 列表
            </button>
          </div>

          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            当前范围：{selectedCollectionId === "all" ? "个人知识库" : collectionNameMap.get(selectedCollectionId) || "资料夹"} · 共 {filteredSources.length} 条资产
          </div>

          <div
            style={{
              border: "1px dashed var(--bg-border)",
              borderRadius: 10,
              background: "rgba(255,255,255,0.38)",
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 560,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>导入资产</div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ ...btnStyle, cursor: uploading ? "not-allowed" : "pointer" }}>
                  <FileUp size={13} /> {uploading ? "上传中..." : "选择文件"}
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.markdown,.json,.csv,.docx,.pdf"
                    style={{ display: "none" }}
                    disabled={uploading}
                    onChange={(e) => {
                      importFiles(e.target.files);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
                <button onClick={() => setShowAdvancedImport((v) => !v)} style={btnStyle}>
                  {showAdvancedImport ? "收起高级导入" : "高级导入"}
                </button>
              </div>
              {showAdvancedImport && (
                <>
                  <select style={{ ...inputStyle, width: 180 }} value={importReferenceType} onChange={(e) => setImportReferenceType(e.target.value as ReferenceType)}>
                    {referenceOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input style={inputStyle} value={importTitle} onChange={(e) => setImportTitle(e.target.value)} placeholder="文件标题" />
                  <textarea style={textAreaStyle} value={importContent} onChange={(e) => setImportContent(e.target.value)} placeholder="可选：不上传文件时，在这里粘贴文本" />
                  <button onClick={importText} style={btnStyle} disabled={importingText}>
                    <FileText size={13} /> {importingText ? "导入中..." : "导入并索引"}
                  </button>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    导入位置：{selectedCollectionId === "all" ? "个人知识库（根）" : collectionNameMap.get(selectedCollectionId) || "未分组"}
                  </div>
                </>
              )}
            </div>

            <div style={{ borderTop: "1px dashed var(--bg-border)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 220 }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                文件资产区（支持右键文件重命名 / 改参考类型 / 删除）
              </div>

              {filteredSources.length === 0 ? (
                <div
                  style={{
                    flex: 1,
                    border: "1px dashed var(--bg-border)",
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                  }}
                >
                  当前没有匹配资产，导入后会显示在这里。
                </div>
              ) : (
                <div
                  style={
                    viewMode === "card"
                      ? {
                        display: "flex",
                        gap: 12,
                        alignItems: "flex-start",
                        overflowX: "auto",
                        overflowY: "hidden",
                        flex: 1,
                        padding: "2px 2px 8px",
                      }
                      : {
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        overflowY: "auto",
                        flex: 1,
                        paddingRight: 2,
                      }
                  }
                >
                  {filteredSources.map((s) => {
                    const selected = selectedSourceId === s.id;
                    const refLabel = referenceOptions.find((x) => x.value === s.reference_type)?.label || "通用参考";
                    if (viewMode === "card") {
                      const typeTag = toTypeTag(s);
                      return (
                        <button
                          key={s.id}
                          onClick={() => setSelectedSourceId(s.id)}
                          onContextMenu={(e) => openMenu(e, "source", s.id)}
                          draggable
                          onDragStart={(e) => handleSourceDragStart(e, s)}
                          style={{
                            width: 162,
                            minWidth: 162,
                            height: 152,
                            border: selected ? "1px solid rgba(126, 156, 196, 0.86)" : "1px solid rgba(190, 204, 224, 0.78)",
                            borderRadius: 10,
                            padding: "7px 8px 7px",
                            background: "rgba(255,255,255,0.98)",
                            boxShadow: selected ? "0 3px 8px rgba(97, 131, 176, 0.18)" : "0 1px 5px rgba(102, 128, 158, 0.10)",
                            color: "#243B59",
                            textAlign: "left",
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            cursor: "grab",
                          }}
                        >
                          <div
                            style={{
                              height: 66,
                              border: "1px solid rgba(204, 217, 233, 0.84)",
                              borderRadius: 6,
                              background: "linear-gradient(180deg, #FFFFFF 0%, #F7FAFE 100%)",
                              padding: "5px 6px",
                              color: "#6C829F",
                              fontSize: 8.8,
                              lineHeight: 1.22,
                              whiteSpace: "pre-wrap",
                              overflow: "hidden",
                            }}
                          >
                            {toPreviewText(s)}
                          </div>
                          <span
                            style={{
                              fontSize: 11.5,
                              fontWeight: 700,
                              lineHeight: 1.3,
                              display: "-webkit-box",
                              WebkitBoxOrient: "vertical",
                              WebkitLineClamp: 2,
                              overflow: "hidden",
                              minHeight: 28,
                            }}
                          >
                            {s.title}
                          </span>
                          <div style={{ fontSize: 9.8, color: "#7A90AB", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{refLabel}</div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9.6, color: "#899BB3" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                              <FileText size={11} />
                              {typeTag}
                            </span>
                            <span>{toPageTag(s)}</span>
                          </div>
                        </button>
                      );
                    }
                    return (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSourceId(s.id)}
                        onContextMenu={(e) => openMenu(e, "source", s.id)}
                        draggable
                        onDragStart={(e) => handleSourceDragStart(e, s)}
                        style={{
                          border: selected ? "1px solid rgba(102, 196, 255, 0.72)" : "1px solid var(--bg-border)",
                          borderRadius: 10,
                          padding: "10px 12px",
                          background: selected ? "rgba(114, 198, 255, 0.15)" : "rgba(255,255,255,0.82)",
                          boxShadow: selected ? "0 4px 12px rgba(98, 176, 237, 0.2)" : "0 2px 8px rgba(80, 115, 165, 0.09)",
                          color: "var(--text-primary)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                          textAlign: "left",
                          cursor: "grab",
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <FileText size={14} />
                          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>{refLabel}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {menu && (
        <div
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            zIndex: 1000,
            width: 180,
            border: "1px solid var(--bg-border)",
            borderRadius: 10,
            background: "var(--bg-popup)",
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "collection" ? (
            <>
              <button onClick={() => { renameCollection(menu.id); setMenu(null); }} style={btnStyle}>重命名资料夹</button>
              <button onClick={() => { navigate(`/knowledge-rules?collection_id=${menu.id}`); setMenu(null); }} style={btnStyle}>用该资料夹提炼规则包</button>
              <button onClick={() => { deleteCollection(menu.id); setMenu(null); }} style={btnStyle}>删除资料夹</button>
            </>
          ) : (
            <>
              <button onClick={() => { renameSource(menu.id); setMenu(null); }} style={btnStyle}>重命名文件</button>
              {referenceOptions.map((opt) => (
                <button key={opt.value} onClick={() => { quickSetReferenceType(menu.id, opt.value); setMenu(null); }} style={btnStyle}>
                  标记为：{opt.label}
                </button>
              ))}
              <button onClick={() => { deleteSource(menu.id); setMenu(null); }} style={btnStyle}>删除文件</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
