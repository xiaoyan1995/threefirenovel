import { useEffect, useState } from "react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { AgentConfig, defaultAgentConfigs } from "../components/settings/AgentConfigSection";
import { inputStyle } from "../components/settings/types";

type PipelinePromptKey = "brainstorm" | "autofill" | "bible_generate" | "bootstrap";

type AgentConfigRow = {
  agent_type: string;
  model?: string;
  temperature?: number | null;
  system_prompt?: string;
  max_tokens?: number;
  enabled?: boolean | number;
};

const PIPELINE_PROMPT_ITEMS: Array<{ key: PipelinePromptKey; agentType: string; label: string; description: string }> = [
  { key: "brainstorm", agentType: "pipeline_brainstorm", label: "立项对话提示词", description: "用于立项对话问答阶段" },
  { key: "autofill", agentType: "pipeline_autofill", label: "自动填充提示词", description: "用于项目参数建议生成阶段" },
  { key: "bible_generate", agentType: "pipeline_bible_generate", label: "圣经生成提示词", description: "用于小说圣经生成阶段" },
  { key: "bootstrap", agentType: "pipeline_bootstrap", label: "一键初始化提示词", description: "用于结构化初始化阶段" },
];

const createDefaultPipelinePrompts = (): Record<PipelinePromptKey, string> => ({
  brainstorm: "",
  autofill: "",
  bible_generate: "",
  bootstrap: "",
});

export default function PromptSettings() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [agents, setAgents] = useState<AgentConfig[]>(defaultAgentConfigs);
  const [showAgentBuiltin, setShowAgentBuiltin] = useState<Record<string, boolean>>({});
  const [defaultPrompts, setDefaultPrompts] = useState<Record<string, string>>({});
  const [pipelinePrompts, setPipelinePrompts] = useState<Record<PipelinePromptKey, string>>(createDefaultPipelinePrompts());
  const [showPipelineBuiltin, setShowPipelineBuiltin] = useState<Partial<Record<PipelinePromptKey, boolean>>>({});
  const [configRowsByType, setConfigRowsByType] = useState<Record<string, AgentConfigRow>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const resolveEffectivePrompt = (agentType: string, customPrompt: string) => {
    const custom = String(customPrompt || "").trim();
    if (custom) return custom;
    return String(defaultPrompts[agentType] || "").trim();
  };

  useEffect(() => {
    api<Record<string, string>>("/api/settings/agent-default-prompts")
      .then((data) => setDefaultPrompts(data || {}))
      .catch(() => setDefaultPrompts({}));
  }, [api]);

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    setAgents(defaultAgentConfigs);
    setPipelinePrompts(createDefaultPipelinePrompts());
    setConfigRowsByType({});
    api<AgentConfigRow[]>(`/api/settings/agent-configs?project_id=${pid}`)
      .then((rows) => {
        const rowMap: Record<string, AgentConfigRow> = {};
        for (const row of rows || []) {
          rowMap[row.agent_type] = row;
        }
        setConfigRowsByType(rowMap);

        setAgents((prev) =>
          prev.map((agent) => {
            const row = rowMap[agent.agentType];
            if (!row) return agent;
            return {
              ...agent,
              systemPrompt: String(row.system_prompt || ""),
            };
          }),
        );

        const nextPipeline = createDefaultPipelinePrompts();
        for (const item of PIPELINE_PROMPT_ITEMS) {
          nextPipeline[item.key] = String(rowMap[item.agentType]?.system_prompt || "");
        }
        setPipelinePrompts(nextPipeline);
      })
      .catch(() => {
        setAgents(defaultAgentConfigs);
        setPipelinePrompts(createDefaultPipelinePrompts());
        setConfigRowsByType({});
      })
      .finally(() => setLoading(false));
  }, [pid, api]);

  const updateAgentPrompt = (agentType: string, prompt: string) =>
    setAgents((prev) => prev.map((a) => (a.agentType === agentType ? { ...a, systemPrompt: prompt } : a)));

  const savePromptSettings = async () => {
    if (!pid || saving) return;
    setSaving(true);
    try {
      for (const agent of agents) {
        const row = configRowsByType[agent.agentType];
        await api("/api/settings/agent-configs", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            agent_type: agent.agentType,
            model: row?.model || "",
            temperature: row?.temperature == null ? null : Number(row.temperature),
            system_prompt: agent.systemPrompt || "",
            max_tokens: row?.max_tokens == null ? -1 : Number(row.max_tokens),
            enabled: row?.enabled == null ? true : !!row.enabled,
          }),
        });
      }

      for (const item of PIPELINE_PROMPT_ITEMS) {
        const row = configRowsByType[item.agentType];
        await api("/api/settings/agent-configs", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            agent_type: item.agentType,
            model: row?.model || "",
            temperature: row?.temperature == null ? null : Number(row.temperature),
            system_prompt: pipelinePrompts[item.key] || "",
            max_tokens: row?.max_tokens == null ? -1 : Number(row.max_tokens),
            enabled: row?.enabled == null ? true : !!row.enabled,
          }),
        });
      }

      addToast("success", "提示词设置已保存");
    } catch {
      addToast("error", "提示词设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const effectiveBiblePrompt = resolveEffectivePrompt("pipeline_bible_generate", pipelinePrompts.bible_generate);
  const effectiveCharacterPrompt = resolveEffectivePrompt(
    "character_designer",
    agents.find((a) => a.agentType === "character_designer")?.systemPrompt || "",
  );
  const effectiveOutlinePrompt = resolveEffectivePrompt(
    "outline_writer",
    agents.find((a) => a.agentType === "outline_writer")?.systemPrompt || "",
  );
  const fusionPreview41 = [
    "【4.1 主干（来自圣经生成提示词）】",
    effectiveBiblePrompt || "（未配置）",
    "",
    "【4.1 增强（来自角色设计 Agent 提示词）】",
    effectiveCharacterPrompt || "（未配置）",
    "",
    "【融合说明】",
    "4.1 只用于角色设计：角色档案、关系网络、角色弧线、使用建议。",
    "角色档案字段应覆盖：name/category/gender/age/identity/appearance/personality/motivation/backstory/arc/usage_notes/relations。",
  ].join("\n");
  const fusionPreview43 = [
    "【4.3 主干（来自圣经生成提示词）】",
    effectiveBiblePrompt || "（未配置）",
    "",
    "【4.3 增强（来自大纲策划 Agent 提示词）】",
    effectiveOutlinePrompt || "（未配置）",
    "",
    "【融合说明】",
    "4.3 只用于大纲设计：阶段目标、冲突升级、关键转折、回收锚点。",
  ].join("\n");

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>提示词设置</h1>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            此页面只管理系统提示词。模型与温度请在“项目设置”中配置。
          </p>
        </div>
        <button
          onClick={savePromptSettings}
          disabled={saving || loading}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent-gold)",
            color: "#000",
            fontSize: 13,
            fontWeight: 600,
            cursor: saving || loading ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {saving ? "保存中..." : "保存提示词"}
        </button>
      </div>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>立项工作台提示词</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          留空则使用内置默认提示词。内置提示词默认隐藏，点击按钮可展开查看。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 10 }}>
          {PIPELINE_PROMPT_ITEMS.map((item) => {
            const showBuiltin = !!showPipelineBuiltin[item.key];
            const builtinPrompt = (defaultPrompts[item.agentType] || "").trim();
            return (
              <div key={item.key} style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{item.description}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setShowPipelineBuiltin((prev) => ({ ...prev, [item.key]: !prev[item.key] }))}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-card)",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {showBuiltin ? "隐藏内置提示词" : "查看内置提示词"}
                  </button>
                </div>

                <textarea
                  value={pipelinePrompts[item.key]}
                  onChange={(e) =>
                    setPipelinePrompts((prev) => ({
                      ...prev,
                      [item.key]: e.target.value,
                    }))
                  }
                  placeholder="留空则使用内置提示词..."
                  style={{ ...inputStyle, height: 120, maxHeight: 300, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}
                />

                {showBuiltin && (
                  <textarea
                    readOnly
                    value={builtinPrompt || "该流程暂无可展示的内置提示词。"}
                    style={{ ...inputStyle, height: 120, maxHeight: 300, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>4.x 融合生效预览</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          只读预览：用于确认最终执行文本。4.1=角色设计；4.3=大纲设计。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 10 }}>
          <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>4.1 角色融合预览</div>
            <textarea
              readOnly
              value={fusionPreview41}
              style={{ ...inputStyle, height: 220, maxHeight: 420, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}
            />
          </div>
          <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>4.3 大纲融合预览</div>
            <textarea
              readOnly
              value={fusionPreview43}
              style={{ ...inputStyle, height: 220, maxHeight: 420, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}
            />
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Agent 提示词</h3>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          默认隐藏内置提示词，按需展开查看。自定义提示词留空表示回退到内置提示词。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 10 }}>
          {agents.map((agent) => {
            const showBuiltin = !!showAgentBuiltin[agent.agentType];
            const builtinPrompt = (defaultPrompts[agent.agentType] || "").trim();
            return (
              <div key={agent.agentType} style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{agent.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{agent.description}</div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() =>
                      setShowAgentBuiltin((prev) => ({
                        ...prev,
                        [agent.agentType]: !prev[agent.agentType],
                      }))
                    }
                    style={{
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-card)",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {showBuiltin ? "隐藏内置提示词" : "查看内置提示词"}
                  </button>
                </div>

                <textarea
                  value={agent.systemPrompt}
                  onChange={(e) => updateAgentPrompt(agent.agentType, e.target.value)}
                  placeholder="留空则使用内置提示词..."
                  style={{ ...inputStyle, height: 120, maxHeight: 300, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}
                />

                {showBuiltin && (
                  <textarea
                    readOnly
                    value={builtinPrompt || "该 Agent 暂无可展示的内置提示词。"}
                    style={{ ...inputStyle, height: 120, maxHeight: 300, overflowY: "auto", padding: "10px 12px", resize: "vertical", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
