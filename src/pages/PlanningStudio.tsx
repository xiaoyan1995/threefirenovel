import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { BookOpenText, Loader2, RefreshCw, Send, Sparkles, WandSparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { inputStyle } from "../components/settings/types";

interface BrainstormMsg {
  role: "user" | "assistant";
  content: string;
}

interface BrainstormQuestionOption {
  label: string;
  value: string;
}

interface BrainstormQuestion {
  id: string;
  title: string;
  qtype: "single" | "multi" | "text" | "number";
  options?: BrainstormQuestionOption[];
  required?: boolean;
  max_select?: number | null;
  placeholder?: string;
}

interface BrainstormOptionHistoryItem {
  title: string;
  qtype: "single" | "multi" | "text" | "number";
  options: BrainstormQuestionOption[];
  signature: string;
  createdAt: number;
}

interface BrainstormApiResponse {
  reply: string;
  questions?: BrainstormQuestion[];
  ready_for_bible?: boolean;
  resolved_model?: string;
}

interface BrainstormOptionRefreshApiResponse {
  options: BrainstormQuestionOption[];
}

interface StoryBibleApiResponse {
  version: number;
  content: string;
  created_at?: string;
}

interface ReviseBibleApiResponse {
  base_version: number;
  revised_content: string;
  changed_sections?: string[];
  change_summary?: string;
}

interface PlanningStateApiResponse {
  project_id: string;
  state: PlanningStudioCache;
  updated_at: string;
}

type KnowledgeReferenceType = "general" | "character" | "plot" | "scene" | "world" | "hook";

interface KnowledgeSourceItem {
  id: string;
  title: string;
  source_type: string;
  reference_type: KnowledgeReferenceType;
  enabled: number | boolean;
}

interface ActiveProfileInfo {
  project_id?: string;
  profile_id?: string | null;
  enabled?: number | boolean;
  name?: string | null;
  genre?: string | null;
  version?: number | null;
}

interface PlanningKnowledgeDragPayload {
  kind: "knowledge_source";
  project_id: string;
  source_id: string;
  title: string;
  reference_type: KnowledgeReferenceType;
}

type BootstrapStats = {
  outline?: number;
  characters?: number;
  worldbuilding?: number;
  chapters?: number;
};

interface BootstrapApiResponse {
  message: string;
  inserted?: BootstrapStats;
  skipped?: BootstrapStats;
}

interface ProjectAutofillSuggestion {
  name: string;
  name_candidates?: string[];
  genre: string;
  description: string;
  word_target: number;
  structure: string;
  custom_structure?: string;
  chapter_words: number;
  priority: string;
  reason?: string;
}

type AutofillApplyFields = {
  name: boolean;
  genre: boolean;
  description: boolean;
  wordTarget: boolean;
  structure: boolean;
  chapterWords: boolean;
  priority: boolean;
};

type StudioPanel = "planning" | "bible";
type BrainstormMode = "fast" | "standard" | "deep";

type PlanningStudioCache = {
  version: number;
  brainstormMessages: BrainstormMsg[];
  brainstormInput: string;
  brainstormQuestions: BrainstormQuestion[];
  brainstormOptionHistory?: BrainstormOptionHistoryItem[];
  brainstormAnswers: Record<string, string | string[]>;
  brainstormOtherAnswers: Record<string, string>;
  brainstormReadyForBible: boolean;
  brainstormMode: BrainstormMode;
  activePanel: StudioPanel;
  bibleText: string;
  bibleDraft: string;
  bibleVersion: number | null;
  selectedKnowledgeSourceIds?: string[];
  updatedAt?: number;
};

type RevisePreview = {
  baseVersion: number;
  baseContent: string;
  revisedContent: string;
  changedSections: string[];
  changeSummary: string;
  instruction: string;
  lockedSections: string[];
};

const planningStudioMemoryCache = new Map<string, PlanningStudioCache>();

const DEFAULT_AUTOFILL_APPLY_FIELDS: AutofillApplyFields = {
  name: false,
  genre: true,
  description: true,
  wordTarget: true,
  structure: true,
  chapterWords: true,
  priority: true,
};
const OTHER_OPTION_VALUE = "__other__";
const OTHER_OPTION_LABEL = "其他（手动填写）";
const AI_DECIDE_OPTION_VALUE = "__ai_decide__";
const AI_DECIDE_OPTION_LABEL = "交给AI决定";
const PLANNING_STUDIO_CACHE_VERSION = 2;
const KNOWLEDGE_SOURCE_DND_MIME = "application/x-sanhuoai-knowledge-source";
const BRAINSTORM_MODE_OPTIONS: Array<{ value: BrainstormMode; label: string; hint: string }> = [
  { value: "fast", label: "极速", hint: "只问核心，默认 AI 补全" },
  { value: "standard", label: "标准", hint: "核心 + 少量禁改项" },
  { value: "deep", label: "深度", hint: "可问规格细节" },
];
const normalizeTextForCompare = (v: string) => String(v || "").replace(/\r\n/g, "\n").trim();

const normalizeSectionIdList = (raw: string | string[]) => {
  const source = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const tokens = source.split(/[\s,，;；\n]+/g);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const v = token.trim().replace(/\.$/, "");
    if (!v) continue;
    if (!/^\d+(?:\.\d+)*$/.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    deduped.push(v);
  }
  deduped.sort((a, b) => {
    const aa = a.split(".").map((n) => Number(n));
    const bb = b.split(".").map((n) => Number(n));
    const n = Math.max(aa.length, bb.length);
    for (let i = 0; i < n; i += 1) {
      const av = Number.isFinite(aa[i]) ? aa[i] : -1;
      const bv = Number.isFinite(bb[i]) ? bb[i] : -1;
      if (av !== bv) return av - bv;
    }
    return 0;
  });
  return deduped;
};

const normalizeSourceIdList = (raw: string[] | undefined | null, limit = 20) => {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw || []) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
    if (deduped.length >= limit) break;
  }
  return deduped;
};

const normalizeAutofillNameCandidates = (
  raw: string[] | undefined | null,
  fallbackName: string,
  currentName?: string,
  limit = 5,
) => {
  const list: string[] = [];
  const seen = new Set<string>();
  const current = String(currentName || "").trim().toLowerCase();
  const source = Array.isArray(raw) ? raw : [];
  for (const item of [...source, fallbackName]) {
    const name = String(item || "").trim();
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
    if (list.length >= limit) break;
  }
  if (list.length === 0 && String(fallbackName || "").trim()) {
    list.push(String(fallbackName || "").trim());
  }
  const sorted = list.slice().sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const aIsCurrent = current.length > 0 && al === current;
    const bIsCurrent = current.length > 0 && bl === current;
    if (aIsCurrent === bIsCurrent) return 0;
    return aIsCurrent ? 1 : -1;
  });
  return sorted.slice(0, limit);
};

const formatBootstrapStatLine = (stats?: BootstrapStats, label = "新增/更新") => {
  if (!stats) return "";
  const parts = [
    `大纲 ${stats.outline ?? 0}`,
    `角色 ${stats.characters ?? 0}`,
    `世界观 ${stats.worldbuilding ?? 0}`,
  ];
  if ((stats.chapters ?? 0) > 0) parts.push(`章节 ${stats.chapters ?? 0}`);
  return `${label} ${parts.join("，")}`;
};

const mergeBootstrapStats = (base?: BootstrapStats, incoming?: BootstrapStats): BootstrapStats => ({
  outline: Number(base?.outline || 0) + Number(incoming?.outline || 0),
  characters: Number(base?.characters || 0) + Number(incoming?.characters || 0),
  worldbuilding: Number(base?.worldbuilding || 0) + Number(incoming?.worldbuilding || 0),
  chapters: Number(base?.chapters || 0) + Number(incoming?.chapters || 0),
});

const isOtherLikeOption = (opt?: BrainstormQuestionOption) => {
  if (!opt) return false;
  const label = String(opt.label || "").toLowerCase();
  const value = String(opt.value || "").toLowerCase();
  return value === OTHER_OPTION_VALUE || label.includes("其他") || value.includes("other");
};

const isAiDecideLikeOption = (opt?: BrainstormQuestionOption) => {
  if (!opt) return false;
  const label = String(opt.label || "").toLowerCase().replace(/\s+/g, "");
  const value = String(opt.value || "").toLowerCase().replace(/\s+/g, "");
  return (
    value === AI_DECIDE_OPTION_VALUE ||
    label.includes("交给ai决定") ||
    value.includes("交给ai决定") ||
    label.includes("aidecide") ||
    value.includes("aidecide")
  );
};

const normalizeQuestionOptions = (raw: BrainstormQuestionOption[]) => {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = list.map((opt) => {
    if (isAiDecideLikeOption(opt)) {
      return { label: AI_DECIDE_OPTION_LABEL, value: AI_DECIDE_OPTION_VALUE };
    }
    if (isOtherLikeOption(opt)) {
      return { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_VALUE };
    }
    return {
      label: String(opt?.label || "").trim(),
      value: String(opt?.value || opt?.label || "").trim(),
    };
  }).filter((opt) => opt.label && opt.value);

  const deduped: BrainstormQuestionOption[] = [];
  const seen = new Set<string>();
  for (const opt of normalized) {
    const key = opt.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(opt);
  }
  return deduped;
};

const optionSignature = (options: BrainstormQuestionOption[]) => {
  const values = (options || [])
    .map((opt) => String(opt?.value || "").trim().toLowerCase())
    .filter((v) => v.length > 0)
    .sort();
  return values.join("|");
};

export default function PlanningStudio() {
  const navigate = useNavigate();
  const { currentProject, setCurrentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [brainstormMessages, setBrainstormMessages] = useState<BrainstormMsg[]>([]);
  const [brainstormInput, setBrainstormInput] = useState("");
  const [brainstorming, setBrainstorming] = useState(false);
  const [brainstormQuestions, setBrainstormQuestions] = useState<BrainstormQuestion[]>([]);
  const [brainstormOptionHistory, setBrainstormOptionHistory] = useState<BrainstormOptionHistoryItem[]>([]);
  const [brainstormAnswers, setBrainstormAnswers] = useState<Record<string, string | string[]>>({});
  const [brainstormOtherAnswers, setBrainstormOtherAnswers] = useState<Record<string, string>>({});
  const [optionRefreshing, setOptionRefreshing] = useState<Record<string, boolean>>({});
  const [brainstormMode, setBrainstormMode] = useState<BrainstormMode>("fast");
  const [brainstormReadyForBible, setBrainstormReadyForBible] = useState(false);
  const [activePanel, setActivePanel] = useState<StudioPanel>("planning");

  const [bibleText, setBibleText] = useState("");
  const [bibleDraft, setBibleDraft] = useState("");
  const [bibleVersion, setBibleVersion] = useState<number | null>(null);
  const [loadingBible, setLoadingBible] = useState(false);
  const [generatingBible, setGeneratingBible] = useState(false);
  const [savingBible, setSavingBible] = useState(false);
  const [reviseInstruction, setReviseInstruction] = useState("");
  const [reviseLockedSectionsText, setReviseLockedSectionsText] = useState("");
  const [revisingBible, setRevisingBible] = useState(false);
  const [revisePreview, setRevisePreview] = useState<RevisePreview | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapForceRewrite, setBootstrapForceRewrite] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapApiResponse | null>(null);

  const [autofillSuggest, setAutofillSuggest] = useState<ProjectAutofillSuggestion | null>(null);
  const [autofillSelectedNameCandidate, setAutofillSelectedNameCandidate] = useState("");
  const [autofillApplyFields, setAutofillApplyFields] = useState<AutofillApplyFields>({ ...DEFAULT_AUTOFILL_APPLY_FIELDS });
  const [autofilling, setAutofilling] = useState(false);
  const [autofillExpanded, setAutofillExpanded] = useState(false);
  const [mainContentLockedHeight, setMainContentLockedHeight] = useState<number | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceItem[]>([]);
  const [activeProfile, setActiveProfile] = useState<ActiveProfileInfo | null>(null);
  const [selectedKnowledgeSourceIds, setSelectedKnowledgeSourceIds] = useState<string[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [profileCount, setProfileCount] = useState(0);
  const [planningDropActive, setPlanningDropActive] = useState(false);
  const [planningDropImporting, setPlanningDropImporting] = useState(false);
  const autofillCheckboxStyle = { width: 14, height: 14, margin: 0, padding: 0, accentColor: "var(--accent-gold)" } as const;
  const brainstormScrollRef = useRef<HTMLDivElement | null>(null);
  const planningImportInputRef = useRef<HTMLInputElement | null>(null);
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const latestPlanningStateRef = useRef<PlanningStudioCache | null>(null);
  const serverSyncTimerRef = useRef<number | null>(null);
  const [planningLocalReady, setPlanningLocalReady] = useState(false);
  const [planningStateHydrated, setPlanningStateHydrated] = useState(false);

  const parseApiError = (err: unknown, fallback: string) => {
    const raw = err instanceof Error ? err.message : String(err || "");
    const payload = raw.replace(/^API\s+\d+\s*:\s*/i, "").trim();
    if (!payload) return fallback;
    try {
      const parsed = JSON.parse(payload) as { detail?: unknown; message?: unknown };
      if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // ignore JSON parse failure
    }
    return payload;
  };

  const planningStateKey = pid ? `planning-studio-state-${pid}` : "";
  const hasSavedBible = Boolean(String(bibleText || "").trim());
  const bibleDirty = normalizeTextForCompare(bibleDraft) !== normalizeTextForCompare(bibleText);
  const knowledgeSourceMap = new Map(knowledgeSources.map((item) => [item.id, item]));

  const detectReadyForBible = (reply: string, questions: BrainstormQuestion[]) => {
    if (questions.length > 0) return false;
    const text = String(reply || "").trim();
    if (!text) return false;
    const patterns = [
      /可(以)?进入.{0,10}(小说)?圣经(生成|阶段)?/,
      /可(以)?生成(小说)?圣经/,
      /下一步.{0,8}生成(小说)?圣经/,
      /建议.{0,8}生成(小说)?圣经/,
    ];
    return patterns.some((p) => p.test(text));
  };

  const loadStoryBible = async (options?: { preserveDraft?: boolean }) => {
    if (!pid) return;
    const preserveDraft = options?.preserveDraft !== false;
    const keepLocalDraft = preserveDraft && bibleDirty;
    setLoadingBible(true);
    try {
      const data = await api<StoryBibleApiResponse | null>(`/api/pipeline/bible/latest?project_id=${pid}`);
      if (data) {
        const serverContent = data.content || "";
        setBibleVersion(data.version);
        setBibleText(serverContent);
        if (!keepLocalDraft) {
          setBibleDraft(serverContent);
        }
        setRevisePreview(null);
      } else {
        setBibleVersion(null);
        setBibleText("");
        if (!keepLocalDraft) {
          setBibleDraft("");
        }
        setRevisePreview(null);
      }
    } catch {
      // ignore
    } finally {
      setLoadingBible(false);
    }
  };

  const loadCachedPlanningState = (projectId: string): PlanningStudioCache | null => {
    const inMemory = planningStudioMemoryCache.get(projectId);
    if (inMemory && (inMemory.version === PLANNING_STUDIO_CACHE_VERSION || inMemory.version === 1)) {
      return inMemory;
    }
    const key = `planning-studio-state-${projectId}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PlanningStudioCache;
      if (!parsed || (parsed.version !== PLANNING_STUDIO_CACHE_VERSION && parsed.version !== 1)) return null;
      planningStudioMemoryCache.set(projectId, parsed);
      return parsed;
    } catch {
      return inMemory ?? null;
    }
  };

  const applyPlanningStudioState = (cached: PlanningStudioCache, fallbackMode: BrainstormMode) => {
    if (Array.isArray(cached.brainstormMessages)) setBrainstormMessages(cached.brainstormMessages.slice(-60));
    if (typeof cached.brainstormInput === "string") setBrainstormInput(cached.brainstormInput);
    if (Array.isArray(cached.brainstormQuestions)) setBrainstormQuestions(cached.brainstormQuestions);
    if (Array.isArray(cached.brainstormOptionHistory)) setBrainstormOptionHistory(cached.brainstormOptionHistory.slice(-80));
    if (cached.brainstormAnswers && typeof cached.brainstormAnswers === "object") setBrainstormAnswers(cached.brainstormAnswers);
    if (cached.brainstormOtherAnswers && typeof cached.brainstormOtherAnswers === "object") setBrainstormOtherAnswers(cached.brainstormOtherAnswers);
    if (typeof cached.brainstormReadyForBible === "boolean") setBrainstormReadyForBible(cached.brainstormReadyForBible);
    if (cached.brainstormMode === "fast" || cached.brainstormMode === "standard" || cached.brainstormMode === "deep") {
      setBrainstormMode(cached.brainstormMode);
    } else {
      setBrainstormMode(fallbackMode);
    }
    if (cached.activePanel === "planning" || cached.activePanel === "bible") {
      setActivePanel(cached.activePanel);
    } else {
      setActivePanel("planning");
    }
    if (typeof cached.bibleText === "string") setBibleText(cached.bibleText);
    if (typeof cached.bibleDraft === "string") setBibleDraft(cached.bibleDraft);
    if (typeof cached.bibleVersion === "number" || cached.bibleVersion === null) setBibleVersion(cached.bibleVersion);
    setSelectedKnowledgeSourceIds(normalizeSourceIdList(cached.selectedKnowledgeSourceIds || []));
  };

  const loadServerPlanningState = async (projectId: string) => {
    try {
      return await api<PlanningStateApiResponse | null>(`/api/pipeline/planning-state?project_id=${projectId}`);
    } catch {
      return null;
    }
  };

  const refreshKnowledgeContext = async () => {
    if (!pid) return;
    try {
      const [sources, profiles, active] = await Promise.all([
        api<KnowledgeSourceItem[]>(`/api/knowledge/sources?project_id=${pid}`),
        api<any[]>(`/api/knowledge/profiles?project_id=${pid}`),
        api<ActiveProfileInfo | null>(`/api/knowledge/profile/active?project_id=${pid}`),
      ]);
      const sourceList = Array.isArray(sources) ? sources : [];
      setKnowledgeSources(sourceList);
      setSourceCount(sourceList.length);
      setProfileCount((profiles || []).length);
      setActiveProfile(active || null);
      setSelectedKnowledgeSourceIds((prev) => {
        const existing = new Set(sourceList.map((x) => x.id));
        return normalizeSourceIdList(prev.filter((id) => existing.has(id)));
      });
    } catch {
      setKnowledgeSources([]);
      setSourceCount(0);
      setProfileCount(0);
      setActiveProfile(null);
      setSelectedKnowledgeSourceIds([]);
    }
  };

  useEffect(() => {
    setPlanningLocalReady(false);
    setPlanningStateHydrated(false);
    setBootstrapResult(null);
    setReviseInstruction("");
    setReviseLockedSectionsText("");
    setRevisePreview(null);
    setBootstrapForceRewrite(false);
    setAutofillSuggest(null);
    setAutofillSelectedNameCandidate("");
    setAutofillApplyFields({ ...DEFAULT_AUTOFILL_APPLY_FIELDS });
    setAutofillExpanded(false);
    setMainContentLockedHeight(null);
    setKnowledgeSources([]);
    setActiveProfile(null);
    setSelectedKnowledgeSourceIds([]);
    setSourceCount(0);
    setProfileCount(0);
    setPlanningDropActive(false);
    setPlanningDropImporting(false);
    const resetPersistedState = (mode: BrainstormMode) => {
      setBrainstormMessages([]);
      setBrainstormInput("");
      setBrainstormQuestions([]);
      setBrainstormOptionHistory([]);
      setBrainstormAnswers({});
      setBrainstormOtherAnswers({});
      setOptionRefreshing({});
      setBrainstormMode(mode);
      setBrainstormReadyForBible(false);
      setActivePanel("planning");
      setBibleText("");
      setBibleDraft("");
      setBibleVersion(null);
      setSelectedKnowledgeSourceIds([]);
    };

    if (!pid) {
      resetPersistedState("fast");
      setPlanningLocalReady(true);
      setPlanningStateHydrated(true);
      return;
    }

    let savedMode: BrainstormMode = "fast";
    try {
      const modeRaw = localStorage.getItem(`planning-brainstorm-mode-${pid}`);
      if (modeRaw === "standard" || modeRaw === "deep" || modeRaw === "fast") {
        savedMode = modeRaw;
      }
    } catch {
      // ignore
    }

    let shouldRefreshBibleFromServer = true;
    const cached = loadCachedPlanningState(pid);
    if (cached) {
      applyPlanningStudioState(cached, savedMode);
      const cachedDirty = normalizeTextForCompare(cached.bibleDraft || "") !== normalizeTextForCompare(cached.bibleText || "");
      shouldRefreshBibleFromServer = !cachedDirty;
    } else {
      resetPersistedState(savedMode);
    }

    if (shouldRefreshBibleFromServer) {
      void loadStoryBible({ preserveDraft: true });
    }
    void refreshKnowledgeContext();
    setPlanningLocalReady(true);

    let cancelled = false;
    void (async () => {
      const remote = await loadServerPlanningState(pid);
      if (cancelled || !remote || !remote.state) {
        if (!cancelled) setPlanningStateHydrated(true);
        return;
      }
      const remoteState = remote.state;
      const remoteUpdatedAt = Date.parse(remote.updated_at || "");
      const localState = loadCachedPlanningState(pid);
      const localUpdatedAt = Number(localState?.updatedAt || 0);
      const shouldApplyRemote = (
        !localState ||
        (Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > localUpdatedAt)
      );
      if (shouldApplyRemote) {
        const patchedRemote: PlanningStudioCache = {
          ...remoteState,
          version: PLANNING_STUDIO_CACHE_VERSION,
          updatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : Date.now(),
        };
        planningStudioMemoryCache.set(pid, patchedRemote);
        try {
          localStorage.setItem(`planning-studio-state-${pid}`, JSON.stringify(patchedRemote));
        } catch {
          // ignore storage errors
        }
        applyPlanningStudioState(patchedRemote, savedMode);
      }
      if (!cancelled) setPlanningStateHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  useEffect(() => {
    const el = brainstormScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [brainstormMessages, brainstorming]);

  useEffect(() => {
    if (!knowledgeSources.length) return;
    const allowed = new Set(knowledgeSources.map((x) => x.id));
    setSelectedKnowledgeSourceIds((prev) => {
      const next = normalizeSourceIdList(prev.filter((id) => allowed.has(id)));
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev;
      return next;
    });
  }, [knowledgeSources]);

  useEffect(() => {
    if (!pid || !planningStateKey) return;
    if (!planningLocalReady) return;
    const nowTs = Date.now();
    const payload: PlanningStudioCache = {
      version: PLANNING_STUDIO_CACHE_VERSION,
      brainstormMessages: brainstormMessages.slice(-60),
      brainstormInput,
      brainstormQuestions,
      brainstormOptionHistory: brainstormOptionHistory.slice(-80),
      brainstormAnswers,
      brainstormOtherAnswers,
      brainstormReadyForBible,
      brainstormMode,
      activePanel,
      bibleText,
      bibleDraft,
      bibleVersion,
      selectedKnowledgeSourceIds: normalizeSourceIdList(selectedKnowledgeSourceIds),
      updatedAt: nowTs,
    };
    latestPlanningStateRef.current = payload;
    planningStudioMemoryCache.set(pid, payload);
    try {
      localStorage.setItem(planningStateKey, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
    if (!planningStateHydrated) return;
    if (serverSyncTimerRef.current) {
      window.clearTimeout(serverSyncTimerRef.current);
    }
    serverSyncTimerRef.current = window.setTimeout(() => {
      serverSyncTimerRef.current = null;
      const snapshot = latestPlanningStateRef.current;
      if (!snapshot || !pid) return;
      void api("/api/pipeline/planning-state", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          state: snapshot,
        }),
      }).catch(() => {
        // ignore network/storage sync failures
      });
    }, 600);
  }, [
    pid,
    planningStateKey,
    planningLocalReady,
    planningStateHydrated,
    brainstormMessages,
    brainstormInput,
    brainstormQuestions,
    brainstormOptionHistory,
    brainstormAnswers,
    brainstormOtherAnswers,
    brainstormReadyForBible,
    brainstormMode,
    activePanel,
    bibleText,
    bibleDraft,
    bibleVersion,
    selectedKnowledgeSourceIds,
    api,
  ]);

  useEffect(() => {
    return () => {
      if (serverSyncTimerRef.current) {
        window.clearTimeout(serverSyncTimerRef.current);
        serverSyncTimerRef.current = null;
      }
      if (!pid || !planningStateKey) return;
      const snapshot = latestPlanningStateRef.current;
      if (!snapshot) return;
      planningStudioMemoryCache.set(pid, snapshot);
      try {
        localStorage.setItem(planningStateKey, JSON.stringify(snapshot));
      } catch {
        // ignore storage errors
      }
    };
  }, [pid, planningStateKey]);

  useEffect(() => {
    if (autofillExpanded) return;
    const panel = mainContentRef.current;
    if (!panel) return;
    const update = () => {
      const h = Math.max(380, Math.round(panel.getBoundingClientRect().height));
      setMainContentLockedHeight(h);
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(panel);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [autofillExpanded, activePanel, pid]);

  const toggleAutofillExpanded = () => {
    setAutofillExpanded((prev) => {
      if (!prev) {
        const panel = mainContentRef.current;
        if (panel) {
          const h = Math.max(380, Math.round(panel.getBoundingClientRect().height));
          setMainContentLockedHeight(h);
        }
      } else {
        setMainContentLockedHeight(null);
      }
      return !prev;
    });
  };

  const applyBrainstormMode = (mode: BrainstormMode) => {
    setBrainstormMode(mode);
    if (!pid) return;
    try {
      localStorage.setItem(`planning-brainstorm-mode-${pid}`, mode);
    } catch {
      // ignore
    }
  };

  const clearBrainstormConversation = () => {
    if (brainstorming) return;
    setBrainstormMessages([]);
    setBrainstormInput("");
    setBrainstormQuestions([]);
    setBrainstormOptionHistory([]);
    setBrainstormAnswers({});
    setBrainstormOtherAnswers({});
    setOptionRefreshing({});
    setBrainstormReadyForBible(false);
    addToast("success", "已清空立项对话历史");
  };

  const addSelectedKnowledgeRefs = (sourceIds: string[]) => {
    const nextIds = normalizeSourceIdList(sourceIds);
    if (!nextIds.length) return;
    setSelectedKnowledgeSourceIds((prev) => normalizeSourceIdList([...prev, ...nextIds]));
  };

  const importFilesToKnowledge = async (files: FileList | null) => {
    if (!pid || !files || files.length === 0) return;
    setPlanningDropImporting(true);
    const importedIds: string[] = [];
    let ok = 0;
    let fail = 0;
    const failReasons: string[] = [];
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("project_id", pid);
        fd.append("title", "");
        fd.append("collection_id", "");
        fd.append("reference_type", "general");
        fd.append("file", file);
        try {
          const res = await api<{ source_id?: string }>("/api/knowledge/import-file", {
            method: "POST",
            body: fd,
          });
          if (res?.source_id) importedIds.push(String(res.source_id));
          ok += 1;
        } catch (err) {
          fail += 1;
          failReasons.push(parseApiError(err, "导入失败"));
        }
      }
      await refreshKnowledgeContext();
      if (importedIds.length > 0) addSelectedKnowledgeRefs(importedIds);
      if (ok > 0) addToast("success", `已导入 ${ok} 个文件并加入立项引用`);
      if (fail > 0) {
        const reason = Array.from(new Set(failReasons)).filter(Boolean)[0] || "未知错误";
        addToast("error", `${fail} 个文件导入失败：${reason}`);
      }
    } finally {
      setPlanningDropImporting(false);
    }
  };

  const openPlanningFileImport = () => {
    if (planningDropImporting) return;
    planningImportInputRef.current?.click();
  };

  const onPlanningFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    void importFilesToKnowledge(files);
    e.currentTarget.value = "";
  };

  const rememberOptionHistory = (questions: BrainstormQuestion[]) => {
    const entries = (questions || [])
      .filter((q) => q.qtype === "single" || q.qtype === "multi")
      .map((q) => {
        const options = normalizeQuestionOptions(q.options || []).filter(
          (opt) => opt.value !== OTHER_OPTION_VALUE && opt.value !== AI_DECIDE_OPTION_VALUE
        );
        return {
          title: String(q.title || "").trim(),
          qtype: q.qtype,
          options,
        };
      })
      .filter((item) => item.title && item.options.length > 0);

    if (!entries.length) return;
    const now = Date.now();
    setBrainstormOptionHistory((prev) => {
      const next = [...prev];
      const seen = new Set(prev.map((it) => it.signature));
      for (const item of entries) {
        const signature = `${item.title}::${item.qtype}::${item.options.map((opt) => opt.value).join("|")}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        next.push({
          title: item.title,
          qtype: item.qtype,
          options: item.options,
          signature,
          createdAt: now,
        });
      }
      return next.slice(-80);
    });
  };

  const parseKnowledgeDragPayload = (raw: string): PlanningKnowledgeDragPayload | null => {
    const text = String(raw || "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as Partial<PlanningKnowledgeDragPayload>;
      if (parsed.kind !== "knowledge_source") return null;
      const projectId = String(parsed.project_id || "").trim();
      const sourceId = String(parsed.source_id || "").trim();
      if (!projectId || !sourceId) return null;
      return {
        kind: "knowledge_source",
        project_id: projectId,
        source_id: sourceId,
        title: String(parsed.title || "").trim(),
        reference_type: (parsed.reference_type || "general") as KnowledgeReferenceType,
      };
    } catch {
      return null;
    }
  };

  const handlePlanningDropZoneDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!planningDropActive) setPlanningDropActive(true);
  };

  const handlePlanningDropZoneDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const nextTarget = e.relatedTarget as Node | null;
    if (nextTarget && e.currentTarget.contains(nextTarget)) return;
    setPlanningDropActive(false);
  };

  const handlePlanningDropZoneDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setPlanningDropActive(false);
    if (!pid) return;

    const knowledgePayload = parseKnowledgeDragPayload(e.dataTransfer.getData(KNOWLEDGE_SOURCE_DND_MIME))
      || parseKnowledgeDragPayload(e.dataTransfer.getData("text/x-sanhuoai-knowledge-source"))
      || parseKnowledgeDragPayload(e.dataTransfer.getData("application/json"))
      || parseKnowledgeDragPayload(e.dataTransfer.getData("text/plain"));
    if (knowledgePayload) {
      if (knowledgePayload.project_id !== pid) {
        addToast("warning", "只能拖入当前项目的知识文件。");
      } else {
        addSelectedKnowledgeRefs([knowledgePayload.source_id]);
        if (!knowledgeSourceMap.has(knowledgePayload.source_id)) {
          await refreshKnowledgeContext();
        }
        addToast("success", `已加入引用：${knowledgePayload.title || knowledgePayload.source_id}`);
      }
      return;
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await importFilesToKnowledge(e.dataTransfer.files);
      return;
    }
    addToast("warning", "未识别到可用的知识文件拖拽数据。");
  };

  const sendBrainstorm = async (overrideMessage?: string) => {
    if (!pid || brainstorming) return;
    const content = String(overrideMessage ?? brainstormInput).trim();
    if (!content) return;
    const userMsg: BrainstormMsg = { role: "user", content };
    const nextHistory = [...brainstormMessages, userMsg];
    setBrainstormMessages(nextHistory);
    if (!overrideMessage) setBrainstormInput("");
    setBrainstorming(true);
    setBrainstormQuestions([]);
    setBrainstormAnswers({});
    setBrainstormOtherAnswers({});
    setOptionRefreshing({});
    try {
      const res = await api<BrainstormApiResponse>("/api/pipeline/brainstorm", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          message: userMsg.content,
          // 细化阶段会持续多轮，保留更长窗口避免核心项被截断后重复追问。
          history: nextHistory.slice(-40),
          mode: brainstormMode,
          selected_source_ids: normalizeSourceIdList(selectedKnowledgeSourceIds),
        }),
      });
      setBrainstormMessages((prev) => [...prev, { role: "assistant", content: res.reply }]);
      const questions = Array.isArray(res.questions) ? res.questions : [];
      setBrainstormQuestions(questions);
      rememberOptionHistory(questions);
      setBrainstormAnswers({});
      setBrainstormOtherAnswers({});
      setOptionRefreshing({});
      const ready = Boolean(res.ready_for_bible) || detectReadyForBible(res.reply, questions);
      setBrainstormReadyForBible((prev) => {
        const nextReady = prev || ready;
        if (!prev && nextReady) {
          addToast("success", "立项信息已齐，可切换到「圣经面板」生成小说圣经。");
        }
        return nextReady;
      });
    } catch (e) {
      const reason = parseApiError(e, "对话服务暂不可用，请检查模型配置后重试。");
      setBrainstormMessages((prev) => [
        ...prev,
        { role: "assistant", content: `对话服务暂不可用：${reason}` },
      ]);
      setBrainstormQuestions([]);
      setBrainstormAnswers({});
      setBrainstormOtherAnswers({});
      setOptionRefreshing({});
    } finally {
      setBrainstorming(false);
    }
  };

  const setSingleAnswer = (questionId: string, value: string) => {
    setBrainstormAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const setOtherAnswer = (questionId: string, value: string) => {
    setBrainstormOtherAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const toggleMultiAnswer = (questionId: string, value: string, maxSelect?: number | null) => {
    setBrainstormAnswers((prev) => {
      const current = Array.isArray(prev[questionId]) ? [...(prev[questionId] as string[])] : [];
      const idx = current.indexOf(value);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        if (value === AI_DECIDE_OPTION_VALUE) {
          return { ...prev, [questionId]: [AI_DECIDE_OPTION_VALUE] };
        }
        const aiIdx = current.indexOf(AI_DECIDE_OPTION_VALUE);
        if (aiIdx >= 0) current.splice(aiIdx, 1);
        if (maxSelect && maxSelect > 0 && current.length >= maxSelect) {
          return prev;
        }
        current.push(value);
      }
      return { ...prev, [questionId]: current };
    });
  };

  const buildQuestionAnswerMessage = () => {
    const AI_DECIDE_TEXT = "交给AI决定（按题材与主线自动设定）";
    const resolveOptionText = (q: BrainstormQuestion, value: string) => {
      if (value === AI_DECIDE_OPTION_VALUE) return AI_DECIDE_TEXT;
      const found = normalizeQuestionOptions(q.options || []).find((opt) => opt.value === value);
      return (found?.label || value || "").trim();
    };

    const lines: string[] = ["【结构化回答】"];
    for (const q of brainstormQuestions) {
      const required = q.required !== false;
      const answer = brainstormAnswers[q.id];

      if (q.qtype === "multi") {
        const arr = Array.isArray(answer) ? answer : [];
        if (arr.includes(AI_DECIDE_OPTION_VALUE)) {
          lines.push(`- ${q.title}: ${AI_DECIDE_TEXT}`);
          continue;
        }
        const includesOther = arr.includes(OTHER_OPTION_VALUE);
        const otherText = (brainstormOtherAnswers[q.id] || "").trim();
        if (includesOther && !otherText) {
          addToast("warning", `请填写：${q.title} 的“其他”内容`);
          return "";
        }
        const resolved = arr
          .filter((item) => item !== OTHER_OPTION_VALUE)
          .map((item) => resolveOptionText(q, item));
        if (includesOther && otherText) resolved.push(otherText);
        if (required && resolved.length === 0) {
          addToast("warning", `请先回答：${q.title}`);
          return "";
        }
        lines.push(`- ${q.title}: ${resolved.length ? resolved.join("、") : "（暂不确定）"}`);
        continue;
      }

      let text = typeof answer === "string" ? answer.trim() : "";
      if (text === AI_DECIDE_OPTION_VALUE) {
        text = AI_DECIDE_TEXT;
      }
      if (text === OTHER_OPTION_VALUE) {
        const otherText = (brainstormOtherAnswers[q.id] || "").trim();
        if (!otherText) {
          addToast("warning", `请填写：${q.title} 的“其他”内容`);
          return "";
        }
        text = otherText;
      } else if (q.qtype === "single" && (q.options || []).length > 0) {
        text = resolveOptionText(q, text);
      }
      if (required && !text) {
        addToast("warning", `请先回答：${q.title}`);
        return "";
      }
      lines.push(`- ${q.title}: ${text || "（暂不确定）"}`);
    }
    return lines.join("\n");
  };

  const submitQuestionnaire = async () => {
    if (!brainstormQuestions.length || brainstorming) return;
    const message = buildQuestionAnswerMessage();
    if (!message) return;
    await sendBrainstorm(message);
  };

  const refreshQuestionOptions = async (question: BrainstormQuestion) => {
    if (!pid) return;
    if (question.qtype !== "single" && question.qtype !== "multi") return;
    if (optionRefreshing[question.id]) return;

    const cleaned = normalizeQuestionOptions(question.options || []).filter(
      (opt) => opt.value !== OTHER_OPTION_VALUE && opt.value !== AI_DECIDE_OPTION_VALUE
    );
    const previousSignature = optionSignature(cleaned);

    setOptionRefreshing((prev) => ({ ...prev, [question.id]: true }));
    try {
      const res = await api<BrainstormOptionRefreshApiResponse>("/api/pipeline/brainstorm/options/refresh", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          title: question.title,
          qtype: question.qtype,
          options: cleaned,
          history: brainstormMessages.slice(-16),
          mode: brainstormMode,
        }),
      });
      const nextOptions = normalizeQuestionOptions(Array.isArray(res.options) ? res.options : []).filter(
        (opt) => opt.value !== OTHER_OPTION_VALUE && opt.value !== AI_DECIDE_OPTION_VALUE
      );
      if (nextOptions.length < 2) {
        addToast("warning", "刷新失败：可用选项不足，请稍后重试");
        return;
      }
      const nextSignature = optionSignature(nextOptions);
      if (nextSignature === previousSignature) {
        addToast("warning", "这题暂时没有更多新选项了，可先选“其他”或“交给AI决定”继续");
        return;
      }
      setBrainstormQuestions((prev) => prev.map((q) => (
        q.id === question.id
          ? { ...q, options: nextOptions, qtype: question.qtype }
          : q
      )));
      rememberOptionHistory([{ ...question, options: nextOptions, qtype: question.qtype }]);
      setBrainstormAnswers((prev) => ({
        ...prev,
        [question.id]: question.qtype === "multi" ? [] : "",
      }));
      setBrainstormOtherAnswers((prev) => {
        if (!(question.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[question.id];
        return copy;
      });
      addToast("success", "选项已刷新");
    } catch (e) {
      addToast("error", parseApiError(e, "选项刷新失败，请稍后重试"));
    } finally {
      setOptionRefreshing((prev) => ({ ...prev, [question.id]: false }));
    }
  };

  const generateBible = async () => {
    if (!pid || generatingBible) return;
    setGeneratingBible(true);
    try {
      const res = await api<StoryBibleApiResponse>("/api/pipeline/bible/generate", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          brief: currentProject?.description || "",
          history: brainstormMessages.slice(-20),
          selected_source_ids: normalizeSourceIdList(selectedKnowledgeSourceIds),
          option_history: brainstormOptionHistory.slice(-40).map((item) => ({
            title: item.title,
            qtype: item.qtype,
            options: item.options,
            created_at: item.createdAt,
          })),
        }),
      });
      const nextContent = res.content || "";
      setBibleVersion(res.version);
      setBibleText(nextContent);
      setBibleDraft(nextContent);
      setBootstrapResult(null);
      setRevisePreview(null);
      addToast("success", `小说圣经已生成（v${res.version}）`);
    } catch (e) {
      addToast("error", parseApiError(e, "小说圣经生成失败，请检查模型配置"));
    } finally {
      setGeneratingBible(false);
    }
  };

  const saveBibleVersion = async () => {
    if (!pid || savingBible) return false;
    const content = String(bibleDraft || "").trim();
    if (!content) {
      addToast("warning", "小说圣经内容为空，无法保存");
      return false;
    }
    setSavingBible(true);
    try {
      const res = await api<StoryBibleApiResponse>("/api/pipeline/bible/save", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          content,
          brief: currentProject?.description || "",
        }),
      });
      const nextContent = res.content || "";
      setBibleVersion(res.version);
      setBibleText(nextContent);
      setBibleDraft(nextContent);
      setRevisePreview(null);
      addToast("success", `小说圣经已保存为 v${res.version}`);
      return true;
    } catch (e) {
      addToast("error", parseApiError(e, "小说圣经保存失败，请检查后重试"));
      return false;
    } finally {
      setSavingBible(false);
    }
  };

  const reviseBiblePreview = async () => {
    if (!pid || revisingBible) return;
    if (!hasSavedBible || !bibleVersion) {
      addToast("warning", "请先保存圣经版本，再使用 AI 对话改写。");
      return;
    }
    const instruction = String(reviseInstruction || "").trim();
    if (!instruction) {
      addToast("warning", "请先输入改写指令。");
      return;
    }
    const lockedSections = normalizeSectionIdList(reviseLockedSectionsText);
    setRevisingBible(true);
    try {
      const res = await api<ReviseBibleApiResponse>("/api/pipeline/bible/revise", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          instruction,
          base_version: bibleVersion,
          locked_sections: lockedSections,
        }),
      });

      const revised = String(res.revised_content || "").trim();
      if (!revised) {
        addToast("warning", "本次改写未返回有效内容，请调整指令后重试。");
        return;
      }
      const changedSections = Array.isArray(res.changed_sections) ? res.changed_sections.filter(Boolean) : [];
      const summary = String(res.change_summary || "").trim();

      setRevisePreview({
        baseVersion: Number(res.base_version || bibleVersion),
        baseContent: bibleText,
        revisedContent: revised,
        changedSections,
        changeSummary: summary,
        instruction,
        lockedSections,
      });
      addToast("success", changedSections.length > 0 ? `已生成改写预览（变更 ${changedSections.length} 处）` : "已生成改写预览");
    } catch (e) {
      addToast("error", parseApiError(e, "AI 改写预览失败，请检查模型配置后重试。"));
    } finally {
      setRevisingBible(false);
    }
  };

  const applyRevisePreviewToDraft = () => {
    if (!revisePreview) return;
    const baseLen = String(revisePreview.baseContent || "").trim().length;
    const revisedLen = String(revisePreview.revisedContent || "").trim().length;
    if (baseLen > 0 && revisedLen < Math.floor(baseLen * 0.55)) {
      addToast("error", "改写预览疑似异常（内容明显缩水），已阻止覆盖草稿。请先重试改写预览。");
      return;
    }
    setBibleDraft(revisePreview.revisedContent);
    addToast("success", "已将改写预览应用到草稿。可继续编辑并保存为新版本。");
  };

  const ensureReadyForBootstrap = async () => {
    if (!pid) return false;
    const hasSaved = Boolean(String(bibleText || "").trim());
    const hasDraft = Boolean(String(bibleDraft || "").trim());
    if (!hasSaved) {
      if (!hasDraft) {
        addToast("warning", "请先生成或填写小说圣经，再执行设定生成");
        return false;
      }
      const shouldSave = window.confirm("当前圣经尚未保存版本，是否先保存再执行设定生成？");
      if (!shouldSave) return false;
      return await saveBibleVersion();
    }
    if (!bibleDirty) return true;
    const saveFirst = window.confirm("检测到圣经有未保存修改。点击“确定”先保存再生成；点击“取消”将按已保存版本继续。");
    if (saveFirst) {
      return await saveBibleVersion();
    }
    addToast("warning", `将按已保存圣经 v${bibleVersion ?? "最新"} 执行生成`);
    return true;
  };

  const bootstrapByBible = async () => {
    if (!pid || bootstrapping) return;
    const ready = await ensureReadyForBootstrap();
    if (!ready) return;
    setBootstrapping(true);
    try {
      const scopes: Array<"characters" | "worldbuilding" | "outline"> = ["characters", "worldbuilding", "outline"];
      let mergedInserted: BootstrapStats = {};
      let mergedSkipped: BootstrapStats = {};
      const detailMessages: string[] = [];
      for (const scope of scopes) {
        const res = await api<BootstrapApiResponse>("/api/pipeline/bootstrap", {
          method: "POST",
          body: JSON.stringify({
            project_id: pid,
            scope,
            use_bible: true,
            force: bootstrapForceRewrite,
          }),
        });
        mergedInserted = mergeBootstrapStats(mergedInserted, res.inserted);
        mergedSkipped = mergeBootstrapStats(mergedSkipped, res.skipped);
        if (res.message) detailMessages.push(res.message);
      }
      const summary: BootstrapApiResponse = {
        message: detailMessages.join("\n"),
        inserted: mergedInserted,
        skipped: mergedSkipped,
      };
      setBootstrapResult(summary);
      addToast("success", "已按小说圣经生成角色/世界观/大纲（章节请到章节面板单独生成）");
    } catch (e) {
      addToast("error", parseApiError(e, "设定生成失败，请检查模型配置"));
    } finally {
      setBootstrapping(false);
    }
  };

  const suggestProjectAutofill = async () => {
    if (!pid || autofilling) return;
    setAutofilling(true);
    try {
      const res = await api<ProjectAutofillSuggestion>("/api/pipeline/project-autofill", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          history: brainstormMessages.slice(-20),
          bible: bibleDraft || bibleText || "",
        }),
      });
      const nameCandidates = normalizeAutofillNameCandidates(
        res.name_candidates,
        res.name,
        currentProject?.name || "",
      );
      const normalizedSuggest: ProjectAutofillSuggestion = {
        ...res,
        name_candidates: nameCandidates,
        name: nameCandidates[0] || res.name,
      };
      setAutofillSuggest(normalizedSuggest);
      setAutofillSelectedNameCandidate("");
      setAutofillApplyFields({ ...DEFAULT_AUTOFILL_APPLY_FIELDS });
      addToast("success", "已生成项目参数建议");
    } catch (e) {
      addToast("error", parseApiError(e, "自动填充建议生成失败，请检查模型配置"));
    } finally {
      setAutofilling(false);
    }
  };

  const applyProjectAutofill = async () => {
    if (!pid || !autofillSuggest) return;
    const selectedCount = Object.values(autofillApplyFields).filter(Boolean).length;
    if (selectedCount === 0) {
      addToast("warning", "请至少勾选一个要应用的字段");
      return;
    }

    try {
      const projectPayload: Record<string, string | number> = {};
      if (autofillApplyFields.name) {
        const selectedName = String(autofillSelectedNameCandidate || "").trim();
        if (!selectedName) {
          addToast("warning", "请先从书名候选中点选一个，再勾选覆盖名称。");
          return;
        }
        projectPayload.name = selectedName;
      }
      if (autofillApplyFields.genre) projectPayload.genre = autofillSuggest.genre;
      if (autofillApplyFields.description) projectPayload.description = autofillSuggest.description;
      if (autofillApplyFields.wordTarget) projectPayload.word_target = autofillSuggest.word_target;
      if (autofillApplyFields.structure) {
        projectPayload.structure = autofillSuggest.structure;
        projectPayload.custom_structure = autofillSuggest.structure === "自定义"
          ? String(autofillSuggest.custom_structure || "")
          : "";
      }
      if (autofillApplyFields.chapterWords) projectPayload.chapter_words = autofillSuggest.chapter_words;
      if (autofillApplyFields.priority) projectPayload.priority = autofillSuggest.priority;

      if (Object.keys(projectPayload).length > 0) {
        const updated = await api<any>(`/api/projects/${pid}`, {
          method: "PUT",
          body: JSON.stringify(projectPayload),
        });
        setCurrentProject(updated);
      }

      if (autofillApplyFields.structure || autofillApplyFields.chapterWords || autofillApplyFields.priority) {
        const key = `project-autofill-extra-${pid}`;
        let extra: { structure?: string; customStructure?: string; chapterWords?: number; priority?: string } = {};
        try {
          const raw = localStorage.getItem(key);
          if (raw) extra = JSON.parse(raw);
        } catch {
          extra = {};
        }
        if (autofillApplyFields.structure) {
          extra.structure = autofillSuggest.structure;
          extra.customStructure = autofillSuggest.structure === "自定义"
            ? String(autofillSuggest.custom_structure || "")
            : "";
        }
        if (autofillApplyFields.chapterWords) extra.chapterWords = autofillSuggest.chapter_words;
        if (autofillApplyFields.priority) extra.priority = autofillSuggest.priority;
        localStorage.setItem(key, JSON.stringify(extra));
      }

      addToast("success", `已应用 ${selectedCount} 项建议到项目设置`);
    } catch (e) {
      addToast("error", parseApiError(e, "应用建议失败"));
    }
  };

  const autofillNameCandidates = normalizeAutofillNameCandidates(
    autofillSuggest?.name_candidates,
    autofillSuggest?.name || "",
    currentProject?.name || "",
  );

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div
      style={{
        padding: 24,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: autofillExpanded ? "auto" : "100dvh",
        minHeight: "100dvh",
        overflowX: "hidden",
        overflowY: "visible",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>AI 立项工作台</h1>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
          独立主页面：先立项对话，再生成小说圣经，再自动回填项目设置。
        </p>
      </div>

      <section style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          提示：模型配置已迁移到「项目设置」统一管理。
        </div>
        <button
          onClick={() => navigate("/settings")}
          style={{
            padding: 0,
            borderRadius: 0,
            border: "none",
            background: "none",
            color: "var(--accent-gold)",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: 1.4,
            textDecoration: "underline",
          }}
        >
          去项目设置
        </button>
      </section>

      <section style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexShrink: 0 }}>
        <button
          onClick={() => setActivePanel("planning")}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid var(--bg-border)",
            background: activePanel === "planning" ? "var(--accent-gold-dim)" : "var(--bg-card)",
            color: activePanel === "planning" ? "var(--accent-gold)" : "var(--text-primary)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          立项面板
        </button>
        <button
          onClick={() => setActivePanel("bible")}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid var(--bg-border)",
            background: activePanel === "bible" ? "var(--accent-gold-dim)" : "var(--bg-card)",
            color: activePanel === "bible" ? "var(--accent-gold)" : "var(--text-primary)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          圣经面板
        </button>
        {activePanel === "planning" && brainstormReadyForBible && (
          <button
            onClick={() => setActivePanel("bible")}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid var(--accent-gold)",
              background: "var(--accent-gold-dim)",
              color: "var(--accent-gold)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            已可生成圣经，去圣经面板
          </button>
        )}
      </section>

      <div
        ref={mainContentRef}
        style={{
          flex: autofillExpanded ? "0 0 auto" : 1,
          minHeight: autofillExpanded ? 0 : 380,
          height: autofillExpanded && mainContentLockedHeight ? `${mainContentLockedHeight}px` : undefined,
          display: "flex",
          flexDirection: "column",
        }}
      >
      {activePanel === "planning" ? (
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
          <div
            onDragOver={handlePlanningDropZoneDragOver}
            onDragLeave={handlePlanningDropZoneDragLeave}
            onDrop={(e) => { void handlePlanningDropZoneDrop(e); }}
            style={{
              border: planningDropActive ? "1px solid var(--accent-gold)" : "1px solid var(--bg-border)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 0,
              height: "100%",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>立项对话</div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  padding: 2,
                  borderRadius: 999,
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-input)",
                  flexShrink: 0,
                }}
                title="立项提问模式：不确定可直接选“交给AI决定”"
              >
                {BRAINSTORM_MODE_OPTIONS.map((mode) => {
                  const active = brainstormMode === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => applyBrainstormMode(mode.value)}
                      title={mode.hint}
                      style={{
                        padding: "3px 8px",
                        borderRadius: 999,
                        border: "none",
                        background: active ? "var(--accent-gold-dim)" : "transparent",
                        color: active ? "var(--accent-gold)" : "var(--text-secondary)",
                        cursor: "pointer",
                        fontSize: 10,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {mode.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                规则包：
                {(activeProfile?.profile_id && Number(activeProfile?.enabled ?? 0) !== 0)
                  ? ` ${activeProfile?.name || "未命名规则包"}`
                  : " 未启用"}
                {"  ·  "}已选知识引用：{selectedKnowledgeSourceIds.length} / 20
                {planningDropActive ? "  ·  可松手导入/引用" : ""}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
                <input
                  ref={planningImportInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.json,.csv,.docx,.pdf"
                  style={{ display: "none" }}
                  onChange={onPlanningFileInputChange}
                />
                <button
                  type="button"
                  onClick={openPlanningFileImport}
                  disabled={planningDropImporting}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--bg-border)",
                    background: planningDropImporting ? "var(--bg-border)" : "var(--bg-card)",
                    color: planningDropImporting ? "var(--text-secondary)" : "var(--text-secondary)",
                    cursor: planningDropImporting ? "not-allowed" : "pointer",
                    fontSize: 11,
                  }}
                >
                  {planningDropImporting ? "导入中..." : "导入文件"}
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/knowledge-rules")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-card)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  导入规则包
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/knowledge-assets")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-card)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  资料库
                </button>
                <button
                  type="button"
                  onClick={clearBrainstormConversation}
                  disabled={brainstorming || (!brainstormMessages.length && !brainstormQuestions.length && !brainstormInput.trim())}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--bg-border)",
                    background: (brainstorming || (!brainstormMessages.length && !brainstormQuestions.length && !brainstormInput.trim()))
                      ? "var(--bg-border)"
                      : "var(--bg-card)",
                    color: (brainstorming || (!brainstormMessages.length && !brainstormQuestions.length && !brainstormInput.trim()))
                      ? "var(--text-secondary)"
                      : "var(--text-secondary)",
                    cursor: (brainstorming || (!brainstormMessages.length && !brainstormQuestions.length && !brainstormInput.trim()))
                      ? "not-allowed"
                      : "pointer",
                    fontSize: 11,
                  }}
                  title="清空左侧立项对话历史与当前待回答问题"
                >
                  清空对话
                </button>
              </div>
            </div>
            <div
              ref={brainstormScrollRef}
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                background: "var(--bg-input)",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                paddingRight: 8,
              }}
            >
              {brainstormMessages.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", opacity: 0.8 }}>
                  示例：我要写一部都市悬疑爱情，女主是调查记者，要求现实主义、不玄幻，结局必须BE。
                </div>
              ) : (
                brainstormMessages.map((m, i) => (
                  <div key={i} style={{
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "92%",
                    background: m.role === "user" ? "var(--accent-gold-dim)" : "var(--bg-card)",
                    border: m.role === "user" ? "1px solid var(--accent-gold-dim)" : "1px solid var(--bg-border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: "var(--text-primary)",
                    whiteSpace: "pre-wrap",
                  }}>
                    {m.content}
                  </div>
                ))
              )}
              {brainstorming && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                  <Loader2 size={12} className="animate-spin" /> AI 思考中...
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <textarea
                value={brainstormInput}
                onChange={(e) => setBrainstormInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendBrainstorm();
                  }
                }}
                placeholder="输入题材、主角、冲突、结局要求（Shift+Enter 换行）"
                style={{ ...inputStyle, height: 72, padding: "10px 12px", resize: "none", background: "var(--bg-input)" }}
              />
              <button
                onClick={() => void sendBrainstorm()}
                disabled={!brainstormInput.trim() || brainstorming}
                style={{
                  width: 42, height: 72, borderRadius: 8, border: "none",
                  background: (!brainstormInput.trim() || brainstorming) ? "var(--bg-border)" : "var(--accent-gold)",
                  color: (!brainstormInput.trim() || brainstorming) ? "var(--text-secondary)" : "#000",
                  cursor: (!brainstormInput.trim() || brainstorming) ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <Send size={14} />
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 0, height: "100%", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>可选项问答（可直接点选后发送）</div>
              {brainstormReadyForBible && (
                <span style={{ fontSize: 11, color: "var(--accent-gold)" }}>已满足生成圣经条件</span>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-input)", border: "1px solid var(--bg-border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {brainstormQuestions.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  当前无待回答问题。继续在左侧补充设定；当 AI 判定信息齐全时，会提示你切换到「圣经面板」。
                </div>
              ) : (
                brainstormQuestions.map((q) => {
                  const answer = brainstormAnswers[q.id];
                  const selectedSingle = typeof answer === "string" ? answer : "";
                  const selectedMulti = Array.isArray(answer) ? answer : [];
                  const baseOptions = normalizeQuestionOptions(q.options || []);
                  const shouldAppendOther = (q.qtype === "single" || q.qtype === "multi") && baseOptions.length > 0;
                  const hasOtherOption = baseOptions.some((opt) => opt.value === OTHER_OPTION_VALUE);
                  const hasAiDecideOption = baseOptions.some((opt) => opt.value === AI_DECIDE_OPTION_VALUE);
                  const withOther = shouldAppendOther && !hasOtherOption
                    ? [...baseOptions, { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_VALUE }]
                    : baseOptions;
                  const optionList = shouldAppendOther && !hasAiDecideOption
                    ? [...withOther, { label: AI_DECIDE_OPTION_LABEL, value: AI_DECIDE_OPTION_VALUE }]
                    : withOther;
                  const otherSelected = q.qtype === "single"
                    ? selectedSingle === OTHER_OPTION_VALUE
                    : selectedMulti.includes(OTHER_OPTION_VALUE);
                  const aiDecideSelected = q.qtype === "multi"
                    ? selectedMulti.includes(AI_DECIDE_OPTION_VALUE)
                    : selectedSingle === AI_DECIDE_OPTION_VALUE;
                  return (
                    <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                          <span>{q.title}</span>
                          {q.required !== false ? <span style={{ color: "var(--accent-gold)" }}>*</span> : null}
                        </div>
                        {(q.qtype === "single" || q.qtype === "multi") && optionList.length > 0 && (
                          <button
                            type="button"
                            onClick={() => void refreshQuestionOptions(q)}
                            disabled={Boolean(optionRefreshing[q.id]) || brainstorming}
                            style={{
                              padding: "3px 8px",
                              borderRadius: 999,
                              border: "1px solid var(--bg-border)",
                              background: (optionRefreshing[q.id] || brainstorming) ? "var(--bg-border)" : "var(--bg-card)",
                              color: (optionRefreshing[q.id] || brainstorming) ? "var(--text-secondary)" : "var(--text-secondary)",
                              cursor: (optionRefreshing[q.id] || brainstorming) ? "not-allowed" : "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              fontSize: 10,
                              flexShrink: 0,
                            }}
                            title="刷新该题的可选项"
                          >
                            {optionRefreshing[q.id] ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                            刷新选项
                          </button>
                        )}
                      </div>
                      {(q.qtype === "single" || q.qtype === "multi") && optionList.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {optionList.map((opt) => {
                            const active = q.qtype === "single" ? selectedSingle === opt.value : selectedMulti.includes(opt.value);
                            return (
                              <button
                                key={`${q.id}-${opt.value}`}
                                type="button"
                                onClick={() => {
                                  if (q.qtype === "single") {
                                    setSingleAnswer(q.id, opt.value);
                                  } else {
                                    toggleMultiAnswer(q.id, opt.value, q.max_select);
                                  }
                                }}
                                style={{
                                  padding: "5px 10px",
                                  borderRadius: 999,
                                  border: `1px solid ${active ? "var(--accent-gold)" : "var(--bg-border)"}`,
                                  background: active ? "var(--accent-gold-dim)" : "var(--bg)",
                                  color: active ? "var(--accent-gold)" : "var(--text-secondary)",
                                  cursor: "pointer",
                                  fontSize: 11,
                                }}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {(q.qtype === "single" || q.qtype === "multi") && (!q.options || q.options.length === 0) && (
                        <input
                          value={typeof answer === "string" && answer !== AI_DECIDE_OPTION_VALUE ? answer : ""}
                          onChange={(e) => setSingleAnswer(q.id, e.target.value)}
                          placeholder={q.placeholder || "请输入答案"}
                          style={{ ...inputStyle, height: 32, padding: "6px 10px" }}
                        />
                      )}
                      {(q.qtype === "single" || q.qtype === "multi") && (!q.options || q.options.length === 0) && (
                        <button
                          type="button"
                          onClick={() => setSingleAnswer(q.id, AI_DECIDE_OPTION_VALUE)}
                          style={{
                            alignSelf: "flex-start",
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: "1px solid var(--bg-border)",
                            background: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold-dim)" : "var(--bg-card)",
                            color: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold)" : "var(--text-secondary)",
                            cursor: "pointer",
                            fontSize: 11,
                          }}
                        >
                          {AI_DECIDE_OPTION_LABEL}
                        </button>
                      )}
                      {(q.qtype === "single" || q.qtype === "multi") && otherSelected && (
                        <input
                          value={brainstormOtherAnswers[q.id] || ""}
                          onChange={(e) => setOtherAnswer(q.id, e.target.value)}
                          placeholder="请输入其他内容"
                          style={{ ...inputStyle, height: 32, padding: "6px 10px" }}
                        />
                      )}
                      {q.qtype === "text" && (
                        <button
                          type="button"
                          onClick={() => setSingleAnswer(q.id, AI_DECIDE_OPTION_VALUE)}
                          style={{
                            alignSelf: "flex-start",
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: "1px solid var(--bg-border)",
                            background: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold-dim)" : "var(--bg-card)",
                            color: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold)" : "var(--text-secondary)",
                            cursor: "pointer",
                            fontSize: 11,
                          }}
                        >
                          {AI_DECIDE_OPTION_LABEL}
                        </button>
                      )}
                      {q.qtype === "number" && (
                        <button
                          type="button"
                          onClick={() => setSingleAnswer(q.id, AI_DECIDE_OPTION_VALUE)}
                          style={{
                            alignSelf: "flex-start",
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: "1px solid var(--bg-border)",
                            background: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold-dim)" : "var(--bg-card)",
                            color: selectedSingle === AI_DECIDE_OPTION_VALUE ? "var(--accent-gold)" : "var(--text-secondary)",
                            cursor: "pointer",
                            fontSize: 11,
                          }}
                        >
                          {AI_DECIDE_OPTION_LABEL}
                        </button>
                      )}
                      {aiDecideSelected && (
                        <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                          已交给 AI 自动决策该项。
                        </div>
                      )}
                      {q.qtype === "text" && (
                        <input
                          value={typeof answer === "string" && answer !== AI_DECIDE_OPTION_VALUE ? answer : ""}
                          onChange={(e) => setSingleAnswer(q.id, e.target.value)}
                          placeholder={q.placeholder || "请输入答案"}
                          style={{ ...inputStyle, height: 32, padding: "6px 10px" }}
                        />
                      )}
                      {q.qtype === "number" && (
                        <input
                          type="number"
                          value={typeof answer === "string" && answer !== AI_DECIDE_OPTION_VALUE ? answer : ""}
                          onChange={(e) => setSingleAnswer(q.id, e.target.value)}
                          placeholder={q.placeholder || "请输入数字"}
                          style={{ ...inputStyle, height: 32, padding: "6px 10px" }}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => setActivePanel("bible")}
                disabled={!brainstormReadyForBible}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--bg-border)",
                  background: brainstormReadyForBible ? "var(--bg-card)" : "var(--bg-border)",
                  color: brainstormReadyForBible ? "var(--text-primary)" : "var(--text-secondary)",
                  cursor: brainstormReadyForBible ? "pointer" : "not-allowed",
                  fontSize: 12,
                }}
              >
                去圣经面板
              </button>
              <button
                type="button"
                onClick={submitQuestionnaire}
                disabled={brainstorming || brainstormQuestions.length === 0}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--bg-border)",
                  background: (brainstorming || brainstormQuestions.length === 0) ? "var(--bg-border)" : "var(--accent-gold)",
                  color: (brainstorming || brainstormQuestions.length === 0) ? "var(--text-secondary)" : "#000",
                  cursor: (brainstorming || brainstormQuestions.length === 0) ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                发送已选答案
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            border: "1px solid var(--bg-border)",
            borderRadius: 10,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            height: "100%",
            overflowX: "hidden",
            overflowY: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
              <BookOpenText size={14} />
              小说圣经 {bibleVersion ? `(v${bibleVersion})` : "(未生成)"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", maxWidth: "100%", overflowX: "auto", paddingBottom: 2 }}>
              <button onClick={() => void loadStoryBible({ preserveDraft: true })} disabled={loadingBible} style={{ background: "none", border: "1px solid var(--bg-border)", color: "var(--text-secondary)", borderRadius: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "6px 10px" }}>
                {loadingBible ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
              </button>
              <button
                onClick={generateBible}
                disabled={generatingBible || savingBible}
                style={{
                  border: "1px solid var(--bg-border)", borderRadius: 8,
                  background: (generatingBible || savingBible) ? "var(--bg-border)" : "var(--accent-gold)",
                  color: (generatingBible || savingBible) ? "var(--text-secondary)" : "#000",
                  cursor: (generatingBible || savingBible) ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px",
                }}
              >
                {generatingBible ? <Loader2 size={13} className="animate-spin" /> : <BookOpenText size={13} />}
                {generatingBible ? "生成中..." : "生成小说圣经"}
              </button>
              <button
                onClick={() => void saveBibleVersion()}
                disabled={savingBible || !normalizeTextForCompare(bibleDraft) || !bibleDirty}
                style={{
                  border: "1px solid var(--bg-border)", borderRadius: 8,
                  background: (savingBible || !normalizeTextForCompare(bibleDraft) || !bibleDirty) ? "var(--bg-border)" : "var(--bg-card)",
                  color: (savingBible || !normalizeTextForCompare(bibleDraft) || !bibleDirty) ? "var(--text-secondary)" : "var(--text-primary)",
                  cursor: (savingBible || !normalizeTextForCompare(bibleDraft) || !bibleDirty) ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px",
                }}
              >
                {savingBible ? <Loader2 size={13} className="animate-spin" /> : <BookOpenText size={13} />}
                {savingBible ? "保存中..." : "保存圣经版本"}
              </button>
              <button
                onClick={() => setBibleDraft(bibleText)}
                disabled={!bibleDirty}
                style={{
                  border: "1px solid var(--bg-border)", borderRadius: 8,
                  background: !bibleDirty ? "var(--bg-border)" : "var(--bg-card)",
                  color: !bibleDirty ? "var(--text-secondary)" : "var(--text-primary)",
                  cursor: !bibleDirty ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px",
                }}
              >
                还原到已保存
              </button>
              <button
                onClick={bootstrapByBible}
                disabled={bootstrapping || savingBible || !hasSavedBible}
                style={{
                  border: "1px solid var(--bg-border)", borderRadius: 8,
                  background: (bootstrapping || savingBible || !hasSavedBible) ? "var(--bg-border)" : "var(--bg-card)",
                  color: (bootstrapping || savingBible || !hasSavedBible) ? "var(--text-secondary)" : "var(--text-primary)",
                  cursor: (bootstrapping || savingBible || !hasSavedBible) ? "not-allowed" : "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px",
                }}
              >
                {bootstrapping ? <Loader2 size={13} className="animate-spin" /> : <WandSparkles size={13} />}
                {bootstrapping ? "执行中..." : "生成角色/世界观/大纲"}
              </button>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  userSelect: "none",
                }}
                title="开启后会覆盖已有角色/世界观/大纲"
              >
                <input
                  type="checkbox"
                  checked={bootstrapForceRewrite}
                  onChange={(e) => setBootstrapForceRewrite(e.currentTarget.checked)}
                  disabled={bootstrapping || savingBible}
                  style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                />
                覆盖重生成
              </label>
            </div>
          </div>
          {!brainstormReadyForBible && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
              建议先在「立项面板」补齐题材/主角目标/主冲突/篇幅/结局倾向，再生成小说圣经。
            </div>
          )}
          <div style={{ fontSize: 12, color: bibleDirty ? "var(--accent-gold)" : "var(--text-secondary)", flexShrink: 0 }}>
            {hasSavedBible
              ? `用于设定生成的基线版本：v${bibleVersion ?? "最新"}${bibleDirty ? "（当前有未保存修改）" : "（已保存）"}`
              : "当前尚未保存圣经版本；请先生成或填写并保存。"}
          </div>
          {revisePreview && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-input)", border: "1px dashed var(--bg-border)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6, flexShrink: 0 }}>
              已生成改写预览（v{revisePreview.baseVersion}，变更：{revisePreview.changedSections.length > 0 ? revisePreview.changedSections.join("、") : "无或微调"}），结果已显示在右侧预览区。
            </div>
          )}
          {bootstrapResult && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-input)", border: "1px dashed var(--bg-border)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6, flexShrink: 0 }}>
              <div style={{ color: "var(--text-primary)" }}>{bootstrapResult.message}</div>
              <div>{formatBootstrapStatLine(bootstrapResult.inserted, "新增/更新") || "新增/更新 统计暂不可用"}</div>
              <div>{formatBootstrapStatLine(bootstrapResult.skipped, "跳过") || "跳过 统计暂不可用"}</div>
            </div>
          )}
          <div
            style={{
              flex: "1 1 auto",
              minHeight: 220,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)",
              gap: 10,
            }}
          >
            <div style={{ minHeight: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>左侧编辑区（当前草稿）</div>
              <textarea
                value={bibleDraft}
                onChange={(e) => setBibleDraft(e.target.value)}
                placeholder="尚未生成小说圣经。可先切回立项面板继续对话，或直接点击上方“生成小说圣经”。"
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: 240,
                  boxSizing: "border-box",
                  background: "var(--bg-input)",
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 12,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  color: "var(--text-primary)",
                  resize: "none",
                }}
              />
            </div>
            <div style={{ minHeight: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                右侧预览区（{revisePreview ? "AI改写预览" : (hasSavedBible ? `已保存版本 v${bibleVersion ?? "最新"}` : "当前草稿预览")}）
              </div>
              <textarea
                readOnly
                value={revisePreview?.revisedContent || (hasSavedBible ? bibleText : bibleDraft)}
                placeholder="右侧将显示已保存版本，或 AI 改写预览结果。"
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: 240,
                  boxSizing: "border-box",
                  background: "var(--bg)",
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 12,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  color: "var(--text-secondary)",
                  overflowY: "auto",
                  resize: "none",
                }}
              />
            </div>
          </div>
          <div
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--bg-border)",
              borderRadius: 8,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>对话改写（结果显示到上方右侧预览）</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                基于已保存圣经版本 v{bibleVersion ?? "—"} 进行局部改写
              </div>
            </div>
            <textarea
              value={reviseInstruction}
              onChange={(e) => setReviseInstruction(e.target.value)}
              placeholder="示例：把 2.3 改成第一人称叙事，保持结局不变。"
              style={{
                width: "100%",
                minHeight: 68,
                maxHeight: 120,
                boxSizing: "border-box",
                background: "var(--bg)",
                border: "1px solid var(--bg-border)",
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12,
                lineHeight: 1.6,
                color: "var(--text-primary)",
                resize: "vertical",
              }}
            />
            <input
              value={reviseLockedSectionsText}
              onChange={(e) => setReviseLockedSectionsText(e.target.value)}
              placeholder="可选：锁定段落编号（逗号/换行分隔），例如：2.3, 4.1"
              style={{ ...inputStyle, height: 32, padding: "6px 10px", background: "var(--bg)" }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={reviseBiblePreview}
                disabled={revisingBible || !hasSavedBible || !String(reviseInstruction || "").trim()}
                style={{
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  background: (revisingBible || !hasSavedBible || !String(reviseInstruction || "").trim()) ? "var(--bg-border)" : "var(--bg-card)",
                  color: (revisingBible || !hasSavedBible || !String(reviseInstruction || "").trim()) ? "var(--text-secondary)" : "var(--text-primary)",
                  cursor: (revisingBible || !hasSavedBible || !String(reviseInstruction || "").trim()) ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                }}
              >
                {revisingBible ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {revisingBible ? "改写中..." : "AI改写预览"}
              </button>
              <button
                type="button"
                onClick={applyRevisePreviewToDraft}
                disabled={!revisePreview}
                style={{
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  background: !revisePreview ? "var(--bg-border)" : "var(--accent-gold)",
                  color: !revisePreview ? "var(--text-secondary)" : "#000",
                  cursor: !revisePreview ? "not-allowed" : "pointer",
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                应用预览到草稿
              </button>
              <button
                type="button"
                onClick={() => setRevisePreview(null)}
                disabled={!revisePreview}
                style={{
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  background: "var(--bg-card)",
                  color: !revisePreview ? "var(--text-secondary)" : "var(--text-secondary)",
                  cursor: !revisePreview ? "not-allowed" : "pointer",
                  padding: "6px 12px",
                  fontSize: 12,
                }}
              >
                清空预览结果
              </button>
              <button
                type="button"
                onClick={() => {
                  setReviseInstruction("");
                  setReviseLockedSectionsText("");
                }}
                style={{
                  border: "1px solid var(--bg-border)",
                  borderRadius: 8,
                  background: "var(--bg-card)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: "6px 12px",
                  fontSize: 12,
                }}
              >
                清空改写输入
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr)", gap: 16, height: autofillExpanded ? "clamp(300px, 42vh, 560px)" : 148, flexShrink: 0, minHeight: 0 }}>
        <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 0, height: "100%", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>项目设置自动填充（AI 建议）</div>
            <button
              type="button"
              onClick={toggleAutofillExpanded}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {autofillExpanded ? "收起详情" : "展开详情"}
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            生成建议后可一键回填“项目名称/题材/简介/目标字数”，并同步写作参数到项目设置页。
          </div>
          {autofillExpanded && (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-input)", border: "1px solid var(--bg-border)", borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.6, color: "var(--text-primary)" }}>
              {!autofillSuggest ? (
                <div style={{ color: "var(--text-secondary)" }}>
                  还没有生成建议，点击下方“生成建议”即可。
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div><strong>推荐名称：</strong>{autofillSelectedNameCandidate || autofillSuggest.name}</div>
                  <div style={{ marginTop: 2, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>书名候选（点选后才会覆盖当前名称）</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {autofillNameCandidates.map((candidate) => {
                        const selected = autofillSelectedNameCandidate === candidate;
                        return (
                          <button
                            key={candidate}
                            type="button"
                            onClick={() => {
                              setAutofillSelectedNameCandidate(candidate);
                              setAutofillApplyFields((prev) => ({ ...prev, name: true }));
                            }}
                            style={{
                              border: selected ? "1px solid var(--accent-gold)" : "1px solid var(--bg-border)",
                              borderRadius: 999,
                              padding: "3px 10px",
                              background: selected ? "var(--accent-gold-dim)" : "var(--bg-card)",
                              color: selected ? "var(--accent-gold)" : "var(--text-primary)",
                              cursor: "pointer",
                              fontSize: 11,
                              lineHeight: 1.4,
                            }}
                          >
                            {candidate}
                          </button>
                        );
                      })}
                    </div>
                    {!autofillSelectedNameCandidate && (
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        当前未选候选名，应用时不会覆盖项目名称。
                      </div>
                    )}
                  </div>
                  <div><strong>题材：</strong>{autofillSuggest.genre}</div>
                  <div><strong>目标字数：</strong>{autofillSuggest.word_target}</div>
                  <div><strong>结构：</strong>{autofillSuggest.structure}</div>
                  {autofillSuggest.structure === "自定义" && autofillSuggest.custom_structure ? (
                    <div><strong>自定义结构说明：</strong>{autofillSuggest.custom_structure}</div>
                  ) : null}
                  <div><strong>每章字数：</strong>{autofillSuggest.chapter_words}</div>
                  <div><strong>优先级：</strong>{autofillSuggest.priority}</div>
                  <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>{autofillSuggest.reason || "无补充说明"}</div>

                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--bg-border)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 6 }}>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.name}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAutofillApplyFields((prev) => ({ ...prev, name: checked }));
                          if (!checked) return;
                          if (autofillSelectedNameCandidate) return;
                          if (autofillNameCandidates.length > 0) {
                            setAutofillSelectedNameCandidate(autofillNameCandidates[0]);
                          }
                        }}
                      />
                      覆盖名称（需先选候选）
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.genre}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, genre: e.target.checked }))}
                      />
                      覆盖题材
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.description}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, description: e.target.checked }))}
                      />
                      覆盖简介
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.wordTarget}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, wordTarget: e.target.checked }))}
                      />
                      覆盖目标字数
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.structure}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, structure: e.target.checked }))}
                      />
                      同步叙事结构
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.chapterWords}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, chapterWords: e.target.checked }))}
                      />
                      同步每章字数
                    </label>
                    <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        style={autofillCheckboxStyle}
                        checked={autofillApplyFields.priority}
                        onChange={(e) => setAutofillApplyFields((prev) => ({ ...prev, priority: e.target.checked }))}
                      />
                      同步优先级
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={suggestProjectAutofill}
              disabled={autofilling}
              style={{
                flex: 1, border: "1px solid var(--bg-border)", borderRadius: 8, background: "var(--bg-card)",
                color: "var(--text-primary)", cursor: autofilling ? "not-allowed" : "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 10px",
              }}
            >
              {autofilling ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {autofilling ? "生成中..." : "生成建议"}
            </button>
            <button
              onClick={applyProjectAutofill}
              disabled={!autofillSuggest || (autofillApplyFields.name && !autofillSelectedNameCandidate)}
              style={{
                flex: 1, border: "1px solid var(--bg-border)", borderRadius: 8,
                background: (!autofillSuggest || (autofillApplyFields.name && !autofillSelectedNameCandidate)) ? "var(--bg-border)" : "var(--accent-gold)",
                color: (!autofillSuggest || (autofillApplyFields.name && !autofillSelectedNameCandidate)) ? "var(--text-secondary)" : "#000",
                cursor: (!autofillSuggest || (autofillApplyFields.name && !autofillSelectedNameCandidate)) ? "not-allowed" : "pointer",
                padding: "8px 10px",
              }}
            >
              应用到项目设置
            </button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            当前状态：立项对话 {brainstormMessages.length} 条，知识文件 {sourceCount} 个，规则包 {profileCount} 个。
          </div>
        </div>
      </div>
    </div>
  );
}
