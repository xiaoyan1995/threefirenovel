import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, BookOpen, Clock, Trash2, Loader2, ChevronDown, X, Upload } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";

interface ProjectItem {
  id: string;
  name: string;
  genre: string;
  status: string;
  total_words: number;
  chapter_count: number;
  updated_at: string;
}

interface CreateProjectForm {
  name: string;
  genre: string;
  description: string;
  wordTarget: string;
}

const DEFAULT_CREATE_FORM: CreateProjectForm = {
  name: "",
  genre: "",
  description: "",
  wordTarget: "100000",
};

export default function Projects() {
  const navigate = useNavigate();
  const { currentProject, setCurrentProject, api } = useProject();
  const { addToast } = useToast();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string>("");

  // Create Project Modal State
  const [isCreating, setIsCreating] = useState(false);
  const [createForm, setCreateForm] = useState<CreateProjectForm>({ ...DEFAULT_CREATE_FORM });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImportingModal, setIsImportingModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importProjectName, setImportProjectName] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const loadProjects = () => {
    setLoading(true);
    api<ProjectItem[]>("/api/projects/")
      .then(setProjects)
      .catch(() => { })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProjects();
  }, [api]);

  useEffect(() => {
    if (!isCreating && !isImportingModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isCreating && !isSaving) {
        setIsCreating(false);
      }
      if (isImportingModal && !isImporting) {
        setIsImportingModal(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCreating, isImportingModal, isSaving, isImporting]);

  const closeCreateModal = () => {
    if (isSaving) return;
    setIsCreating(false);
  };

  const closeImportModal = () => {
    if (isImporting) return;
    setIsImportingModal(false);
  };

  const openProject = async (p: ProjectItem) => {
    try {
      const full = await api<any>(`/api/projects/${p.id}`);
      setCurrentProject(full);
    } catch {
      setCurrentProject({
        id: p.id, name: p.name, genre: p.genre, description: "", status: p.status,
        model_main: "claude-sonnet-4", model_secondary: "gpt-4o", temperature: 0.7, word_target: 100000
      });
    }
    navigate("/workshop");
  };

  const handleCreateSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const name = createForm.name.trim();
    if (!name) {
      addToast("warning", "请输入项目名称");
      return;
    }

    const genre = createForm.genre.trim();
    const description = createForm.description.trim();

    let wordTarget = 100000;
    const rawWordTarget = createForm.wordTarget.trim();
    if (rawWordTarget) {
      const parsed = Number(rawWordTarget);
      if (!Number.isFinite(parsed)) {
        addToast("warning", "目标字数必须是数字");
        return;
      }
      wordTarget = Math.round(parsed);
      if (wordTarget < 10000 || wordTarget > 500000) {
        addToast("warning", "目标字数需在 10000 到 500000 之间");
        return;
      }
    }

    setIsSaving(true);
    try {
      const p = await api<any>("/api/projects/", {
        method: "POST",
        body: JSON.stringify({
          name,
          genre,
          description,
          word_target: wordTarget,
        }),
      });
      setCurrentProject(p);
      addToast("success", "项目创建成功");
      navigate("/settings");
    } catch {
      addToast("error", "连接后端失败，以离线模式继续");
      // 后端未启动时 fallback
      navigate("/settings");
    } finally {
      setIsSaving(false);
      setIsCreating(false);
    }
  };

  const handleDeleteProject = async (e: MouseEvent<HTMLButtonElement>, p: ProjectItem) => {
    e.stopPropagation();
    if (deletingId) return;
    if (!window.confirm(`确定删除项目「${p.name}」吗？此操作不可恢复。`)) return;
    setDeletingId(p.id);
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      localStorage.removeItem(`project-autofill-extra-${p.id}`);
      setProjects((prev) => prev.filter((item) => item.id !== p.id));
      if (currentProject?.id === p.id) setCurrentProject(null);
      addToast("success", "项目已删除");
    } catch {
      addToast("error", "删除项目失败");
    } finally {
      setDeletingId("");
    }
  };

  const handleImportProject = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!importFile || isImporting) {
      addToast("warning", "请先选择导入文件");
      return;
    }
    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      if (importProjectName.trim()) {
        formData.append("project_name", importProjectName.trim());
      }
      const imported = await api<{ project_id: string; message?: string }>("/api/projects/import", {
        method: "POST",
        body: formData,
      });
      const newPid = String(imported.project_id || "").trim();
      if (!newPid) {
        throw new Error("导入成功但未返回项目ID");
      }
      const latest = await api<any>(`/api/projects/${newPid}`);
      setCurrentProject(latest);
      setImportFile(null);
      setImportProjectName("");
      setIsImportingModal(false);
      loadProjects();
      addToast("success", imported.message || "导入完成，可直接续写");
      navigate("/workshop");
    } catch (e) {
      const message = e instanceof Error ? e.message : "导入失败";
      addToast("error", message);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="projects-screen">
      <div className="projects-header">
        <div className="projects-header__copy">
          <h1 className="projects-title">我的项目</h1>
          <p className="projects-subtitle">选择一个项目开始创作，或创建新项目</p>
        </div>
        <div className="projects-header__actions">
          <button
            className="projects-import-btn"
            onClick={() => {
              setImportFile(null);
              setImportProjectName("");
              setIsImportingModal(true);
            }}
          >
            <Upload size={16} /> 导入旧书
          </button>
          <button
            className="projects-create-btn"
            onClick={() => {
              setCreateForm({ ...DEFAULT_CREATE_FORM });
              setAdvancedOpen(false);
              setIsCreating(true);
            }}
          >
            <Plus size={16} /> 新建项目
          </button>
        </div>
      </div>

      {loading ? (
        <div className="projects-empty">加载中…</div>
      ) : projects.length === 0 ? (
        <div className="projects-empty">
          <p className="projects-empty__title">还没有项目</p>
          <p className="projects-empty__desc">点击右上角「新建项目」或「导入旧书」开始创作</p>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((p) => {
            return (
              <div
                key={p.id}
                onClick={() => openProject(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openProject(p);
                  }
                }}
                className="project-card"
                role="button"
                tabIndex={0}
              >
                <div className="project-card__row">
                  <div className="project-card__name">{p.name}</div>
                  <div className="project-card__actions">
                    <button
                      className="project-card__delete-btn"
                      onClick={(e) => void handleDeleteProject(e, p)}
                      disabled={deletingId === p.id}
                      title="删除项目"
                    >
                      {deletingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </div>
                </div>
                {p.genre && <span className="project-card__genre">{p.genre}</span>}
                <div className="project-card__meta">
                  <span className="project-card__meta-item">
                    <BookOpen size={12} /> {p.chapter_count} 章
                  </span>
                  <span>{(p.total_words / 10000).toFixed(1)} 万字</span>
                  <span className="project-card__meta-item project-card__meta-item--right">
                    <Clock size={12} /> {p.updated_at?.slice(0, 10)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isImportingModal && (
        <div className="projects-modal-overlay" onClick={closeImportModal}>
          <div
            className="projects-modal projects-modal--compact solid-popup"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-project-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="projects-modal__header">
              <h2 id="import-project-title" className="projects-modal__title">导入旧书 / 项目包</h2>
              <button
                type="button"
                className="projects-modal__close"
                onClick={closeImportModal}
                aria-label="关闭导入弹窗"
              >
                <X size={18} />
              </button>
            </div>

            <form className="projects-modal__form" onSubmit={(e) => void handleImportProject(e)}>
              <div className="projects-form-field">
                <label>
                  选择文件 <span style={{ color: "var(--accent-gold)" }}>*</span>
                </label>
                <input
                  type="file"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  accept=".txt,.md,.json"
                />
                <p className="projects-form-help">支持 .txt / .md / .json</p>
              </div>

              <div className="projects-form-field">
                <label>导入后项目名（可选）</label>
                <input
                  value={importProjectName}
                  onChange={(e) => setImportProjectName(e.target.value)}
                  placeholder="不填则使用默认项目名"
                />
              </div>

              <div className="projects-modal__actions">
                <button type="button" className="projects-modal__cancel" onClick={closeImportModal}>
                  取消
                </button>
                <button type="submit" className="projects-modal__submit" disabled={isImporting || !importFile}>
                  {isImporting ? <Loader2 size={14} className="animate-spin" /> : null}
                  {isImporting ? "导入中..." : "开始导入"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isCreating && (
        <div className="projects-modal-overlay" onClick={closeCreateModal}>
          <div
            className="projects-modal solid-popup"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="projects-modal__header">
              <h2 id="create-project-title" className="projects-modal__title">新建项目</h2>
              <button
                type="button"
                className="projects-modal__close"
                onClick={closeCreateModal}
                aria-label="关闭新建项目弹窗"
              >
                <X size={18} />
              </button>
            </div>

            <form className="projects-modal__form" onSubmit={(e) => void handleCreateSubmit(e)}>
              <div className="projects-form-field">
                <label>
                  项目名称 <span style={{ color: "var(--accent-gold)" }}>*</span>
                </label>
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：剑与魔法的冒险录"
                  autoFocus
                />
              </div>

              <div className="projects-form-field">
                <label>作品类型</label>
                <input
                  value={createForm.genre}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, genre: e.target.value }))}
                  placeholder="例如：玄幻、科幻、悬疑..."
                />
              </div>

              <section className="projects-advanced">
                <button
                  type="button"
                  className="projects-advanced__toggle"
                  onClick={() => setAdvancedOpen((prev) => !prev)}
                  aria-expanded={advancedOpen}
                >
                  <span>高级项（可选）</span>
                  <ChevronDown size={16} className={`projects-advanced__icon ${advancedOpen ? "is-open" : ""}`} />
                </button>

                {advancedOpen && (
                  <div className="projects-advanced__content">
                    <div className="projects-form-field">
                      <label>项目简介</label>
                      <textarea
                        value={createForm.description}
                        onChange={(e) => setCreateForm((prev) => ({ ...prev, description: e.target.value }))}
                        placeholder="一句话概括故事核心冲突、主角目标和整体调性..."
                      />
                    </div>
                    <div className="projects-form-field">
                      <label>目标字数</label>
                      <input
                        type="number"
                        min={10000}
                        max={500000}
                        step={1000}
                        value={createForm.wordTarget}
                        onChange={(e) => setCreateForm((prev) => ({ ...prev, wordTarget: e.target.value }))}
                        placeholder="100000"
                      />
                      <p className="projects-form-help">范围 10000-500000，默认 100000。</p>
                    </div>
                  </div>
                )}
              </section>

              <div className="projects-modal__actions">
                <button type="button" className="projects-modal__cancel" onClick={closeCreateModal}>
                  取消
                </button>
                <button type="submit" className="projects-modal__submit" disabled={isSaving}>
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {isSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
