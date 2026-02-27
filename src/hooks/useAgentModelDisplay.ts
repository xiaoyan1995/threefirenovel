import { useEffect, useMemo, useState } from "react";
import { useProject } from "../context/ProjectContext";
import type { ModelConfig } from "../components/settings/types";

type AgentType = "writer_assistant" | "ner_extractor" | "debate_room" | "butterfly_simulator";

interface AgentConfigRow {
  agent_type: string;
  model: string | null;
  enabled: number | null;
}

interface ProjectModelSnapshot {
  model_main?: string | null;
  model_secondary?: string | null;
  updated_at?: string | null;
}

export interface AgentModelInfo {
  modelId: string;
  modelLabel: string;
  secondaryModelId?: string;
  secondaryModelLabel?: string;
  enabled: boolean;
  source: "独立配置" | "项目主模型" | "项目主/副模型" | "默认";
}

type AgentModelMap = Record<AgentType, AgentModelInfo>;

export interface AgentModelDisplayResult {
  models: AgentModelMap;
  loading: boolean;
  resolveLabel: (modelId: string) => string;
}

const DEFAULT_MAIN_MODEL = "claude-sonnet-4";

const defaultInfo = (modelId: string = DEFAULT_MAIN_MODEL): AgentModelInfo => ({
  modelId,
  modelLabel: modelId,
  enabled: true,
  source: "默认",
});

const getModelLabel = (modelId: string, modelLabelMap: Map<string, string>) =>
  modelLabelMap.get(modelId) || modelId;

export function useAgentModelDisplay(): AgentModelDisplayResult {
  const { currentProject, api } = useProject();
  const pid = currentProject?.id;

  const [agentConfigs, setAgentConfigs] = useState<AgentConfigRow[]>([]);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectModelSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const onFocus = () => setRefreshTick((v) => v + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!pid) {
      setAgentConfigs([]);
      setProjectSnapshot(null);
      return;
    }

    setLoading(true);
    Promise.all([
      api<AgentConfigRow[]>(`/api/settings/agent-configs?project_id=${pid}`).catch(() => []),
      api<ModelConfig[]>("/api/settings/model-configs").catch(() => []),
      api<ProjectModelSnapshot>(`/api/projects/${pid}`).catch(() => null),
    ])
      .then(([aCfg, mCfg, projectCfg]) => {
        if (cancelled) return;
        setAgentConfigs(aCfg || []);
        setModelConfigs(mCfg || []);
        setProjectSnapshot(projectCfg || null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pid, api, currentProject?.model_main, currentProject?.model_secondary, refreshTick]);

  const models = useMemo<AgentModelMap>(() => {
    const modelLabelMap = new Map(modelConfigs.map((m) => [m.model_id, m.model_label]));
    const findCfg = (agentType: AgentType) => agentConfigs.find((c) => c.agent_type === agentType);
    const boolEnabled = (raw: number | null | undefined) => (raw == null ? true : !!raw);

    // Prefer backend snapshot as source of truth for model display.
    const projectMain = String(
      (projectSnapshot?.model_main ?? currentProject?.model_main ?? "") || "",
    ).trim();
    const projectSecondary = String(
      (projectSnapshot?.model_secondary ?? currentProject?.model_secondary ?? "") || "",
    ).trim();

    const nerCfg = findCfg("ner_extractor");
    const nerCfgModel = (nerCfg?.model || "").trim();
    const nerModel = nerCfgModel || projectMain || DEFAULT_MAIN_MODEL;
    const ner: AgentModelInfo = {
      modelId: nerModel,
      modelLabel: getModelLabel(nerModel, modelLabelMap),
      enabled: boolEnabled(nerCfg?.enabled),
      source: nerCfgModel ? "独立配置" : projectMain ? "项目主模型" : "默认",
    };

    const debateCfg = findCfg("debate_room");
    const debateCfgModel = (debateCfg?.model || "").trim();
    const debateMain = debateCfgModel || projectMain || DEFAULT_MAIN_MODEL;
    const debateSecondary = debateCfgModel || projectSecondary || debateMain;
    const debate: AgentModelInfo = {
      modelId: debateMain,
      modelLabel: getModelLabel(debateMain, modelLabelMap),
      secondaryModelId: debateSecondary,
      secondaryModelLabel: getModelLabel(debateSecondary, modelLabelMap),
      enabled: boolEnabled(debateCfg?.enabled),
      source: debateCfgModel ? "独立配置" : projectSecondary ? "项目主/副模型" : projectMain ? "项目主模型" : "默认",
    };

    const butterflyCfg = findCfg("butterfly_simulator");
    const butterflyCfgModel = (butterflyCfg?.model || "").trim();
    const butterflyModel = butterflyCfgModel || projectMain || DEFAULT_MAIN_MODEL;
    const butterfly: AgentModelInfo = {
      modelId: butterflyModel,
      modelLabel: getModelLabel(butterflyModel, modelLabelMap),
      enabled: boolEnabled(butterflyCfg?.enabled),
      source: butterflyCfgModel ? "独立配置" : projectMain ? "项目主模型" : "默认",
    };

    const assistantCfg = findCfg("writer_assistant");
    const assistantCfgModel = (assistantCfg?.model || "").trim();
    const assistantModel = assistantCfgModel || projectMain || DEFAULT_MAIN_MODEL;
    const assistant: AgentModelInfo = {
      modelId: assistantModel,
      modelLabel: getModelLabel(assistantModel, modelLabelMap),
      enabled: boolEnabled(assistantCfg?.enabled),
      source: assistantCfgModel ? "独立配置" : projectMain ? "项目主模型" : "默认",
    };

    return {
      writer_assistant: assistant || defaultInfo(),
      ner_extractor: ner || defaultInfo(),
      debate_room: debate || defaultInfo(),
      butterfly_simulator: butterfly || defaultInfo(),
    };
  }, [
    agentConfigs,
    modelConfigs,
    projectSnapshot?.model_main,
    projectSnapshot?.model_secondary,
    currentProject?.model_main,
    currentProject?.model_secondary,
  ]);

  const resolveLabel = (modelId: string) => {
    const id = String(modelId || "").trim();
    if (!id) return "";
    const found = modelConfigs.find((m) => m.model_id === id);
    return found?.model_label || id;
  };

  return { models, loading, resolveLabel };
}
