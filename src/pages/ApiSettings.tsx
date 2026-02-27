import { useEffect, useState } from "react";
import { Plus, Trash2, Eye, EyeOff, ChevronDown, ChevronUp } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { API_BASE } from "../config/api";
import { useToast } from "../components/ui/ToastProvider";
import { LOCAL_API_TOKEN_STORAGE_KEY, withLocalApiAuth } from "../lib/agentAuth";

interface ProviderConfig {
  provider: string;
  label: string;
  color: string;
  apiKey: string;
  hasSavedKey: boolean;
  baseUrl: string;
  status: "connected" | "failed" | "unchecked";
  models: string[];
}

interface CustomRelay {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasSavedKey: boolean;
  testModel: string;
  status: "connected" | "failed" | "unchecked";
}

interface ModelConfig {
  id: string;
  provider: string;
  model_id: string;
  model_label: string;
  visible: number;
  is_custom: number;
  sort_order: number;
}

interface ProviderConfigDB {
  id: string;
  provider: string;
  label: string;
  color: string;
  base_url: string;
  visible: number;
  is_custom: number;
  sort_order: number;
}

interface ApiKeyRow {
  provider: string;
  base_url?: string;
  status?: string;
  has_key?: boolean;
}

interface RelayRow {
  id: string;
  name: string;
  base_url: string;
  test_model?: string;
  has_key?: boolean;
}

interface NewProviderDraft {
  provider: string;
  label: string;
  baseUrl: string;
  color: string;
}

const defaultProviders: ProviderConfig[] = [
  {
    provider: "openai", label: "OpenAI", color: "#10A37F", apiKey: "", hasSavedKey: false, baseUrl: "https://api.openai.com/v1", status: "unchecked",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o1-mini"]
  },
  {
    provider: "anthropic", label: "Anthropic", color: "#D4A574", apiKey: "", hasSavedKey: false, baseUrl: "https://api.anthropic.com", status: "unchecked",
    models: ["claude-opus-4", "claude-sonnet-4", "claude-haiku-3"]
  },
  {
    provider: "google", label: "Google Gemini", color: "#4285F4", apiKey: "", hasSavedKey: false, baseUrl: "", status: "unchecked",
    models: ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite"]
  },
  {
    provider: "deepseek", label: "DeepSeek", color: "#5B6EF5", apiKey: "", hasSavedKey: false, baseUrl: "https://api.deepseek.com", status: "unchecked",
    models: ["deepseek-chat", "deepseek-reasoner"]
  },
  {
    provider: "qwen", label: "通义千问", color: "#6236FF", apiKey: "", hasSavedKey: false, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", status: "unchecked",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"]
  },
  {
    provider: "zhipu", label: "智谱 GLM", color: "#3366FF", apiKey: "", hasSavedKey: false, baseUrl: "https://open.bigmodel.cn/api/paas/v4", status: "unchecked",
    models: ["glm-4-plus", "glm-4-flash", "glm-4-long"]
  },
  {
    provider: "moonshot", label: "月之暗面", color: "#000000", apiKey: "", hasSavedKey: false, baseUrl: "https://api.moonshot.cn/v1", status: "unchecked",
    models: ["moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"]
  },
];

interface GlobalConfig {
  timeout: number;
  maxRetries: number;
  httpProxy: string;
  embeddingModel: string;
  embeddingDim: number;
  localApiAuthEnabled: boolean;
  localApiToken: string;
}

const inputStyle = {
  height: 40, borderRadius: 8, border: "none", padding: "0 12px",
  background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13,
  outline: "none", width: "100%",
} as const;

const labelStyle = { fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, display: "block" } as const;

export default function ApiSettings() {
  const { api } = useProject();
  const { addToast } = useToast();
  const [providers, setProviders] = useState(defaultProviders);
  const [testing, setTesting] = useState<string | null>(null);
  const [showProviderKey, setShowProviderKey] = useState<Record<string, boolean>>({});
  const [showBaseUrl, setShowBaseUrl] = useState<Record<string, boolean>>({});
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [expandedRelays, setExpandedRelays] = useState<Record<string, boolean>>({});
  const [global, setGlobal] = useState<GlobalConfig>({
    timeout: 60, maxRetries: 3, httpProxy: "",
    embeddingModel: "text-embedding-3-small", embeddingDim: 1536,
    localApiAuthEnabled: false, localApiToken: "",
  });
  const [showLocalApiToken, setShowLocalApiToken] = useState(false);
  const [relays, setRelays] = useState<CustomRelay[]>([]);
  const [saving, setSaving] = useState(false);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [providerConfigsDB, setProviderConfigsDB] = useState<ProviderConfigDB[]>([]);
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);
  const [newModelInput, setNewModelInput] = useState({ model_id: "", model_label: "" });
  const [clearProviderKey, setClearProviderKey] = useState<Record<string, boolean>>({});
  const [showAddRelayModal, setShowAddRelayModal] = useState(false);
  const [addingRelay, setAddingRelay] = useState(false);
  const [showNewRelayKey, setShowNewRelayKey] = useState(false);
  const [showAddProviderForm, setShowAddProviderForm] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProviderDraft, setNewProviderDraft] = useState<NewProviderDraft>({
    provider: "",
    label: "",
    baseUrl: "",
    color: "#5B6EF5",
  });
  const [newRelayDraft, setNewRelayDraft] = useState({
    name: "中转站",
    baseUrl: "",
    apiKey: "",
    testModel: "gpt-4o-mini",
  });

  const getCustomProviderTestModel = () => {
    const customModels = modelConfigs.filter((m) => m.provider === "custom" && m.visible === 1);
    const modelId = String(customModels[0]?.model_id || "").trim();
    return modelId || "gpt-4o-mini";
  };

  const createStrongToken = (length = 48) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bytes = new Uint8Array(length);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  };

  const generateLocalApiToken = () => {
    const token = createStrongToken(48);
    setGlobal((g) => ({ ...g, localApiToken: token }));
    setShowLocalApiToken(true);
    addToast("success", "已生成随机 Token");
  };

  const maskSecret = (value: string) => {
    const len = (value || "").length;
    if (!len) return "";
    return "*".repeat(Math.min(16, Math.max(4, len)));
  };

  const maskedValue = (value: string, hasSavedKey: boolean) => {
    if (value) return maskSecret(value);
    return hasSavedKey ? "********" : "";
  };

  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    return "未知错误";
  };

  const getTestErrorMessage = (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") {
      return "请求超时（15秒）";
    }
    return getErrorMessage(error);
  };

  const parseTestResponse = async (res: Response): Promise<{ ok: boolean; message: string }> => {
    const raw = await res.text();
    if (!raw) {
      return { ok: false, message: res.ok ? "" : `HTTP ${res.status}` };
    }
    try {
      const data = JSON.parse(raw) as { ok?: boolean; message?: string };
      const ok = !!data?.ok;
      const message = String(data?.message || "").trim();
      if (!ok && !message) {
        return { ok: false, message: `HTTP ${res.status}` };
      }
      return { ok, message };
    } catch {
      const message = raw.trim() || (res.ok ? "" : `HTTP ${res.status}`);
      return { ok: res.ok, message };
    }
  };

  const refreshCustomRelays = async () => {
    const list = await api<RelayRow[]>("/api/settings/relays");
    const mapped = list.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      apiKey: "",
      hasSavedKey: !!r.has_key,
      testModel: (r.test_model || "gpt-4o-mini").trim() || "gpt-4o-mini",
      status: "unchecked" as const,
    }));
    setRelays(mapped);
    return mapped;
  };

  // load saved keys, global settings, relays, model configs, provider configs
  useEffect(() => {
    // Load provider configs first
    api<ProviderConfigDB[]>("/api/settings/provider-configs").then((configs) => {
      setProviderConfigsDB(configs);
      if (!configs || configs.length === 0) {
        setProviders(defaultProviders);
        return;
      }

      // Initialize providers from configs (all of them, so hidden ones can be toggled back)
      const initialProviders = configs
        .filter((c) => c.provider !== "custom")
        .map(c => ({
        provider: c.provider,
        label: c.label,
        color: c.color,
        apiKey: "",
        hasSavedKey: false,
        baseUrl: c.base_url,
        status: "unchecked" as const,
        models: [] as string[],
      }));
      setProviders(initialProviders);

      // Then load API keys
      api<ApiKeyRow[]>("/api/settings/api-keys").then((keys) => {
        setProviders((prev: ProviderConfig[]) => prev.map((p: ProviderConfig) => {
          const saved = keys.find((k) => k.provider === p.provider);
          return saved
            ? {
              ...p,
              apiKey: "",
              baseUrl: saved.base_url || p.baseUrl,
              status: saved.status || "unchecked",
              hasSavedKey: !!saved.has_key,
            }
            : { ...p, hasSavedKey: false };
        }) as ProviderConfig[]);
      }).catch(() => { });
    }).catch(() => { });
    api<Record<string, string>>("/api/settings/global").then((g) => {
      setGlobal((prev) => ({
        timeout: Number(g.timeout) || prev.timeout,
        maxRetries: Number(g.max_retries) || prev.maxRetries,
        httpProxy: g.http_proxy || "",
        embeddingModel: g.embedding_model || prev.embeddingModel,
        embeddingDim: Number(g.embedding_dim) || prev.embeddingDim,
        localApiAuthEnabled: String(g.local_api_auth_enabled || "").toLowerCase() === "1" ||
          String(g.local_api_auth_enabled || "").toLowerCase() === "true",
        localApiToken: g.local_api_auth_token || "",
      }));
    }).catch(() => { });
    refreshCustomRelays().catch(() => { });
    api<ModelConfig[]>("/api/settings/model-configs").then((configs) => {
      setModelConfigs(configs);
    }).catch(() => { });
  }, [api]);

  const saveAll = async () => {
    const normalizedLocalToken = global.localApiToken.trim();
    if (global.localApiAuthEnabled && !normalizedLocalToken) {
      addToast("error", "已开启本地接口鉴权，请填写 Token");
      return;
    }

    setSaving(true);
    try {
      // save provider keys / clear keys explicitly selected for deletion
      for (const p of providers) {
        const apiKey = p.apiKey.trim();
        if (apiKey) {
          await api("/api/settings/api-keys", {
            method: "POST",
            body: JSON.stringify({ provider: p.provider, api_key: apiKey, base_url: p.baseUrl }),
          });
        } else if (clearProviderKey[p.provider]) {
          await api(`/api/settings/api-keys/${p.provider}`, { method: "DELETE" });
        } else if (p.hasSavedKey) {
          await api("/api/settings/api-keys", {
            method: "POST",
            body: JSON.stringify({ provider: p.provider, api_key: "", base_url: p.baseUrl }),
          });
        }
      }

      // save every relay as an independent provider card
      for (const relay of relays) {
        const relayName = relay.name.trim() || "中转站";
        const relayBaseUrl = relay.baseUrl.trim();
        if (!relayBaseUrl) {
          throw new Error(`中转站「${relayName}」缺少 Base URL`);
        }
        const relayKey = `relay:${relay.id}`;
        const relayApiKey = relay.apiKey.trim();
        const payload: Record<string, string> = {
          name: relayName,
          base_url: relayBaseUrl,
          test_model: relay.testModel.trim() || "gpt-4o-mini",
        };
        if (relayApiKey || clearProviderKey[relayKey]) payload.api_key = relayApiKey;

        await api(`/api/settings/relays/${relay.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }

      // refresh relay list from DB
      await refreshCustomRelays();

      // save global settings at the end, so token changes don't break requests in this save transaction
      await api("/api/settings/global", {
        method: "POST",
        body: JSON.stringify({
          timeout: String(global.timeout), max_retries: String(global.maxRetries),
          http_proxy: global.httpProxy, embedding_model: global.embeddingModel,
          embedding_dim: String(global.embeddingDim),
          local_api_auth_enabled: global.localApiAuthEnabled ? "1" : "0",
          local_api_auth_token: normalizedLocalToken,
        }),
      });

      // Keep frontend token header source aligned with backend setting.
      if (global.localApiAuthEnabled) {
        window.localStorage.setItem(LOCAL_API_TOKEN_STORAGE_KEY, normalizedLocalToken);
      } else {
        window.localStorage.removeItem(LOCAL_API_TOKEN_STORAGE_KEY);
      }

      setProviders((prev) =>
        prev.map((p) => {
          const apiKey = p.apiKey.trim();
          const wasCleared = !!clearProviderKey[p.provider];
          const hasSavedKey = apiKey ? true : (wasCleared ? false : p.hasSavedKey);
          return { ...p, apiKey: "", hasSavedKey };
        }),
      );
      setClearProviderKey({});
      addToast("success", "设置已保存");
    } catch (error) {
      addToast("error", `保存失败：${getErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (idx: number, field: keyof ProviderConfig, value: string | boolean) => {
    setProviders((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
    if (field === "apiKey") {
      const provider = providers[idx]?.provider;
      if (provider) {
        setClearProviderKey((prev) => ({ ...prev, [provider]: false }));
      }
    }
  };

  const openAddProviderForm = () => {
    setNewProviderDraft({ provider: "", label: "", baseUrl: "", color: "#5B6EF5" });
    setShowAddProviderForm(true);
  };

  const cancelAddProviderForm = () => {
    if (addingProvider) return;
    setShowAddProviderForm(false);
    setNewProviderDraft({ provider: "", label: "", baseUrl: "", color: "#5B6EF5" });
  };

  const createProviderCard = async () => {
    const provider = newProviderDraft.provider.trim().toLowerCase();
    const label = newProviderDraft.label.trim();
    const baseUrl = newProviderDraft.baseUrl.trim();
    const color = newProviderDraft.color.trim() || "#5B6EF5";

    if (!provider || !label) {
      addToast("warning", "请填写服务商标识和显示名称");
      return;
    }
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(provider)) {
      addToast("warning", "服务商标识需为 2-32 位小写字母/数字/_/-，且以字母开头");
      return;
    }
    if (provider === "custom") {
      addToast("warning", "custom 为系统保留标识，请换一个服务商标识");
      return;
    }
    const exists = providerConfigsDB.some((p) => p.provider === provider) || providers.some((p) => p.provider === provider);
    if (exists) {
      addToast("warning", "该服务商标识已存在，请换一个");
      return;
    }

    setAddingProvider(true);
    try {
      const nextSortOrder = providerConfigsDB.length > 0
        ? Math.max(...providerConfigsDB.map((p) => Number(p.sort_order || 0))) + 1
        : 1;
      const created = await api<ProviderConfigDB>("/api/settings/provider-configs", {
        method: "POST",
        body: JSON.stringify({
          provider,
          label,
          color,
          base_url: baseUrl,
          visible: true,
          sort_order: nextSortOrder,
        }),
      });

      setProviderConfigsDB((prev) =>
        [...prev, created].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)),
      );
      setProviders((prev) => [
        ...prev,
        {
          provider,
          label,
          color,
          apiKey: "",
          hasSavedKey: false,
          baseUrl: baseUrl || "",
          status: "unchecked",
          models: [],
        },
      ]);
      setShowBaseUrl((prev) => ({ ...prev, [provider]: true }));
      setShowAddProviderForm(false);
      setNewProviderDraft({ provider: "", label: "", baseUrl: "", color: "#5B6EF5" });
      addToast("success", "服务商已添加");
    } catch (error) {
      addToast("error", `添加服务商失败：${getErrorMessage(error)}`);
    } finally {
      setAddingProvider(false);
    }
  };

  const deleteProviderCard = async (provider: string) => {
    const config = providerConfigsDB.find((p) => p.provider === provider);
    if (!config) return;
    if (config.is_custom !== 1) {
      addToast("warning", "内置服务商不允许删除");
      return;
    }
    if (!window.confirm(`确定删除服务商「${config.label}」吗？`)) return;

    try {
      const providerModels = modelConfigs.filter((m) => m.provider === provider);
      if (providerModels.length > 0) {
        await Promise.allSettled(
          providerModels.map((m) => api(`/api/settings/model-configs/${m.id}`, { method: "DELETE" })),
        );
      }
      await Promise.allSettled([
        api(`/api/settings/api-keys/${provider}`, { method: "DELETE" }),
        api(`/api/settings/provider-configs/${config.id}`, { method: "DELETE" }),
      ]);

      setProviders((prev) => prev.filter((p) => p.provider !== provider));
      setProviderConfigsDB((prev) => prev.filter((p) => p.provider !== provider));
      setModelConfigs((prev) => prev.filter((m) => m.provider !== provider));
      setShowProviderKey((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setShowBaseUrl((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      setClearProviderKey((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      addToast("success", "服务商已删除");
    } catch (error) {
      addToast("error", `删除服务商失败：${getErrorMessage(error)}`);
    }
  };

  const openAddRelayModal = () => {
    const sampleRelay = relays[0];
    setNewRelayDraft({
      name: "中转站",
      baseUrl: sampleRelay?.baseUrl || "",
      apiKey: "",
      testModel: sampleRelay?.testModel || getCustomProviderTestModel(),
    });
    setShowNewRelayKey(true);
    setShowAddRelayModal(true);
  };

  const createRelayFromModal = async () => {
    const payload = {
      name: newRelayDraft.name.trim() || "中转站",
      base_url: newRelayDraft.baseUrl.trim(),
      api_key: newRelayDraft.apiKey.trim(),
      test_model: newRelayDraft.testModel.trim() || "gpt-4o-mini",
    };
    if (!payload.base_url) {
      addToast("warning", "请填写 Base URL");
      return;
    }
    if (!payload.api_key) {
      addToast("warning", "请填写 API Key");
      return;
    }

    setAddingRelay(true);
    try {
      await api("/api/settings/relays", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await refreshCustomRelays();
      setShowAddRelayModal(false);
      setShowNewRelayKey(false);
      setNewRelayDraft({ name: "中转站", baseUrl: "", apiKey: "", testModel: "gpt-4o-mini" });
      addToast("success", "中转站已添加");
    } catch (error) {
      addToast("error", `添加中转站失败：${getErrorMessage(error)}`);
    } finally {
      setAddingRelay(false);
    }
  };

  const relayStateKey = (relayId: string) => `relay:${relayId}`;

  const updateRelay = (relayId: string, patch: Partial<CustomRelay>) => {
    setRelays((prev) => prev.map((relay) => (relay.id === relayId ? { ...relay, ...patch } : relay)));
    if (Object.prototype.hasOwnProperty.call(patch, "apiKey")) {
      const key = relayStateKey(relayId);
      setClearProviderKey((prev) => ({ ...prev, [key]: false }));
    }
  };

  const deleteRelay = async (relayId: string) => {
    if (!window.confirm("确定删除该中转站吗？此操作不可恢复。")) return;
    try {
      await api(`/api/settings/relays/${relayId}`, { method: "DELETE" });
      await refreshCustomRelays();
      setShowProviderKey((prev) => {
        const next = { ...prev };
        delete next[relayStateKey(relayId)];
        return next;
      });
      setShowBaseUrl((prev) => {
        const next = { ...prev };
        delete next[relayStateKey(relayId)];
        return next;
      });
      setClearProviderKey((prev) => {
        const next = { ...prev };
        delete next[relayStateKey(relayId)];
        return next;
      });
      addToast("success", "中转站已删除");
    } catch (error) {
      addToast("error", `删除中转站失败：${getErrorMessage(error)}`);
    }
  };

  const testProviderConnection = async (idx: number) => {
    const provider = providers[idx];
    if (!provider) return;
    const providerTestModel = String(
      modelConfigs.find((m) => m.provider === provider.provider && m.visible === 1)?.model_id || ""
    ).trim();
    setTesting(provider.provider);
    const startedAt = performance.now();
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      let data = { ok: false, message: "" };
      try {
        const res = await fetch(`${API_BASE}/agent/test-key?_t=${Date.now()}`, {
          method: "POST",
          headers: withLocalApiAuth({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            provider: provider.provider,
            api_key: provider.apiKey,
            base_url: provider.baseUrl || undefined,
            model: providerTestModel || undefined,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        data = await parseTestResponse(res);
      } finally {
        window.clearTimeout(timer);
      }
      updateProvider(idx, "status", data.ok ? "connected" : "failed");
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
      if (data.ok) {
        addToast("success", `测试成功（${elapsed}ms）`);
      } else {
        addToast("error", `测试失败（${elapsed}ms）：${data.message || "未知错误"}`);
      }
    } catch (error) {
      updateProvider(idx, "status", "failed");
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
      addToast("error", `测试失败（${elapsed}ms）：${getTestErrorMessage(error)}`);
    } finally {
      setTesting((prev) => (prev === provider.provider ? null : prev));
    }
  };

  const testRelayConnection = async (relayId: string) => {
    const relay = relays.find((r) => r.id === relayId);
    if (!relay) return;
    const relayKey = relayStateKey(relayId);
    const canTestRelay = !!relay.apiKey.trim() || (relay.hasSavedKey && !clearProviderKey[relayKey]);
    if (!canTestRelay) return;

    setTesting(relayKey);
    const startedAt = performance.now();
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      let data = { ok: false, message: "" };
      try {
        const res = await fetch(`${API_BASE}/agent/test-key?_t=${Date.now()}`, {
          method: "POST",
          headers: withLocalApiAuth({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            provider: "custom",
            api_key: relay.apiKey,
            base_url: relay.baseUrl || undefined,
            model: relay.testModel.trim() || "gpt-4o-mini",
            relay_id: !relay.apiKey.trim() ? relay.id : undefined,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        data = await parseTestResponse(res);
      } finally {
        window.clearTimeout(timer);
      }
      updateRelay(relayId, { status: data.ok ? "connected" : "failed" });
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
      if (data.ok) {
        addToast("success", `测试成功（${elapsed}ms）`);
      } else {
        addToast("error", `测试失败（${elapsed}ms）：${data.message || "未知错误"}`);
      }
    } catch (error) {
      updateRelay(relayId, { status: "failed" });
      const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
      addToast("error", `测试失败（${elapsed}ms）：${getTestErrorMessage(error)}`);
    } finally {
      setTesting((prev) => (prev === relayKey ? null : prev));
    }
  };

  // 模型管理函数 - 仅用于服务商的模型列表编辑
  // 切换服务商可见性
  const toggleProviderVisibility = async (provider: string) => {
    const providerConfig = providerConfigsDB.find(p => p.provider === provider);
    if (!providerConfig) return;

    const newVisible = providerConfig.visible === 1 ? 0 : 1;
    await api(`/api/settings/provider-configs/${providerConfig.id}`, {
      method: "PUT",
      body: JSON.stringify({ visible: newVisible === 1 }),
    });

    setProviderConfigsDB((prev) => prev.map((p) =>
      p.provider === provider ? { ...p, visible: newVisible } : p
    ));
  };

  // 为服务商添加模型
  const addModelForProvider = async (provider: string) => {
    if (!newModelInput.model_id || !newModelInput.model_label) return;

    const created = await api<ModelConfig>("/api/settings/model-configs", {
      method: "POST",
      body: JSON.stringify({
        provider,
        model_id: newModelInput.model_id,
        model_label: newModelInput.model_label,
        visible: true,
        sort_order: 0,
      }),
    });

    setModelConfigs((prev) => [...prev, created]);
    setNewModelInput({ model_id: "", model_label: "" });
    setAddingModelFor(null);
  };

  // 删除服务商的模型
  const deleteModelForProvider = async (modelId: string) => {
    await api(`/api/settings/model-configs/${modelId}`, { method: "DELETE" });
    setModelConfigs((prev) => prev.filter((m) => m.id !== modelId));
  };

  // 获取服务商的模型列表
  const getProviderModels = (provider: string) => {
    return modelConfigs.filter(m => m.provider === provider && m.visible === 1);
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; color: string; text: string }> = {
      connected: { bg: "rgba(76,175,80,0.15)", color: "#4CAF50", text: "已连接" },
      failed: { bg: "rgba(244,67,54,0.15)", color: "#F44336", text: "失败" },
      unchecked: { bg: "rgba(255,152,0,0.15)", color: "#FF9800", text: "未检测" },
    };
    const s = map[status] || map.unchecked;
    return (
      <span style={{ padding: "3px 10px", borderRadius: 12, background: s.bg, color: s.color, fontSize: 11, fontWeight: 500 }}>
        {s.text}
      </span>
    );
  };

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>API 设置</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          配置各AI服务商的API密钥。所有密钥仅存储在本地，不会上传到任何服务器。
        </p>
        <button onClick={saveAll} disabled={saving} style={{
          marginTop: 8, padding: "8px 20px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
          background: "var(--accent-gold)", color: "#000",
        }}>{saving ? "保存中..." : "保存所有设置"}</button>
      </div>

      {/* 通用网络设置 */}
      <section>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>通用设置</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>请求超时 (秒)</label>
            <input style={inputStyle} type="number" value={global.timeout}
              onChange={(e) => setGlobal((g) => ({ ...g, timeout: +e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>最大重试次数</label>
            <input style={inputStyle} type="number" value={global.maxRetries}
              onChange={(e) => setGlobal((g) => ({ ...g, maxRetries: +e.target.value }))} />
          </div>
          <div>
            <label style={labelStyle}>Embedding 模型</label>
            <select style={inputStyle} value={global.embeddingModel}
              onChange={(e) => setGlobal((g) => ({ ...g, embeddingModel: e.target.value }))}>
              <option value="text-embedding-3-small">text-embedding-3-small</option>
              <option value="text-embedding-3-large">text-embedding-3-large</option>
              <option value="text-embedding-ada-002">text-embedding-ada-002</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Embedding 维度</label>
            <div style={{ display: "flex", gap: 6 }}>
              {[1536, 3072].map((d) => (
                <button key={d} onClick={() => setGlobal((g) => ({ ...g, embeddingDim: d }))} style={{
                  flex: 1, height: 40, borderRadius: 8, border: "none", fontSize: 13, cursor: "pointer",
                  background: global.embeddingDim === d ? "var(--accent-gold-dim)" : "var(--bg-input)",
                  color: global.embeddingDim === d ? "var(--accent-gold)" : "var(--text-secondary)",
                  fontWeight: global.embeddingDim === d ? 600 : 400,
                }}>{d}</button>
              ))}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>HTTP 代理 (可选，用于网络受限环境)</label>
            <input style={inputStyle} value={global.httpProxy}
              onChange={(e) => setGlobal((g) => ({ ...g, httpProxy: e.target.value }))}
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" />
          </div>
          <div style={{ gridColumn: "1 / -1", marginTop: 4, padding: 12, borderRadius: 10, border: "1px solid var(--bg-border)", background: "var(--bg-card)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>本地接口 Token 鉴权</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>
                  开启后，Agent API 需要 `X-Sanhuoai-Token`。用于防止本机其他进程直接调用。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGlobal((g) => ({ ...g, localApiAuthEnabled: !g.localApiAuthEnabled }))}
                style={{
                  minWidth: 78,
                  height: 34,
                  borderRadius: 17,
                  border: "none",
                  cursor: "pointer",
                  background: global.localApiAuthEnabled ? "var(--accent-gold-dim)" : "var(--bg-input)",
                  color: global.localApiAuthEnabled ? "var(--accent-gold)" : "var(--text-secondary)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {global.localApiAuthEnabled ? "已开启" : "已关闭"}
              </button>
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={labelStyle}>本地 Token</label>
              <div style={{ position: "relative" }}>
                <input
                  type={showLocalApiToken ? "text" : "password"}
                  value={global.localApiToken}
                  onChange={(e) => setGlobal((g) => ({ ...g, localApiToken: e.target.value }))}
                  placeholder="建议 24 位以上随机字符串"
                  style={{ ...inputStyle, paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowLocalApiToken((v) => !v)}
                  title={showLocalApiToken ? "隐藏 Token" : "显示 Token"}
                  style={{
                    position: "absolute",
                    right: 8,
                    top: 8,
                    width: 24,
                    height: 24,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    boxShadow: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  {showLocalApiToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={generateLocalApiToken}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                    background: "var(--accent-gold-dim)",
                    color: "var(--accent-gold)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  随机生成
                </button>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  建议每次项目迁移时重新生成。
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Provider 列表 */}
      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>服务商配置</h3>
          <button
            type="button"
            onClick={() => (showAddProviderForm ? cancelAddProviderForm() : openAddProviderForm())}
            style={{
              background: "var(--accent-gold-dim)",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              color: "var(--accent-gold)",
              fontSize: 12,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "6px 12px",
              whiteSpace: "nowrap",
            }}
          >
            <Plus size={14} /> {showAddProviderForm ? "取消新增" : "新增服务商"}
          </button>
        </div>
        {showAddProviderForm && (
          <div style={{
            marginBottom: 12,
            padding: 14,
            borderRadius: 10,
            border: "1px solid var(--bg-border)",
            background: "var(--bg-card)",
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1.4fr 120px auto",
            gap: 10,
            alignItems: "end",
          }}>
            <div>
              <label style={labelStyle}>服务商标识</label>
              <input
                style={inputStyle}
                value={newProviderDraft.provider}
                onChange={(e) => setNewProviderDraft((prev) => ({ ...prev, provider: e.target.value }))}
                placeholder="如 xai / openrouter"
              />
            </div>
            <div>
              <label style={labelStyle}>显示名称</label>
              <input
                style={inputStyle}
                value={newProviderDraft.label}
                onChange={(e) => setNewProviderDraft((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="如 xAI"
              />
            </div>
            <div>
              <label style={labelStyle}>默认 Base URL</label>
              <input
                style={inputStyle}
                value={newProviderDraft.baseUrl}
                onChange={(e) => setNewProviderDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                placeholder="可选：OpenAI 兼容接口地址"
              />
            </div>
            <div>
              <label style={labelStyle}>颜色</label>
              <input
                type="color"
                style={{ ...inputStyle, padding: 4, cursor: "pointer" }}
                value={newProviderDraft.color}
                onChange={(e) => setNewProviderDraft((prev) => ({ ...prev, color: e.target.value }))}
              />
            </div>
            <button
              type="button"
              disabled={addingProvider}
              onClick={createProviderCard}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 8,
                border: "none",
                cursor: addingProvider ? "not-allowed" : "pointer",
                background: "var(--accent-gold)",
                color: "#000",
                fontSize: 12,
                fontWeight: 700,
                opacity: addingProvider ? 0.7 : 1,
              }}
            >
              {addingProvider ? "添加中..." : "确认添加"}
            </button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 520px))", gap: 12, justifyContent: "start" }}>
          {providers.map((p, idx) => {
            const providerConfig = providerConfigsDB.find((pc) => pc.provider === p.provider);
            const isVisible = providerConfig?.visible === 1;
            const isCustomProvider = providerConfig?.is_custom === 1;
            const isExpanded = expandedProviders[p.provider] ?? false;
            const providerModels = getProviderModels(p.provider);
            const canTestProvider = !!p.apiKey || (p.hasSavedKey && !clearProviderKey[p.provider]);
            const hasKeyHint = !!p.apiKey || p.hasSavedKey;
            return (
              <div key={p.provider} style={{
                padding: 14, borderRadius: 12, border: "1px solid var(--bg-border)",
                display: "flex", flexDirection: "column", gap: 10,
                opacity: isVisible ? 1 : 0.5,
                filter: isVisible ? "none" : "grayscale(80%)",
                transition: "all 0.2s",
                background: "var(--bg-card)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 6, background: p.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontWeight: 700, fontSize: 13,
                  }}>{p.label[0]}</div>
                  <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{p.label}</span>
                  {statusBadge(p.status)}
                  <button
                    onClick={() => toggleProviderVisibility(p.provider)}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: providerConfig?.visible === 1 ? "var(--accent-gold)" : "var(--text-secondary)",
                      padding: 2, display: "flex", alignItems: "center",
                    }}
                    title={providerConfig?.visible === 1 ? "点击隐藏此服务商的模型" : "点击显示此服务商的模型"}>
                    {providerConfig?.visible === 1 ? <Eye size={16} /> : <EyeOff size={16} />}
                  </button>
                  {isCustomProvider && (
                    <button
                      type="button"
                      onClick={() => deleteProviderCard(p.provider)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "#F44336",
                        padding: 2,
                        display: "flex",
                        alignItems: "center",
                      }}
                      title="删除此自定义服务商"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setExpandedProviders((prev) => ({ ...prev, [p.provider]: !isExpanded }))}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                      padding: 2,
                      display: "flex",
                      alignItems: "center",
                    }}
                    title={isExpanded ? "收起卡片" : "展开卡片"}
                  >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--text-secondary)" }}>
                  <span>模型 {providerModels.length}</span>
                  <span>•</span>
                  <span>{hasKeyHint ? "密钥已配置" : "未配置密钥"}</span>
                  {p.baseUrl ? (
                    <>
                      <span>•</span>
                      <span style={{ maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl}</span>
                    </>
                  ) : null}
                </div>

                {isExpanded && (
                  <>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>可用模型</label>
                        <button
                          onClick={() => setAddingModelFor(addingModelFor === p.provider ? null : p.provider)}
                          style={{
                            background: "none", border: "none", cursor: "pointer",
                            color: "var(--accent-gold)", fontSize: 12, fontWeight: 500,
                            display: "flex", alignItems: "center", gap: 4,
                          }}>
                          <Plus size={14} /> {addingModelFor === p.provider ? "取消" : "添加模型"}
                        </button>
                      </div>

                      {addingModelFor === p.provider && (
                        <div style={{
                          display: "flex", gap: 8, marginBottom: 12,
                          padding: 12, borderRadius: 8, background: "var(--bg-input)",
                        }}>
                          <input
                            value={newModelInput.model_id}
                            onChange={(e) => setNewModelInput({ ...newModelInput, model_id: e.target.value })}
                            placeholder="模型ID (如: gpt-4o)"
                            style={{ ...inputStyle, flex: 1, height: 36 }} />
                          <input
                            value={newModelInput.model_label}
                            onChange={(e) => setNewModelInput({ ...newModelInput, model_label: e.target.value })}
                            placeholder="显示名称 (如: GPT-4o)"
                            style={{ ...inputStyle, flex: 1, height: 36 }} />
                          <button
                            onClick={() => addModelForProvider(p.provider)}
                            disabled={!newModelInput.model_id || !newModelInput.model_label}
                            style={{
                              height: 36, padding: "0 16px", borderRadius: 8, border: "none",
                              background: newModelInput.model_id && newModelInput.model_label ? "var(--accent-gold)" : "var(--bg-secondary)",
                              color: newModelInput.model_id && newModelInput.model_label ? "#000" : "var(--text-secondary)",
                              fontSize: 12, fontWeight: 600,
                              cursor: newModelInput.model_id && newModelInput.model_label ? "pointer" : "not-allowed",
                            }}>
                            添加
                          </button>
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {providerModels.map((model) => (
                          <span key={model.id} style={{
                            padding: "4px 10px", borderRadius: 6, fontSize: 11,
                            background: "var(--bg-input)", color: "var(--text-secondary)",
                            display: "flex", alignItems: "center", gap: 6,
                          }}>
                            {model.model_label}
                            <button
                              onClick={() => deleteModelForProvider(model.id)}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                color: "var(--text-secondary)", padding: 0,
                                display: "flex", alignItems: "center",
                              }}>
                              <Trash2 size={10} />
                            </button>
                          </span>
                        ))}
                        {providerModels.length === 0 && (
                          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontStyle: "italic" }}>
                            暂无模型，点击"添加模型"来添加
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>API Key</label>
                        <div style={{ position: "relative" }}>
                          <input
                            type="text"
                            value={showProviderKey[p.provider] ? p.apiKey : maskedValue(p.apiKey, p.hasSavedKey)}
                            onChange={(e) => updateProvider(idx, "apiKey", e.target.value)}
                            readOnly={!showProviderKey[p.provider] && (p.hasSavedKey || !!p.apiKey)}
                            placeholder={`输入 ${p.label} API Key...`}
                            style={{ ...inputStyle, paddingRight: 44 }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowProviderKey((prev) => ({ ...prev, [p.provider]: !prev[p.provider] }))}
                            title={showProviderKey[p.provider] ? "隐藏密钥" : "显示密钥"}
                            style={{
                              position: "absolute",
                              right: 8,
                              top: 8,
                              width: 24,
                              height: 24,
                              padding: 0,
                              border: "none",
                              background: "transparent",
                              color: "var(--text-secondary)",
                              boxShadow: "none",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                            }}
                          >
                            {showProviderKey[p.provider] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        {!showProviderKey[p.provider] && (p.hasSavedKey || !!p.apiKey) && (
                          <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
                            已隐藏密钥，点击眼睛可查看或编辑
                          </p>
                        )}
                        {p.hasSavedKey && !p.apiKey && (
                          <button
                            type="button"
                            onClick={() => setClearProviderKey((prev) => ({ ...prev, [p.provider]: !prev[p.provider] }))}
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              border: "none",
                              background: "transparent",
                              color: clearProviderKey[p.provider] ? "#F44336" : "var(--text-secondary)",
                              cursor: "pointer",
                              padding: 0,
                              textDecoration: "underline",
                              textUnderlineOffset: 2,
                            }}
                          >
                            {clearProviderKey[p.provider] ? "已标记为保存时删除该密钥" : "清除已保存密钥（保存时生效）"}
                          </button>
                        )}
                      </div>
                      <button onClick={() => testProviderConnection(idx)}
                        disabled={!canTestProvider || testing === p.provider}
                        style={{
                          height: 40, padding: "0 16px", borderRadius: 8, border: "none",
                          background: canTestProvider ? "var(--accent-gold-dim)" : "var(--bg-input)",
                          color: canTestProvider ? "var(--accent-gold)" : "var(--text-secondary)",
                          fontSize: 13, fontWeight: 500, cursor: canTestProvider ? "pointer" : "not-allowed",
                          whiteSpace: "nowrap",
                        }}>{testing === p.provider ? "测试中..." : "测试连接"}</button>
                    </div>

                    <div>
                      <button onClick={() => setShowBaseUrl((s) => ({ ...s, [p.provider]: !s[p.provider] }))}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          fontSize: 12, color: "var(--text-secondary)", padding: 0,
                          textDecoration: "underline", textUnderlineOffset: 2,
                        }}>
                        {showBaseUrl[p.provider] ? "收起" : "自定义 Base URL"}
                      </button>
                      {showBaseUrl[p.provider] && (
                        <div style={{ marginTop: 8 }}>
                          <input value={p.baseUrl}
                            onChange={(e) => updateProvider(idx, "baseUrl", e.target.value)}
                            placeholder={`${p.label} 自定义接口地址...`}
                            style={inputStyle} />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>自定义中转站</h3>
          <button
            onClick={openAddRelayModal}
            style={{
              background: "var(--accent-gold-dim)",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              color: "var(--accent-gold)",
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "6px 12px",
              whiteSpace: "nowrap",
            }}
            title="新增中转站"
          >
            <Plus size={14} /> 添加中转站{relays.length > 0 ? ` (${relays.length})` : ""}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 520px))", gap: 12, justifyContent: "start" }}>
          {relays.length === 0 && (
            <div style={{
              padding: 16,
              borderRadius: 12,
              border: "1px dashed var(--bg-border)",
              color: "var(--text-secondary)",
              fontSize: 13,
              gridColumn: "1 / -1",
            }}>
              还没有中转站。点击“添加中转站”即可新增一个服务商卡片。
            </div>
          )}
          {relays.map((relay) => {
            const relayKey = relayStateKey(relay.id);
            const isExpanded = expandedRelays[relay.id] ?? false;
            const canTestRelay = !!relay.apiKey.trim() || (relay.hasSavedKey && !clearProviderKey[relayKey]);
            return (
              <div key={relay.id} style={{
                padding: 14,
                borderRadius: 12,
                border: "1px solid var(--bg-border)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                background: "var(--bg-card)",
                width: "100%",
                maxWidth: 520,
                justifySelf: "start",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 6, background: "#FF6B35",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontWeight: 700, fontSize: 13,
                  }}>{(relay.name || "中")[0]}</div>
                  <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{relay.name || "中转站"}</span>
                  {statusBadge(relay.status)}
                  <button
                    type="button"
                    onClick={() => deleteRelay(relay.id)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#F44336",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                    title="删除中转站"
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedRelays((prev) => ({ ...prev, [relay.id]: !isExpanded }))}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                      padding: 2,
                      display: "flex",
                      alignItems: "center",
                    }}
                    title={isExpanded ? "收起卡片" : "展开卡片"}
                  >
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--text-secondary)" }}>
                  <span>测试模型：{relay.testModel || "未设置"}</span>
                  <span>•</span>
                  <span>{relay.apiKey || relay.hasSavedKey ? "密钥已配置" : "未配置密钥"}</span>
                  {relay.baseUrl ? (
                    <>
                      <span>•</span>
                      <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{relay.baseUrl}</span>
                    </>
                  ) : null}
                </div>

                {isExpanded && (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <label style={labelStyle}>名称</label>
                        <input
                          style={inputStyle}
                          value={relay.name}
                          onChange={(e) => updateRelay(relay.id, { name: e.target.value })}
                          placeholder="例如：OpenRouter-备用"
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>测试模型</label>
                        <input
                          style={inputStyle}
                          value={relay.testModel}
                          onChange={(e) => updateRelay(relay.id, { testModel: e.target.value })}
                          placeholder="例如：gpt-4o-mini"
                        />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>API Key</label>
                        <div style={{ position: "relative" }}>
                          <input
                            type="text"
                            value={showProviderKey[relayKey] ? relay.apiKey : maskedValue(relay.apiKey, relay.hasSavedKey)}
                            onChange={(e) => updateRelay(relay.id, { apiKey: e.target.value })}
                            readOnly={!showProviderKey[relayKey] && (relay.hasSavedKey || !!relay.apiKey)}
                            placeholder={`输入 ${relay.name || "中转站"} API Key...`}
                            style={{ ...inputStyle, paddingRight: 44 }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowProviderKey((prev) => ({ ...prev, [relayKey]: !prev[relayKey] }))}
                            title={showProviderKey[relayKey] ? "隐藏密钥" : "显示密钥"}
                            style={{
                              position: "absolute",
                              right: 8,
                              top: 8,
                              width: 24,
                              height: 24,
                              padding: 0,
                              border: "none",
                              background: "transparent",
                              color: "var(--text-secondary)",
                              boxShadow: "none",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                            }}
                          >
                            {showProviderKey[relayKey] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                        {!showProviderKey[relayKey] && (relay.hasSavedKey || !!relay.apiKey) && (
                          <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
                            已隐藏密钥，点击眼睛可查看或编辑
                          </p>
                        )}
                        {relay.hasSavedKey && !relay.apiKey && (
                          <button
                            type="button"
                            onClick={() => setClearProviderKey((prev) => ({ ...prev, [relayKey]: !prev[relayKey] }))}
                            style={{
                              marginTop: 6,
                              fontSize: 11,
                              border: "none",
                              background: "transparent",
                              color: clearProviderKey[relayKey] ? "#F44336" : "var(--text-secondary)",
                              cursor: "pointer",
                              padding: 0,
                              textDecoration: "underline",
                              textUnderlineOffset: 2,
                            }}
                          >
                            {clearProviderKey[relayKey] ? "已标记为保存时删除该密钥" : "清除已保存密钥（保存时生效）"}
                          </button>
                        )}
                      </div>
                      <button
                        onClick={() => testRelayConnection(relay.id)}
                        disabled={!canTestRelay || testing === relayKey}
                        style={{
                          height: 40, padding: "0 16px", borderRadius: 8, border: "none",
                          background: canTestRelay ? "var(--accent-gold-dim)" : "var(--bg-input)",
                          color: canTestRelay ? "var(--accent-gold)" : "var(--text-secondary)",
                          fontSize: 13, fontWeight: 500, cursor: canTestRelay ? "pointer" : "not-allowed",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {testing === relayKey ? "测试中..." : "测试连接"}
                      </button>
                    </div>
                    <div>
                      <button onClick={() => setShowBaseUrl((s) => ({ ...s, [relayKey]: !s[relayKey] }))}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          fontSize: 12, color: "var(--text-secondary)", padding: 0,
                          textDecoration: "underline", textUnderlineOffset: 2,
                        }}>
                        {showBaseUrl[relayKey] ? "收起" : "自定义 Base URL"}
                      </button>
                      {showBaseUrl[relayKey] && (
                        <div style={{ marginTop: 8 }}>
                          <input
                            value={relay.baseUrl}
                            onChange={(e) => updateRelay(relay.id, { baseUrl: e.target.value })}
                            placeholder="中转站自定义接口地址..."
                            style={inputStyle}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {showAddRelayModal && (
        <div
          onClick={() => !addingRelay && setShowAddRelayModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
          }}
        >
          <div
            className="solid-popup"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(680px, 92vw)",
              borderRadius: 12,
              border: "1px solid var(--bg-border)",
              background: "var(--bg-popup)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "0 12px 36px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>添加中转站</h3>
              <button
                type="button"
                onClick={() => setShowAddRelayModal(false)}
                disabled={addingRelay}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: addingRelay ? "not-allowed" : "pointer",
                  fontSize: 12,
                }}
              >
                关闭
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>名称</label>
                <input
                  style={inputStyle}
                  value={newRelayDraft.name}
                  onChange={(e) => setNewRelayDraft((v) => ({ ...v, name: e.target.value }))}
                  placeholder="例如：new-api-国内"
                />
              </div>
              <div>
                <label style={labelStyle}>测试模型</label>
                <input
                  style={inputStyle}
                  value={newRelayDraft.testModel}
                  onChange={(e) => setNewRelayDraft((v) => ({ ...v, testModel: e.target.value }))}
                  placeholder="例如：gpt-4o-mini"
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>Base URL（必填）</label>
                <input
                  style={inputStyle}
                  value={newRelayDraft.baseUrl}
                  onChange={(e) => setNewRelayDraft((v) => ({ ...v, baseUrl: e.target.value }))}
                  placeholder="https://your-relay.com/v1"
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>API Key（必填）</label>
                <div style={{ position: "relative" }}>
                  <input
                    type={showNewRelayKey ? "text" : "password"}
                    style={{ ...inputStyle, paddingRight: 44 }}
                    value={newRelayDraft.apiKey}
                    onChange={(e) => setNewRelayDraft((v) => ({ ...v, apiKey: e.target.value }))}
                    placeholder="sk-..."
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewRelayKey((v) => !v)}
                    title={showNewRelayKey ? "隐藏密钥" : "显示密钥"}
                    style={{
                      position: "absolute",
                      right: 8,
                      top: 8,
                      width: 24,
                      height: 24,
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      color: "var(--text-secondary)",
                      boxShadow: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    {showNewRelayKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setShowAddRelayModal(false)}
                disabled={addingRelay}
                style={{
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 8,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: addingRelay ? "not-allowed" : "pointer",
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={createRelayFromModal}
                disabled={addingRelay}
                style={{
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--accent-gold)",
                  color: "#000",
                  fontWeight: 600,
                  cursor: addingRelay ? "not-allowed" : "pointer",
                }}
              >
                {addingRelay ? "添加中..." : "确认添加"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
