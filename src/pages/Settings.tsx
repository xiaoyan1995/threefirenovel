import { useEffect, useState } from "react";
import { Sparkles, WandSparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { inputStyle, labelStyle, ModelConfig, ProviderConfig } from "../components/settings/types";
import { ModelSelect } from "../components/settings/ModelSelect";
import { AgentConfig, defaultAgentConfigs, AgentConfigSection } from "../components/settings/AgentConfigSection";

type AutofillExtra = {
  structure?: string;
  customStructure?: string;
  chapterWords?: number;
  priority?: string;
};

type PipelineActionKey = "brainstorm" | "autofill" | "bible" | "bootstrap";

type PipelineActionConfig = {
  model: string;
  temperature: number;
  maxTokens: number;
};

const PIPELINE_ACTIONS: Array<{ key: PipelineActionKey; agentType: string; label: string; description: string; tempHint: string }> = [
  { key: "brainstorm", agentType: "pipeline_brainstorm", label: "立项对话", description: "左侧对话问答", tempHint: "0.6~0.8" },
  { key: "autofill", agentType: "pipeline_autofill", label: "自动填充建议", description: "生成项目参数建议", tempHint: "0.2~0.4" },
  { key: "bible", agentType: "pipeline_bible_generate", label: "生成小说圣经", description: "编排动作台生成圣经", tempHint: "0.5~0.7" },
  { key: "bootstrap", agentType: "pipeline_bootstrap", label: "一键初始化", description: "按圣经生成结构化内容", tempHint: "0.3~0.5" },
];

const PIPELINE_STAGE_DEFAULT_MAX_TOKENS: Record<PipelineActionKey, number> = {
  brainstorm: 8000,
  autofill: 1000,
  bible: 8000,
  bootstrap: 7600,
};

const PIPELINE_STAGE_DEFAULT_MAX_TOKEN_LABELS: Record<PipelineActionKey, string> = {
  brainstorm: "8000",
  autofill: "1000",
  bible: "8000",
  bootstrap: "动态（约3400-7600）",
};

const createDefaultPipelineConfigs = (): Record<PipelineActionKey, PipelineActionConfig> => ({
  brainstorm: { model: "", temperature: -1, maxTokens: -1 },
  autofill: { model: "", temperature: -1, maxTokens: -1 },
  bible: { model: "", temperature: -1, maxTokens: -1 },
  bootstrap: { model: "", temperature: -1, maxTokens: -1 },
});

const createDefaultPipelinePrompts = (): Record<PipelineActionKey, string> => ({
  brainstorm: "",
  autofill: "",
  bible: "",
  bootstrap: "",
});

export default function Settings() {
  const navigate = useNavigate();
  const { currentProject, setCurrentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [form, setForm] = useState({
    name: "",
    genre: "",
    wordTarget: 100000,
    description: "",
    structure: "起承转合",
    customStructure: "",
    chapterWords: 5000,
    priority: "品质优先",
    modelMain: "claude-sonnet-4",
    modelSecondary: "gpt-4o",
    temperature: 0.7,
  });
  const [agents, setAgents] = useState(defaultAgentConfigs);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfig[]>([]);
  const [pipelineConfigs, setPipelineConfigs] = useState<Record<PipelineActionKey, PipelineActionConfig>>(createDefaultPipelineConfigs());
  const [pipelinePrompts, setPipelinePrompts] = useState<Record<PipelineActionKey, string>>(createDefaultPipelinePrompts());
  const [loadingPipelineConfigs, setLoadingPipelineConfigs] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<"" | "json" | "txt" | "md">("");

  useEffect(() => {
    api<ModelConfig[]>("/api/settings/model-configs")
      .then((configs) => setModelConfigs(configs))
      .catch(() => { });
    api<ProviderConfig[]>("/api/settings/provider-configs")
      .then((configs) => setProviderConfigs(configs))
      .catch(() => { });
  }, [api]);

  useEffect(() => {
    if (!currentProject) return;
    let next = {
      name: currentProject.name || "",
      genre: currentProject.genre || "",
      wordTarget: currentProject.word_target || 100000,
      description: currentProject.description || "",
      structure: ["起承转合", "三幕式", "英雄之旅", "自定义"].includes(String(currentProject.structure || ""))
        ? String(currentProject.structure)
        : "起承转合",
      customStructure: String(currentProject.custom_structure || ""),
      chapterWords: Number(currentProject.chapter_words || 5000),
      priority: ["品质优先", "速度优先", "均衡"].includes(String(currentProject.priority || ""))
        ? String(currentProject.priority)
        : "品质优先",
      modelMain: currentProject.model_main || "claude-sonnet-4",
      modelSecondary: currentProject.model_secondary || "gpt-4o",
      temperature: currentProject.temperature ?? 0.7,
    };

    try {
      const raw = localStorage.getItem(`project-autofill-extra-${currentProject.id}`);
      if (raw) {
        const extra = JSON.parse(raw) as AutofillExtra;
        if (
          (!currentProject.structure || !String(currentProject.structure).trim()) &&
          extra.structure &&
          ["起承转合", "三幕式", "英雄之旅", "自定义"].includes(extra.structure)
        ) {
          next.structure = extra.structure;
        }
        if ((!currentProject.custom_structure || !String(currentProject.custom_structure).trim()) && extra.customStructure) {
          next.customStructure = String(extra.customStructure);
        }
        if ((!currentProject.chapter_words || Number(currentProject.chapter_words) <= 0) && extra.chapterWords && Number.isFinite(extra.chapterWords)) {
          next.chapterWords = Math.max(1500, Math.min(12000, Math.floor(extra.chapterWords)));
        }
        if ((!currentProject.priority || !String(currentProject.priority).trim()) && extra.priority && ["品质优先", "速度优先", "均衡"].includes(extra.priority)) {
          next.priority = extra.priority;
        }
      }
    } catch {
      // ignore malformed local cache
    }

    setForm(next);
  }, [currentProject]);

  useEffect(() => {
    if (!pid) return;
    setAgents(defaultAgentConfigs);
    setPipelineConfigs(createDefaultPipelineConfigs());
    setPipelinePrompts(createDefaultPipelinePrompts());
    setLoadingPipelineConfigs(true);
    api<any[]>(`/api/settings/agent-configs?project_id=${pid}`)
      .then((list) => {
        setAgents((prev) =>
          prev.map((a) => {
            const remote = list.find((r) => r.agent_type === a.agentType);
            if (!remote) return a;
            return {
              ...a,
              model: remote.model || "",
              temperature: remote.temperature ?? -1,
              maxTokens: remote.max_tokens == null ? -1 : normalizeMaxTokens(remote.max_tokens),
              systemPrompt: remote.system_prompt || "",
              enabled: !!remote.enabled,
            };
          }),
        );
        const nextPipeline = createDefaultPipelineConfigs();
        const nextPipelinePrompts = createDefaultPipelinePrompts();
        for (const action of PIPELINE_ACTIONS) {
          const remote = list.find((r) => r.agent_type === action.agentType);
          if (!remote) continue;
          nextPipeline[action.key] = {
            model: String(remote.model || "").trim(),
            temperature: remote.temperature == null ? -1 : normalizeTemp(remote.temperature),
            maxTokens: remote.max_tokens == null ? -1 : normalizeMaxTokens(remote.max_tokens),
          };
          nextPipelinePrompts[action.key] = String(remote.system_prompt || "");
        }
        setPipelineConfigs(nextPipeline);
        setPipelinePrompts(nextPipelinePrompts);
      })
      .catch(() => {
        setPipelineConfigs(createDefaultPipelineConfigs());
        setPipelinePrompts(createDefaultPipelinePrompts());
      })
      .finally(() => setLoadingPipelineConfigs(false));
  }, [pid, api]);

  const update = (key: string, value: string | number) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const updateAgent = (agentType: string, field: keyof AgentConfig, value: string | number | boolean) =>
    setAgents((prev) => prev.map((a) => (a.agentType === agentType ? { ...a, [field]: value } : a)));

  const normalizeTemp = (value: unknown) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return -1;
    return Math.max(-1, Math.min(1, num));
  };

  const normalizeMaxTokens = (value: unknown) => {
    const raw = String(value ?? "").trim();
    if (raw === "") return -1;
    const num = Number(value);
    if (!Number.isFinite(num)) return -1;
    if (num < 0) return -1;
    return Math.floor(num);
  };

  const saveAll = async () => {
    if (!pid) return;
    setSaving(true);
    const failedItems: string[] = [];
    try {
      const p = await api<any>(`/api/projects/${pid}`, {
        method: "PUT",
        body: JSON.stringify({
          name: form.name,
          genre: form.genre,
          description: form.description,
          structure: form.structure,
          custom_structure: form.structure === "自定义" ? form.customStructure : "",
          chapter_words: form.chapterWords,
          priority: form.priority,
          word_target: form.wordTarget,
          model_main: form.modelMain,
          model_secondary: form.modelSecondary,
          temperature: form.temperature,
        }),
      });
      setCurrentProject(p);
      try {
        const verified = await api<any>(`/api/projects/${pid}`);
        setCurrentProject(verified);
        if (
          String(verified?.model_main || "").trim() !== String(form.modelMain || "").trim() ||
          String(verified?.model_secondary || "").trim() !== String(form.modelSecondary || "").trim()
        ) {
          failedItems.push("项目主/辅模型");
          addToast("error", "模型保存未生效：数据库回读值与当前选择不一致，请重试。");
        }
      } catch {
        failedItems.push("项目主/辅模型校验");
      }

      for (const a of agents) {
        try {
          await api("/api/settings/agent-configs", {
            method: "POST",
            body: JSON.stringify({
              project_id: pid,
              agent_type: a.agentType,
              model: a.model,
              temperature: a.temperature < 0 ? null : a.temperature,
              max_tokens: a.maxTokens < 0 ? -1 : a.maxTokens,
              system_prompt: a.systemPrompt,
              enabled: a.enabled,
            }),
          });
        } catch {
          failedItems.push(a.label);
        }
      }

      for (const action of PIPELINE_ACTIONS) {
        const cfg = pipelineConfigs[action.key];
        try {
          await api("/api/settings/agent-configs", {
            method: "POST",
            body: JSON.stringify({
              project_id: pid,
              agent_type: action.agentType,
              model: cfg.model || "",
              temperature: cfg.temperature < 0 ? null : Number(cfg.temperature.toFixed(1)),
              system_prompt: pipelinePrompts[action.key] || "",
              max_tokens: cfg.maxTokens < 0 ? -1 : cfg.maxTokens,
              enabled: true,
            }),
          });
        } catch {
          failedItems.push(action.label);
        }
      }

      localStorage.setItem(
        `project-autofill-extra-${pid}`,
        JSON.stringify({
          structure: form.structure,
          customStructure: form.structure === "自定义" ? form.customStructure : "",
          chapterWords: form.chapterWords,
          priority: form.priority,
        } satisfies AutofillExtra),
      );

      if (failedItems.length === 0) {
        addToast("success", "项目设置已保存");
      } else {
        addToast("warning", `基础设置已保存，但以下项保存失败：${failedItems.join("、")}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "保存失败，请检查后端连接";
      addToast("error", message);
    } finally {
      setSaving(false);
    }
  };

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  const handleExportProject = async (format: "json" | "txt" | "md") => {
    if (!pid || exportingFormat) return;
    setExportingFormat(format);
    try {
      const res = await api<{ filename: string; mime_type: string; content: string }>(
        `/api/projects/${pid}/export?format=${format}`,
      );
      const blob = new Blob([String(res.content || "")], {
        type: String(res.mime_type || "text/plain;charset=utf-8"),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = String(res.filename || `project-export.${format}`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      addToast("success", `导出完成：${res.filename}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "导出失败";
      addToast("error", message);
    } finally {
      setExportingFormat("");
    }
  };

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 32, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>项目设置</h1>
        <button
          onClick={saveAll}
          disabled={saving}
          style={{
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            background: "var(--accent-gold)",
            color: "#000",
          }}
        >
          {saving ? "保存中..." : "保存设置"}
        </button>
      </div>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>流程入口</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          立项对话与知识资产已拆为独立主页面。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <button
            onClick={() => navigate("/planning-studio")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--bg-border)",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
            }}
          >
            <Sparkles size={14} /> 进入 AI 立项工作台
          </button>
          <button
            onClick={() => navigate("/prompt-settings")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--bg-border)",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
            }}
          >
            <WandSparkles size={14} /> 进入提示词设置
          </button>
          <button
            onClick={() => navigate("/knowledge-assets")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--bg-border)",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
            }}
          >
            <WandSparkles size={14} /> 进入知识资产库
          </button>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>项目迁移（导出）</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          支持导出当前项目（JSON/TXT/Markdown）。旧书导入入口已移动到「项目列表」页的新建项目按钮旁。
        </p>
        <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>导出当前项目</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleExportProject("json")}
                disabled={!!exportingFormat}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", cursor: exportingFormat ? "not-allowed" : "pointer" }}
              >
                {exportingFormat === "json" ? "导出中..." : "导出 JSON"}
              </button>
              <button
                type="button"
                onClick={() => void handleExportProject("txt")}
                disabled={!!exportingFormat}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", cursor: exportingFormat ? "not-allowed" : "pointer" }}
              >
                {exportingFormat === "txt" ? "导出中..." : "导出 TXT"}
              </button>
              <button
                type="button"
                onClick={() => void handleExportProject("md")}
                disabled={!!exportingFormat}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", cursor: exportingFormat ? "not-allowed" : "pointer" }}
              >
                {exportingFormat === "md" ? "导出中..." : "导出 MD"}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>基本信息</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>项目名称</label>
            <input style={inputStyle} value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="输入项目名称" />
          </div>
          <div>
            <label style={labelStyle}>小说类型</label>
            <input style={inputStyle} value={form.genre} onChange={(e) => update("genre", e.target.value)} placeholder="古代权谋 / 玄幻 / 言情..." />
          </div>
          <div>
            <label style={labelStyle}>目标字数</label>
            <input style={inputStyle} type="number" value={form.wordTarget} onChange={(e) => update("wordTarget", +e.target.value)} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>项目描述</label>
            <textarea
              style={{ ...inputStyle, height: 80, padding: "10px 12px", resize: "none" }}
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="简要描述你的小说构想和核心冲突..."
            />
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>写作参数</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>叙事结构</label>
            <select style={inputStyle} value={form.structure} onChange={(e) => update("structure", e.target.value)}>
              <option value="起承转合">起承转合</option>
              <option value="三幕式">三幕式</option>
              <option value="英雄之旅">英雄之旅</option>
              <option value="自定义">自定义</option>
            </select>
            {form.structure === "自定义" && (
              <textarea
                style={{ ...inputStyle, height: 60, padding: "10px 12px", resize: "vertical", marginTop: 8 }}
                value={form.customStructure}
                onChange={(e) => update("customStructure", e.target.value)}
                placeholder="描述你的叙事结构，如：序章 → 铺垫 → 冲突升级 → 高潮 → 尾声"
              />
            )}
          </div>
          <div>
            <label style={labelStyle}>每章字数</label>
            <input style={inputStyle} type="number" value={form.chapterWords} onChange={(e) => update("chapterWords", +e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>品质优先级</label>
            <select style={inputStyle} value={form.priority} onChange={(e) => update("priority", e.target.value)}>
              <option value="品质优先">品质优先</option>
              <option value="速度优先">速度优先</option>
              <option value="均衡">均衡</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>AI 模型配置</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -8, marginBottom: 12 }}>
          修改后需点击右上角“保存设置”才会生效；写作工坊顶部标签显示的是已保存配置。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>主模型</label>
            <ModelSelect value={form.modelMain} onChange={(v) => update("modelMain", v)} modelConfigs={modelConfigs} providerConfigs={providerConfigs} />
          </div>
          <div>
            <label style={labelStyle}>辅助模型</label>
            <ModelSelect value={form.modelSecondary} onChange={(v) => update("modelSecondary", v)} modelConfigs={modelConfigs} providerConfigs={providerConfigs} />
          </div>
          <div>
            <label style={labelStyle}>创意温度</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => update("temperature", +e.target.value)} style={{ flex: 1 }} />
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 30 }}>{form.temperature}</span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>立项工作台独立模型配置</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          立项对话、自动填充、圣经生成、一键初始化可分别设置模型、温度与输出 token。参数为 -1 时跟随系统默认。和上方“保存设置”一起保存。
        </p>
        {loadingPipelineConfigs ? (
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>加载配置中...</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            {PIPELINE_ACTIONS.map((action) => (
              <div key={action.key} style={{ border: "1px solid var(--bg-border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{action.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{action.description}</div>
                </div>

                <div>
                  <label style={labelStyle}>模型</label>
                  <ModelSelect
                    value={pipelineConfigs[action.key].model}
                    onChange={(value) =>
                      setPipelineConfigs((prev) => ({
                        ...prev,
                        [action.key]: { ...prev[action.key], model: value },
                      }))
                    }
                    allowEmpty
                    emptyLabel="跟随项目默认"
                    modelConfigs={modelConfigs}
                    providerConfigs={providerConfigs}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" }}>
                  <div>
                    <label style={labelStyle}>温度（-1 为默认，建议 {action.tempHint}）</label>
                    <input
                      style={inputStyle}
                      type="number"
                      min={-1}
                      max={1}
                      step={0.1}
                      value={pipelineConfigs[action.key].temperature}
                      onChange={(e) =>
                        setPipelineConfigs((prev) => ({
                          ...prev,
                          [action.key]: { ...prev[action.key], temperature: normalizeTemp(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setPipelineConfigs((prev) => ({
                        ...prev,
                        [action.key]: { ...prev[action.key], temperature: -1 },
                      }))
                    }
                    style={{
                      height: 40,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-card)",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    温度默认
                  </button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "end" }}>
                  <div>
                    <label style={labelStyle}>输出 Token（-1 为默认，当前默认 {PIPELINE_STAGE_DEFAULT_MAX_TOKEN_LABELS[action.key]}）</label>
                    <input
                      style={inputStyle}
                      type="number"
                      min={-1}
                      step={1}
                      value={pipelineConfigs[action.key].maxTokens}
                      onChange={(e) =>
                        setPipelineConfigs((prev) => ({
                          ...prev,
                          [action.key]: { ...prev[action.key], maxTokens: normalizeMaxTokens(e.target.value) },
                        }))
                      }
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setPipelineConfigs((prev) => ({
                        ...prev,
                        [action.key]: { ...prev[action.key], maxTokens: -1 },
                      }))
                    }
                    style={{
                      height: 40,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-card)",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    Token 默认
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPipelineConfigs((prev) => ({
                        ...prev,
                        [action.key]: { ...prev[action.key], maxTokens: PIPELINE_STAGE_DEFAULT_MAX_TOKENS[action.key] },
                      }))
                    }
                    style={{
                      height: 40,
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-card)",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    设为 {PIPELINE_STAGE_DEFAULT_MAX_TOKENS[action.key]}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Agent 独立配置</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          为每个 Agent 单独设置模型、温度与输出 token。提示词请在左侧“提示词设置”中统一维护。
        </p>
        <AgentConfigSection
          agents={agents}
          expandedAgent={expandedAgent}
          setExpandedAgent={setExpandedAgent}
          updateAgent={updateAgent}
          modelConfigs={modelConfigs}
          providerConfigs={providerConfigs}
          mode="model"
        />
      </section>
    </div>
  );
}
