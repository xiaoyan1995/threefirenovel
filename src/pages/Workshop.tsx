import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Send, ChevronDown, BookOpen, Users, Eye, EyeOff, Globe, Check, Loader2, Wand2, Zap, LayoutList, BookOpenText, BugPlay, MessageSquare, Drama } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";
import { BeatSheetSidebar } from "../components/editor/BeatSheetSidebar";
import { EntityHighlighter } from "../components/editor/EntityHighlighter";
import { ConflictPanel } from "../components/editor/ConflictPanel";
import {
  ChapterRichEditor,
  type ChapterEditorHighlightRange,
  type ChapterRichEditorRef,
} from "../components/editor/ChapterRichEditor";
import { API_BASE } from "../config/api";
import { withLocalApiAuth } from "../lib/agentAuth";
import { useAgentModelDisplay } from "../hooks/useAgentModelDisplay";
import { emitBeatsUpdated } from "../utils/beatEvents";
import type { Chapter, ContextItem, ChapterBeat, NEREntity, NERResponse, ConflictItem, ConflictResponse } from "../types";

interface DebateMessage {
  id: string;
  agent: string;
  name: string;
  text: string;
  isComplete: boolean;
  type: "system" | "agent";
}

interface ActiveProfileState {
  project_id: string;
  profile_id: string | null;
  enabled: number;
  updated_at: string;
  name?: string;
  genre?: string;
  version?: number;
}

interface AITraceHit {
  pattern_id: string;
  pattern_name: string;
  evidence: string;
  confidence: number;
  advice: string;
  start?: number | null;
  end?: number | null;
}

interface AITracePreviewResult {
  chapter_id?: string | null;
  chapter_title?: string;
  risk_score: number;
  risk_level: "low" | "medium" | "high";
  total_hits: number;
  summary: string;
  hits: AITraceHit[];
}

interface DebateRewriteSuggestion {
  originalText: string;
  suggestedText: string;
  directorAdvice: string;
}

interface AssistantRewriteSuggestion {
  originalText: string;
  suggestedText: string;
  range: { start: number; end: number };
  createdAt: number;
  leftAnchor?: string;
  rightAnchor?: string;
}

type FirstChapterOpeningMode = "auto" | "protagonist" | "sidestory" | "cold_event" | "decoy";
type ConcreteFirstChapterOpeningMode = Exclude<FirstChapterOpeningMode, "auto">;

const REWRITE_SIMILARITY_THRESHOLD_KEY = "workshop.rewrite.similarity-threshold";
const DEFAULT_REWRITE_SIMILARITY_THRESHOLD = 0.86;
const FIRST_CHAPTER_OPENING_MODE_KEY = "workshop.first-chapter.opening-mode";
const FIRST_CHAPTER_ANCHOR_CHAPTER_KEY = "workshop.first-chapter.anchor-chapter";
const WORKSHOP_LAST_CHAPTER_KEY_PREFIX = "workshop.last-chapter.";
const ISSUE_HIGHLIGHTS_VISIBLE_KEY = "workshop.issue-highlights-visible";
const DEFAULT_FIRST_CHAPTER_OPENING_MODE: FirstChapterOpeningMode = "auto";
const DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER = 3;
const getDebateAgentColor = (agent: string) => {
  switch (agent) {
    case "reader": return "var(--status-active)";
    case "villain": return "#e91e63";
    case "architect": return "#ff9800";
    case "director": return "var(--accent-gold)";
    default: return "var(--text-secondary)";
  }
};

export default function Workshop() {
  const { currentProject, setCurrentProject, api } = useProject();
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapterId, setCurrentChapterId] = useState("");
  const [content, setContent] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [showChapterMenu, setShowChapterMenu] = useState(false);
  const [showGenerateMenu, setShowGenerateMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isGeneratingTrack, setIsGeneratingTrack] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showAiTraceModal, setShowAiTraceModal] = useState(false);
  const [aiTraceLoading, setAiTraceLoading] = useState(false);
  const [aiTraceRewriteLoading, setAiTraceRewriteLoading] = useState(false);
  const [aiTraceStrictness, setAiTraceStrictness] = useState<"low" | "medium" | "high">("medium");
  const [aiTraceScope, setAiTraceScope] = useState<"chapter" | "selection">("chapter");
  const [aiTraceSelectedText, setAiTraceSelectedText] = useState("");
  const [aiTraceResult, setAiTraceResult] = useState<AITracePreviewResult | null>(null);
  const [aiTraceResolvedMap, setAiTraceResolvedMap] = useState<Record<string, boolean>>({});
  const [aiTraceResultBaseRange, setAiTraceResultBaseRange] = useState<{ start: number; end: number } | null>(null);
  const [showIssueHighlights, setShowIssueHighlights] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const raw = String(window.localStorage.getItem(ISSUE_HIGHLIGHTS_VISIBLE_KEY) || "").trim();
    if (raw === "0") return false;
    if (raw === "1") return true;
    return true;
  });

  // UI Tabs
  const [activeTab, setActiveTab] = useState<'beats' | 'context' | 'conflict' | 'chat'>('beats');

  // NER / Read Mode State
  const [isViewMode, setIsViewMode] = useState(false);
  const [nerLoading, setNerLoading] = useState(false);
  const [nerEntities, setNerEntities] = useState<NEREntity[]>([]);

  // Conflict Detection State
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictSummary, setConflictSummary] = useState("");
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);

  // Auto-save refs
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef("");
  const chapterEditorRef = useRef<ChapterRichEditorRef | null>(null);
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const [chapterJumpInput, setChapterJumpInput] = useState("");
  const [isRewritingSelection, setIsRewritingSelection] = useState(false);
  const [assistantRewriteSuggestion, setAssistantRewriteSuggestion] = useState<AssistantRewriteSuggestion | null>(null);
  const [generatingConflictRewriteIndex, setGeneratingConflictRewriteIndex] = useState<number | null>(null);
  const [isGeneratingChapterConflictRewrite, setIsGeneratingChapterConflictRewrite] = useState(false);
  const [isApplyingAllConflictRewrites, setIsApplyingAllConflictRewrites] = useState(false);
  const [chapterTitleDraft, setChapterTitleDraft] = useState("");
  const [isSavingChapterTitle, setIsSavingChapterTitle] = useState(false);
  const chapterTitleMeasureRef = useRef<HTMLSpanElement | null>(null);
  const [chapterTitleInputWidth, setChapterTitleInputWidth] = useState<number>(260);
  const [rewriteSimilarityThreshold, setRewriteSimilarityThreshold] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_REWRITE_SIMILARITY_THRESHOLD;
    const raw = Number(window.localStorage.getItem(REWRITE_SIMILARITY_THRESHOLD_KEY));
    if (!Number.isFinite(raw)) return DEFAULT_REWRITE_SIMILARITY_THRESHOLD;
    return Math.min(1, Math.max(0, raw));
  });
  const [firstChapterOpeningMode, setFirstChapterOpeningMode] = useState<FirstChapterOpeningMode>(() => {
    if (typeof window === "undefined") return DEFAULT_FIRST_CHAPTER_OPENING_MODE;
    const raw = String(window.localStorage.getItem(FIRST_CHAPTER_OPENING_MODE_KEY) || "");
    if (raw === "auto" || raw === "protagonist" || raw === "sidestory" || raw === "cold_event" || raw === "decoy") {
      return raw;
    }
    return DEFAULT_FIRST_CHAPTER_OPENING_MODE;
  });
  const [firstChapterAnchorChapter, setFirstChapterAnchorChapter] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER;
    const raw = Number(window.localStorage.getItem(FIRST_CHAPTER_ANCHOR_CHAPTER_KEY));
    if (!Number.isFinite(raw)) return DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER;
    return Math.min(12, Math.max(2, Math.round(raw)));
  });

  // AI Chat State
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 底部面板模式切换：助手 vs 围读
  const [bottomMode, setBottomMode] = useState<'assistant' | 'debate'>('assistant');
  const [debateQuotedText, setDebateQuotedText] = useState("");
  const [debateMessages, setDebateMessages] = useState<DebateMessage[]>([]);
  const [debateTopic, setDebateTopic] = useState("");
  const [isDebating, setIsDebating] = useState(false);
  const [isGeneratingDebateSuggestion, setIsGeneratingDebateSuggestion] = useState(false);
  const [debateRewriteSuggestion, setDebateRewriteSuggestion] = useState<DebateRewriteSuggestion | null>(null);
  const [showAssistantActionHelp, setShowAssistantActionHelp] = useState(false);
  const debateEndRef = useRef<HTMLDivElement>(null);

  // context panel data
  const [ctxChars, setCtxChars] = useState<ContextItem[]>([]);
  const [ctxForeshadow, setCtxForeshadow] = useState<ContextItem[]>([]);
  const [ctxWorld, setCtxWorld] = useState<ContextItem[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLoadedOnce, setContextLoadedOnce] = useState(false);
  const [activeProfile, setActiveProfile] = useState<ActiveProfileState | null>(null);
  const contextLoadSeqRef = useRef(0);
  const lastContextLoadedAtRef = useRef(0);
  const lastActiveTabRef = useRef<'beats' | 'context' | 'conflict' | 'chat'>(activeTab);
  const { models: agentModels, resolveLabel: resolveAgentModelLabel } = useAgentModelDisplay();

  const pid = currentProject?.id;
  const requestedChapterId = String(searchParams.get("chapter_id") || "").trim();
  const getStoredLastChapterId = useCallback((projectId: string) => {
    if (typeof window === "undefined") return "";
    const cleanProjectId = String(projectId || "").trim();
    if (!cleanProjectId) return "";
    return String(window.localStorage.getItem(`${WORKSHOP_LAST_CHAPTER_KEY_PREFIX}${cleanProjectId}`) || "").trim();
  }, []);

  useEffect(() => {
    if (!pid) return;
    api<any>(`/api/projects/${pid}`)
      .then((latest) => {
        if (latest?.id) setCurrentProject(latest);
      })
      .catch(() => { });
  }, [pid, api, setCurrentProject]);

  const loadActiveProfile = useCallback(async () => {
    if (!pid) {
      setActiveProfile(null);
      return;
    }
    try {
      const profile = await api<ActiveProfileState | null>(`/api/knowledge/profile/active?project_id=${pid}`);
      setActiveProfile(profile);
    } catch {
      setActiveProfile(null);
    }
  }, [pid, api]);

  useEffect(() => {
    if (!pid) return;
    api<Chapter[]>(`/api/chapters/?project_id=${pid}`)
      .then((list) => {
        setChapters(list);
        if (list.length === 0) {
          setCurrentChapterId("");
          return;
        }
        if (requestedChapterId && list.some((c) => c.id === requestedChapterId)) {
          setCurrentChapterId(requestedChapterId);
          return;
        }
        const storedChapterId = getStoredLastChapterId(pid);
        if (storedChapterId && list.some((c) => c.id === storedChapterId)) {
          setCurrentChapterId(storedChapterId);
          return;
        }
        const firstByChapterNum = list
          .slice()
          .sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0))[0];
        setCurrentChapterId((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev;
          return firstByChapterNum?.id || list[0].id;
        });
      })
      .catch(() => { });
  }, [pid, api, requestedChapterId, getStoredLastChapterId]);

  useEffect(() => {
    if (!currentChapterId) return;
    const currentParam = String(searchParams.get("chapter_id") || "").trim();
    if (currentParam === currentChapterId) return;
    const next = new URLSearchParams(searchParams);
    next.set("chapter_id", currentChapterId);
    setSearchParams(next, { replace: true });
  }, [currentChapterId, searchParams, setSearchParams]);

  // load chapter content
  useEffect(() => {
    if (!currentChapterId) return;
    api<any>(`/api/chapters/${currentChapterId}`)
      .then((ch) => {
        const text = (ch.paragraphs || []).map((p: any) => p.content).join("\n");
        setContent(text);
        contentRef.current = text;
        setLastSaved(new Date());
      })
      .catch(() => { });
    setAiTraceResult(null);
    setAiTraceResolvedMap({});
    setAiTraceResultBaseRange(null);
    setAiTraceSelectedText("");
    setSelectedRange(null);
    setAssistantRewriteSuggestion(null);
    setAiTraceScope("chapter");
  }, [currentChapterId, api]);

  useEffect(() => {
    const current = chapters.find((c) => c.id === currentChapterId);
    setChapterTitleDraft(String(current?.title || ""));
  }, [chapters, currentChapterId]);

  useEffect(() => {
    const measureEl = chapterTitleMeasureRef.current;
    if (!measureEl) return;
    const raw = String(chapterTitleDraft || "").trim();
    measureEl.textContent = raw || "章节标题";
    const width = Math.ceil(measureEl.getBoundingClientRect().width) + 18;
    setChapterTitleInputWidth(Math.max(140, Math.min(760, width)));
  }, [chapterTitleDraft]);

  const fetchWithRetry = useCallback(async <T,>(path: string, retries = 1): Promise<T> => {
    let lastError: unknown;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await api<T>(path, { cache: "no-store" });
      } catch (error) {
        lastError = error;
        if (i < retries) {
          await new Promise((resolve) => setTimeout(resolve, 220 * (i + 1)));
        }
      }
    }
    throw lastError;
  }, [api]);

  const loadContextPanelData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!pid) {
      setCtxChars([]);
      setCtxForeshadow([]);
      setCtxWorld([]);
      setContextLoadedOnce(false);
      return;
    }
    const seq = contextLoadSeqRef.current + 1;
    contextLoadSeqRef.current = seq;
    setContextLoading(true);

    try {
      const [charsRes, foreshadowRes, worldRes] = await Promise.allSettled([
        fetchWithRetry<{ name: string; category: string }[]>(`/api/characters/?project_id=${pid}`),
        fetchWithRetry<{ name: string; status: string }[]>(`/api/content/foreshadowing?project_id=${pid}`),
        fetchWithRetry<{ title: string; category: string }[]>(`/api/content/worldbuilding?project_id=${pid}`),
      ]);
      if (seq !== contextLoadSeqRef.current) return;

      let successCount = 0;
      if (charsRes.status === "fulfilled") {
        successCount += 1;
        const chars = Array.isArray(charsRes.value) ? charsRes.value : [];
        setCtxChars(chars.map((c) => ({ label: c.name, detail: c.category })));
      } else {
        setCtxChars([]);
      }

      if (foreshadowRes.status === "fulfilled") {
        successCount += 1;
        const fs = Array.isArray(foreshadowRes.value) ? foreshadowRes.value : [];
        setCtxForeshadow(fs.map((f) => ({ label: f.name, detail: f.status })));
      } else {
        setCtxForeshadow([]);
      }

      if (worldRes.status === "fulfilled") {
        successCount += 1;
        const wb = Array.isArray(worldRes.value) ? worldRes.value : [];
        setCtxWorld(wb.map((w) => ({ label: w.title, detail: w.category })));
      } else {
        setCtxWorld([]);
      }

      setContextLoadedOnce(true);
      lastContextLoadedAtRef.current = Date.now();
      if (successCount === 0 && !opts?.silent) {
        addToast("error", "上下文面板加载失败，请稍后重试。");
      }
    } finally {
      if (seq === contextLoadSeqRef.current) {
        setContextLoading(false);
      }
    }
  }, [pid, fetchWithRetry, addToast]);

  useEffect(() => {
    void loadContextPanelData({ silent: true });
  }, [loadContextPanelData]);

  useEffect(() => {
    const prevTab = lastActiveTabRef.current;
    lastActiveTabRef.current = activeTab;
    if (activeTab !== "context" || prevTab === "context") return;
    const stale = Date.now() - lastContextLoadedAtRef.current > 45_000;
    if (!contextLoadedOnce || stale) {
      void loadContextPanelData({ silent: false });
    }
  }, [activeTab, contextLoadedOnce, loadContextPanelData]);

  useEffect(() => {
    loadActiveProfile();
  }, [loadActiveProfile]);

  useEffect(() => {
    const handler = () => {
      loadActiveProfile();
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [loadActiveProfile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      REWRITE_SIMILARITY_THRESHOLD_KEY,
      rewriteSimilarityThreshold.toFixed(2),
    );
  }, [rewriteSimilarityThreshold]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FIRST_CHAPTER_OPENING_MODE_KEY, firstChapterOpeningMode);
  }, [firstChapterOpeningMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FIRST_CHAPTER_ANCHOR_CHAPTER_KEY, String(firstChapterAnchorChapter));
  }, [firstChapterAnchorChapter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!pid) return;
    const key = `${WORKSHOP_LAST_CHAPTER_KEY_PREFIX}${pid}`;
    const chapterId = String(currentChapterId || "").trim();
    if (chapterId) {
      window.localStorage.setItem(key, chapterId);
    } else {
      window.localStorage.removeItem(key);
    }
  }, [pid, currentChapterId]);

  const saveContent = useCallback(async (contentToSave: string) => {
    if (!currentChapterId) return;
    setSaving(true);
    const paragraphs = contentToSave.split("\n").map((line, i) => ({ para_index: i, content: line }));
    try {
      await api("/api/chapters/paragraphs/save", {
        method: "POST",
        body: JSON.stringify({ chapter_id: currentChapterId, paragraphs }),
      });
      setLastSaved(new Date());
    } catch (e) {
      console.error("保存失败", e);
      addToast("error", "保存失败，请检查网络或后备存储");
    } finally {
      setSaving(false);
    }
  }, [currentChapterId, api, addToast]);

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    contentRef.current = newContent;

    // Auto-save logic (debounce 2 seconds)
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSaving(true); // show saving indicator immediately
    saveTimeoutRef.current = setTimeout(() => {
      saveContent(newContent);
    }, 2000);
  };

  const handleEditorSelectionChange = useCallback((selection: { start: number; end: number; text: string }) => {
    const start = Math.max(0, Number(selection.start) || 0);
    const end = Math.max(start, Number(selection.end) || 0);
    const selectedText = String(selection.text || "");
    if (selectedText.trim() && end > start) {
      setSelectedRange({ start, end });
      setAiTraceSelectedText(selectedText);
      return;
    }
    setSelectedRange(null);
    setAiTraceSelectedText("");
  }, []);

  const focusEditorRange = useCallback((start: number, end: number) => {
    requestAnimationFrame(() => {
      const editor = chapterEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelection(start, end, { scrollIntoView: true });
    });
  }, []);

  const saveChapterTitle = useCallback(async () => {
    if (!currentChapterId) return;
    const current = chapters.find((c) => c.id === currentChapterId);
    if (!current) return;

    const nextTitle = String(chapterTitleDraft || "").trim().replace(/\s+/g, " ");
    if (!nextTitle) {
      setChapterTitleDraft(String(current.title || ""));
      addToast("warning", "章节标题不能为空。");
      return;
    }
    if (nextTitle === String(current.title || "").trim()) return;

    setIsSavingChapterTitle(true);
    try {
      const updated = await api<Chapter>(`/api/chapters/${currentChapterId}`, {
        method: "PUT",
        body: JSON.stringify({ title: nextTitle }),
      });
      const finalTitle = String(updated?.title || nextTitle);
      setChapters((prev) =>
        prev.map((ch) => (ch.id === currentChapterId ? { ...ch, title: finalTitle } : ch)),
      );
      setChapterTitleDraft(finalTitle);
      addToast("success", "章节标题已更新。");
    } catch (e) {
      setChapterTitleDraft(String(current.title || ""));
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `标题保存失败：${detail}` : "标题保存失败，请稍后重试。");
    } finally {
      setIsSavingChapterTitle(false);
    }
  }, [api, addToast, chapterTitleDraft, chapters, currentChapterId]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const analyzeEntities = async () => {
    if (!content.trim() || !pid) return;
    setNerLoading(true);
    try {
      const resp = await api<NERResponse>("/api/ner/extract", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, text: content })
      });
      setNerEntities(resp.entities);
    } catch (e) {
      addToast("error", "实体提取失败");
    } finally {
      setNerLoading(false);
    }
  };

  const runConflictCheck = async () => {
    if (!content.trim() || !pid) return;
    setConflictLoading(true);
    setActiveTab('conflict'); // Show panel immediately so user sees loader

    try {
      const resp = await api<ConflictResponse>("/api/conflict/check", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, text: content })
      });
      setConflicts(resp.conflicts);
      setConflictSummary(resp.summary);
      if (resp.conflicts.length === 0) {
        addToast("success", "逻辑审查通过，未发现冲突！");
      } else {
        addToast("warning", `发现 ${resp.conflicts.length} 处疑似冲突`);
        if (resp.conflicts.length >= 4) {
          addToast("info", "逻辑问题较多，建议先生成“全章重写建议”再决定是否替换。");
        }
      }
    } catch (e) {
      addToast("error", "逻辑审查失败，请检查网络和Agent配置");
      setActiveTab('beats'); // Revert tab if failed
    } finally {
      setConflictLoading(false);
    }
  };

  const toggleViewMode = () => {
    const newMode = !isViewMode;
    setIsViewMode(newMode);
    if (newMode && nerEntities.length === 0 && content.trim()) {
      analyzeEntities();
      setActiveTab('context'); // Auto switch to context tab to show insights
    }
  };

  const chapter = chapters.find((c) => c.id === currentChapterId);
  const wordCount = content.length;
  const assistantModelInfo = agentModels.writer_assistant;
  const nerModelInfo = agentModels.ner_extractor;
  const debateModelInfo = agentModels.debate_room;
  const assistantModelLabel = assistantModelInfo.modelLabel || resolveAgentModelLabel(assistantModelInfo.modelId || "");
  const debateModelText =
    debateModelInfo.secondaryModelLabel && debateModelInfo.secondaryModelLabel !== debateModelInfo.modelLabel
      ? `${debateModelInfo.modelLabel} / 导演:${debateModelInfo.secondaryModelLabel}`
      : debateModelInfo.modelLabel;
  const unknownNerEntities = useMemo(
    () => nerEntities.filter((entity) => !entity.is_known),
    [nerEntities],
  );
  const sections = useMemo(() => [
    { title: "当前角色", icon: Users, items: ctxChars },
    { title: "相关伏笔", icon: Eye, items: ctxForeshadow },
    { title: "世界观参考", icon: Globe, items: ctxWorld },
  ], [ctxChars, ctxForeshadow, ctxWorld]);
  const contextHasAnyData = useMemo(
    () => unknownNerEntities.length > 0 || sections.some((section) => section.items.length > 0),
    [unknownNerEntities, sections],
  );
  const aiTraceResolvedCount = aiTraceResult
    ? aiTraceResult.hits.reduce((acc, hit, idx) => {
      const key = buildAiTraceHitKey(hit, idx);
      return acc + (aiTraceResolvedMap[key] ? 1 : 0);
    }, 0)
    : 0;
  const chapterNum = Number(chapter?.chapter_num || 0);
  const totalChapterCount = chapters.length;
  const maxChapterNum = chapters.reduce((acc, item) => Math.max(acc, Number(item.chapter_num || 0)), 0);
  const isFirstChapter = chapterNum === 1;
  const chapterSynopsisText = String(chapter?.synopsis || chapter?.summary || "").trim();
  const sortedChaptersByNum = chapters
    .slice()
    .sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0));
  const nextChapter = sortedChaptersByNum.find((c) => Number(c.chapter_num || 0) > chapterNum);
  const nextChapterNum = Number(nextChapter?.chapter_num || 0);
  const nextChapterSynopsisText = String((nextChapter as any)?.synopsis || (nextChapter as any)?.summary || "").trim();

  useEffect(() => {
    if (!chapterNum) {
      setChapterJumpInput("");
      return;
    }
    setChapterJumpInput(String(chapterNum));
  }, [chapterNum, currentChapterId]);

  const jumpToChapterNum = (rawNum: number) => {
    if (!Number.isFinite(rawNum) || chapters.length === 0) return;
    const targetNum = Math.max(1, Math.round(rawNum));
    const sorted = chapters.slice().sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0));
    const exact = sorted.find((c) => Number(c.chapter_num || 0) === targetNum);
    const fallback = sorted.find((c) => Number(c.chapter_num || 0) >= targetNum) || sorted[sorted.length - 1];
    const target = exact || fallback;
    if (target?.id) {
      setCurrentChapterId(target.id);
      setShowChapterMenu(false);
    }
  };

  const applyChapterJumpInput = () => {
    const value = Number(chapterJumpInput);
    if (!Number.isFinite(value)) {
      setChapterJumpInput(chapterNum ? String(chapterNum) : "");
      return;
    }
    jumpToChapterNum(value);
  };

  const resolveFirstChapterOpeningMode = (
    mode: FirstChapterOpeningMode,
    synopsis: string,
  ): ConcreteFirstChapterOpeningMode => {
    if (mode !== "auto") return mode;
    const text = String(synopsis || "");
    if (/(旁线|支线|配角视角|路人视角|非主角)/.test(text)) return "sidestory";
    if (/(假主角|误导|错认|伪装|身份反转|视角错位)/.test(text)) return "decoy";
    if (/(主角|主人公|第一人称|我视角)/.test(text)) return "protagonist";
    if (/(命案|爆炸|事故|异象|警报|追捕|袭击|失踪|坠落|火灾|危机|灾难|突然)/.test(text)) return "cold_event";
    return "cold_event";
  };

  const effectiveFirstChapterOpeningMode = resolveFirstChapterOpeningMode(firstChapterOpeningMode, chapterSynopsisText);

  const getOpeningModeLabel = (mode: FirstChapterOpeningMode) => {
    switch (mode) {
      case "auto":
        return "自动判断";
      case "protagonist":
        return "主角直入";
      case "sidestory":
        return "旁线引子";
      case "decoy":
        return "假主角开场";
      case "cold_event":
      default:
        return "事件冷开";
    }
  };

  const getOpeningModeHint = (mode: FirstChapterOpeningMode) => {
    switch (mode) {
      case "auto":
        return `自动判断（推荐）：系统按章节梗概推断。当前推断为「${getOpeningModeLabel(effectiveFirstChapterOpeningMode)}」。`;
      case "protagonist":
        return "主角直入：前段就让主角入场，并给出当下目标或阻碍。";
      case "sidestory":
        return "旁线引子：先写旁线事件，再在后续章节回收主线锚点。";
      case "decoy":
        return "假主角开场：先跟随误导视角，后续再揭示错位。";
      case "cold_event":
      default:
        return "事件冷开：先抛异常事件现场，再补人物与因果。";
    }
  };

  const buildFirstChapterOpeningBlock = (targetChapterNum: number) => {
    if (targetChapterNum !== 1) return "";
    const anchorBy = Math.max(2, Math.min(12, Math.round(firstChapterAnchorChapter || DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER)));
    const modeForPrompt = effectiveFirstChapterOpeningMode;
    let modeRule = "";
    switch (modeForPrompt) {
      case "protagonist":
        modeRule = "5) 开头 500 字内让主角入场，并明确其当下目标或阻碍。";
        break;
      case "sidestory":
        modeRule = `5) 允许主角不出场，但必须埋“可回收锚点”，最晚第 ${anchorBy} 章前回收，避免番外感。`;
        break;
      case "decoy":
        modeRule = "5) 采用假主角开场：前段跟随误导视角，章尾释放视角错位信号。";
        break;
      case "cold_event":
      default:
        modeRule = "5) 采用事件冷开：先给事件现场与后果，再补人物与因果细节。";
        break;
    }
    const modeLabelForPrompt =
      firstChapterOpeningMode === "auto"
        ? `自动判断（当前：${getOpeningModeLabel(modeForPrompt)}）`
        : getOpeningModeLabel(modeForPrompt);
    return [
      "【首章开篇约束（仅第1章）】",
      `当前开篇类型：${modeLabelForPrompt}。`,
      "1) 前 300 字必须出现异常/冲突/悬念至少一项；",
      "2) 禁止先写大段背景设定，信息要通过行动与场景释放；",
      "3) 每段必须有信息增量或局势变化，禁止流水账；",
      "4) 章尾必须留下未解问题，或下一步行动动机，或让人想读下一章的悬念钩子；",
      modeRule,
    ].join("\n");
  };

  const buildFirstChapterBeatHint = (targetChapterNum: number) => {
    if (targetChapterNum !== 1) return "";
    const anchorBy = Math.max(2, Math.min(12, Math.round(firstChapterAnchorChapter || DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER)));
    const modeForPrompt = effectiveFirstChapterOpeningMode;
    let modeHint = "";
    switch (modeForPrompt) {
      case "protagonist":
        modeHint = "前两条节拍内安排主角落位，并交代其即时行动目标。";
        break;
      case "sidestory":
        modeHint = `以旁线引子起笔，但要在节拍中埋主线锚点，最晚第 ${anchorBy} 章前回收。`;
        break;
      case "decoy":
        modeHint = "前段节拍可跟随假主角，末段节拍必须释放视角错位信号。";
        break;
      case "cold_event":
      default:
        modeHint = "首条节拍优先呈现事件现场或异常结果，再逐步揭示人物与因果。";
        break;
    }
    return [
      "【首章节拍加严】",
      "首条节拍必须有异常/冲突/悬念触发点；",
      "第二条节拍必须出现局势升级或行动选择；",
      modeHint,
      "末条节拍必须形成章尾牵引（问题未解/行动动机/悬念钩子三选一）。",
    ].join("\n");
  };

  const cleanRewriteOutput = (raw: string) => {
    let text = String(raw || "").trim();
    const fenced = text.match(/```(?:[\w-]+)?\n([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      text = fenced[1].trim();
    }
    return text.replace(/^改写(?:后)?[：:]\s*/i, "").trim();
  };

  const cleanChapterDraftOutput = (raw: string) => {
    let text = String(raw || "").trim();
    const fenced = text.match(/```(?:[\w-]+)?\n([\s\S]*?)```/);
    if (fenced && fenced[1]) {
      text = fenced[1].trim();
    }
    text = text
      .replace(/^\s*(正文|草稿|内容)\s*[：:]\s*/i, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .filter((line) => !/^\s*(?:[*＊#=_~`\-—·•]\s*){3,}$/.test(line))
      .join("\n")
      // 保留段落空行：把连续空行收敛到 1 个空行（即段间双换行）。
      .replace(/\n\s*\n{2,}/g, "\n\n")
      .trim();
    return text;
  };

  const countVisibleChars = (text: string) => String(text || "").replace(/\s+/g, "").length;

  const resolvePerBeatLengthHint = (remainingChars: number, remainingBeats: number) => {
    const beatsLeft = Math.max(1, remainingBeats);
    const rawTarget = Math.round(Math.max(220, remainingChars) / beatsLeft);
    const target = Math.max(220, Math.min(2400, rawTarget));
    const min = Math.max(160, Math.round(target * 0.78));
    const max = Math.max(min + 60, Math.round(target * 1.25));
    return { target, min, max };
  };

  const clipPromptText = (text: string, maxChars: number) => {
    const value = String(text || "");
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + "\n...(正文过长，已截断)";
  };

  const clipSingleLine = (text: string, maxChars: number) => {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value.length <= maxChars) return value;
    return value.slice(0, maxChars) + "...";
  };

  const normalizeForRewriteSimilarity = (text: string) =>
    String(text || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[，。！？、,.!?;；:：'"“”‘’（）()\[\]【】\-—_]/g, "");

  const calcBigramSimilarity = (a: string, b: string) => {
    const textA = normalizeForRewriteSimilarity(a);
    const textB = normalizeForRewriteSimilarity(b);
    if (!textA && !textB) return 1;
    if (!textA || !textB) return 0;
    if (textA.length < 2 || textB.length < 2) {
      return textA === textB ? 1 : 0;
    }

    const toBigramCounts = (input: string) => {
      const counts = new Map<string, number>();
      for (let i = 0; i < input.length - 1; i += 1) {
        const gram = input.slice(i, i + 2);
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
      return counts;
    };

    const gramsA = toBigramCounts(textA);
    const gramsB = toBigramCounts(textB);
    let overlap = 0;
    let totalA = 0;
    let totalB = 0;

    gramsA.forEach((count, gram) => {
      totalA += count;
      overlap += Math.min(count, gramsB.get(gram) || 0);
    });
    gramsB.forEach((count) => {
      totalB += count;
    });

    if (totalA + totalB === 0) return 0;
    return (2 * overlap) / (totalA + totalB);
  };

  const resolveCurrentSelectedText = () => {
    const fullText = String(contentRef.current || content || "");
    const liveSelection = chapterEditorRef.current?.getSelection();
    if (liveSelection && liveSelection.end > liveSelection.start) {
      const selectedLive = String(liveSelection.text || "").trim();
      if (selectedLive) return selectedLive;
    }
    if (selectedRange && selectedRange.end > selectedRange.start) {
      const start = Math.max(0, Math.min(selectedRange.start, fullText.length));
      const end = Math.max(start, Math.min(selectedRange.end, fullText.length));
      const selected = fullText.slice(start, end).trim();
      if (selected) return selected;
    }
    const selectionText = String(window.getSelection?.()?.toString?.() || "").trim();
    return selectionText;
  };

  const buildBeatConstraintBlock = async (chapterId: string) => {
    let beats: ChapterBeat[] = [];
    try {
      beats = await api<ChapterBeat[]>(`/api/beats/?chapter_id=${chapterId}`);
    } catch {
      beats = [];
    }
    const beatLines = beats
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .slice(0, 12)
      .map((beat) => `- (${beat.order_index}) [${beat.status}] ${clipSingleLine(beat.content, 120)}`);
    if (beatLines.length === 0) {
      return "【本章节拍】暂无节拍数据：保持原有剧情推进，不新增关键事件。";
    }
    return [
      "【本章节拍（改写必须遵守）】",
      ...beatLines,
      "",
      "节拍硬约束：",
      "A) 改写只优化表达，不改变当前片段对应节拍的事件目标与因果链；",
      "B) 不得提前透支后续节拍，也不得回退已完成节拍；",
      "C) 若原片段与节拍表轻微冲突，优先对齐节拍表。",
    ].join("\n");
  };

  const invokeEditorRewrite = async (message: string) => {
    if (!pid || !currentChapterId) throw new Error("缺少项目或章节上下文");
    const resp = await api<any>("/agent/invoke", {
      method: "POST",
      body: JSON.stringify({
        project_id: pid,
        chapter_id: currentChapterId,
        agent_type: "editor",
        message,
      }),
    });

    const rewrittenText = cleanRewriteOutput(String(resp?.content || ""));
    if (!rewrittenText) {
      const reason = String(resp?.metadata?.message || "").trim();
      throw new Error(reason || "改写结果为空");
    }
    return rewrittenText;
  };

  const buildAiTraceLengthHint = (useSelection: boolean, fullText: string, targetText: string) => {
    const currentLen = Math.max(80, countVisibleChars(targetText));
    if (useSelection) {
      const target = Math.max(80, Math.min(6000, currentLen));
      const min = Math.max(60, Math.round(target * 0.82));
      const max = Math.max(min + 30, Math.round(target * 1.18));
      return { scopeLabel: "片段", target, min, max };
    }
    const chapterTarget = resolveChapterWordTarget();
    const fullLen = Math.max(200, countVisibleChars(fullText));
    const target = Math.max(500, Math.min(12000, Math.round(chapterTarget || fullLen)));
    const min = Math.max(420, Math.round(target * 0.88));
    const max = Math.max(min + 80, Math.round(target * 1.12));
    return { scopeLabel: "章节", target, min, max };
  };

  const fitAiTraceRewriteToLength = async (
    rewrittenText: string,
    originalText: string,
    useSelection: boolean,
    beatConstraintBlock: string,
  ) => {
    const draft = String(rewrittenText || "").trim();
    if (!draft) return { text: draft, adjusted: false, beforeLen: 0, afterLen: 0 };

    const lengthHint = buildAiTraceLengthHint(useSelection, String(contentRef.current || content || ""), originalText);
    const beforeLen = countVisibleChars(draft);
    if (beforeLen >= lengthHint.min && beforeLen <= lengthHint.max) {
      return { text: draft, adjusted: false, beforeLen, afterLen: beforeLen };
    }

    const prompt = [
      `[DRAFT_ONLY][LEN_TARGET:${lengthHint.target}][LEN_MIN:${lengthHint.min}][LEN_MAX:${lengthHint.max}]`,
      "请执行“AI痕迹改写字数校准”任务。",
      "",
      "目标：在不改变事实与事件顺序的前提下，把文本调整到目标字数区间。",
      "硬约束：",
      "1) 保留剧情事实、角色关系、人称与时态；",
      "2) 严格遵守章节节拍目标，不新增关键剧情；",
      "3) 语言自然，不要写成摘要或说明文；",
      "4) 只输出校准后的正文，不要解释。",
      useSelection ? "5) 只输出片段文本，不要带出片段外内容。" : "5) 输出对象为当前章节正文全量。",
      "",
      beatConstraintBlock,
      "",
      `【字数目标】${lengthHint.scopeLabel}目标约 ${lengthHint.target} 字，允许范围 ${lengthHint.min}-${lengthHint.max} 字`,
      `【当前字数】约 ${beforeLen} 字`,
      "",
      "【原文本（语义锚点）】",
      clipPromptText(originalText, 8000),
      "",
      "【待校准文本】",
      clipPromptText(draft, 14000),
    ].join("\n");

    try {
      const fitted = await invokeEditorRewrite(prompt);
      const candidate = String(fitted || "").trim();
      if (!candidate) return { text: draft, adjusted: false, beforeLen, afterLen: beforeLen };
      const afterLen = countVisibleChars(candidate);
      const beforeDelta = Math.abs(beforeLen - lengthHint.target);
      const afterDelta = Math.abs(afterLen - lengthHint.target);
      const improved = afterDelta + 40 < beforeDelta || (afterLen >= lengthHint.min && afterLen <= lengthHint.max);
      return {
        text: improved ? candidate : draft,
        adjusted: improved,
        beforeLen,
        afterLen: improved ? afterLen : beforeLen,
      };
    } catch (error) {
      console.warn("AI痕迹字数校准失败，保留改写稿:", error);
      return { text: draft, adjusted: false, beforeLen, afterLen: beforeLen };
    }
  };

  const buildQuoteLookupCandidates = (rawText: string) => {
    const base = String(rawText || "")
      .replace(/\r?\n/g, " ")
      .replace(/[“”"‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\u2026…]+|[.\u2026…]+$/g, "")
      .trim();
    if (!base) return [] as string[];

    const bucket = new Set<string>();
    const push = (value: string, minLen = 6) => {
      const text = String(value || "").trim();
      if (text.length >= minLen) bucket.add(text);
    };

    push(base, 6);
    base.split(/\.{2,}|…+/).forEach((part) => push(part, 8));
    base.split(/[，。！？；,.!?;:：]/).forEach((part) => push(part, 8));

    return Array.from(bucket).sort((a, b) => b.length - a.length).slice(0, 20);
  };

  const resolveApproximateQuoteRange = (
    fullText: string,
    quoteText: string,
    expectedStart?: number | null,
  ) => {
    const candidates = buildQuoteLookupCandidates(quoteText);
    if (candidates.length === 0) return null;
    const expected = Number.isFinite(Number(expectedStart))
      ? Math.max(0, Math.min(Number(expectedStart), fullText.length))
      : null;

    const localFindAll = (source: string, needle: string) => {
      const hits: number[] = [];
      if (!needle) return hits;
      let cursor = 0;
      while (cursor <= source.length) {
        const idx = source.indexOf(needle, cursor);
        if (idx < 0) break;
        hits.push(idx);
        cursor = idx + Math.max(1, needle.length);
      }
      return hits;
    };

    let best: { start: number; end: number; score: number } | null = null;
    for (const candidate of candidates) {
      const hits = localFindAll(fullText, candidate);
      if (hits.length === 0) continue;
      if (hits.length > 3 && candidate.length < 12 && expected === null) continue;
      for (const start of hits) {
        const end = start + candidate.length;
        let score = candidate.length;
        if (expected !== null) {
          const distance = Math.abs(start - expected);
          score += Math.max(0, 240 - distance) / 8;
        }
        const prev = start > 0 ? fullText[start - 1] : "";
        const next = end < fullText.length ? fullText[end] : "";
        if (/[\n。！？!?；;，,、]/.test(prev)) score += 4;
        if (/[\n。！？!?；;，,、]/.test(next)) score += 4;

        if (!best || score > best.score) {
          best = { start, end, score };
        }
      }
    }
    if (!best) return null;
    return { start: best.start, end: best.end };
  };

  const resolveRangeFromOriginalText = (fullText: string, originalText: string) => {
    const normalizedTarget = normalizeForRewriteSimilarity(originalText);
    if (!normalizedTarget) return null;
    if (selectedRange && selectedRange.end > selectedRange.start) {
      const start = Math.max(0, Math.min(selectedRange.start, fullText.length));
      const end = Math.max(start, Math.min(selectedRange.end, fullText.length));
      const candidate = fullText.slice(start, end);
      if (normalizeForRewriteSimilarity(candidate) === normalizedTarget) {
        return { start, end };
      }
    }
    let idx = fullText.indexOf(originalText);
    let target = originalText;
    if (idx < 0) {
      const trimmed = originalText.trim();
      idx = trimmed ? fullText.indexOf(trimmed) : -1;
      target = trimmed;
    }
    if (idx >= 0 && target) {
      return { start: idx, end: idx + target.length };
    }
    return resolveApproximateQuoteRange(fullText, originalText, selectedRange?.start ?? null);
  };

  const findAllOccurrences = (source: string, needle: string) => {
    const hits: number[] = [];
    if (!needle) return hits;
    let cursor = 0;
    while (cursor <= source.length) {
      const idx = source.indexOf(needle, cursor);
      if (idx < 0) break;
      hits.push(idx);
      cursor = idx + Math.max(1, needle.length);
    }
    return hits;
  };

  const buildSuggestionAnchors = (
    fullText: string,
    range: { start: number; end: number },
  ) => {
    const start = Math.max(0, Math.min(range.start, fullText.length));
    const end = Math.max(start, Math.min(range.end, fullText.length));
    const leftAnchor = fullText.slice(Math.max(0, start - 120), start).trim();
    const rightAnchor = fullText.slice(end, Math.min(fullText.length, end + 120)).trim();
    return {
      leftAnchor: clipPromptText(leftAnchor, 120),
      rightAnchor: clipPromptText(rightAnchor, 120),
    };
  };

  const scoreSuggestionRange = (
    fullText: string,
    suggestion: AssistantRewriteSuggestion,
    start: number,
    end: number,
  ) => {
    const expectedStart = Math.max(0, Math.min(suggestion.range.start, fullText.length));
    const span = Math.max(1, Math.abs(suggestion.range.end - suggestion.range.start));
    const distance = Math.abs(start - expectedStart);
    const distanceScore = 1 - Math.min(1, distance / Math.max(200, span * 4));

    let score = distanceScore;
    const leftAnchor = String(suggestion.leftAnchor || "").trim();
    if (leftAnchor) {
      const leftSlice = fullText.slice(Math.max(0, start - leftAnchor.length), start);
      score += calcBigramSimilarity(leftAnchor, leftSlice) * 2;
    }
    const rightAnchor = String(suggestion.rightAnchor || "").trim();
    if (rightAnchor) {
      const rightSlice = fullText.slice(end, Math.min(fullText.length, end + rightAnchor.length));
      score += calcBigramSimilarity(rightAnchor, rightSlice) * 2;
    }
    return score;
  };

  const resolveSelectionForRewriteAction = (fullText: string) => {
    const liveSelection = chapterEditorRef.current?.getSelection();
    if (liveSelection) {
      const liveStart = Math.max(0, Math.min(liveSelection.start ?? 0, fullText.length));
      const liveEnd = Math.max(liveStart, Math.min(liveSelection.end ?? 0, fullText.length));
      const liveSelected = fullText.slice(liveStart, liveEnd);
      if (liveEnd > liveStart && liveSelected.trim()) {
        return { start: liveStart, end: liveEnd, text: liveSelected };
      }
    }

    if (selectedRange && selectedRange.end > selectedRange.start) {
      const start = Math.max(0, Math.min(selectedRange.start, fullText.length));
      const end = Math.max(start, Math.min(selectedRange.end, fullText.length));
      const selected = fullText.slice(start, end);
      if (selected.trim()) {
        return { start, end, text: selected };
      }
    }
    return null;
  };

  const resolveRangeForAssistantSuggestion = (
    fullText: string,
    suggestion: AssistantRewriteSuggestion,
  ) => {
    const target = String(suggestion.originalText || "");
    const normalizedTarget = normalizeForRewriteSimilarity(target);
    if (!normalizedTarget) return null;

    const expectedStart = Math.max(0, Math.min(suggestion.range.start, fullText.length));
    const expectedEnd = Math.max(expectedStart, Math.min(suggestion.range.end, fullText.length));
    const expectedSlice = fullText.slice(expectedStart, expectedEnd);
    if (expectedEnd > expectedStart && normalizeForRewriteSimilarity(expectedSlice) === normalizedTarget) {
      return { start: expectedStart, end: expectedEnd };
    }

    let searchNeedle = target;
    let matches = findAllOccurrences(fullText, searchNeedle);
    if (matches.length === 0) {
      const trimmed = target.trim();
      if (!trimmed) return null;
      searchNeedle = trimmed;
      matches = findAllOccurrences(fullText, searchNeedle);
    }
    if (matches.length === 0) {
      return resolveApproximateQuoteRange(fullText, target, suggestion.range.start);
    }
    if (matches.length === 1) {
      return { start: matches[0], end: matches[0] + searchNeedle.length };
    }

    const hasAnchor = Boolean(
      String(suggestion.leftAnchor || "").trim() || String(suggestion.rightAnchor || "").trim(),
    );
    const hasUsableExpectedRange = suggestion.range.end > suggestion.range.start;
    if (!hasAnchor && !hasUsableExpectedRange) {
      return target.length >= 20 ? resolveApproximateQuoteRange(fullText, target, null) : null;
    }

    const scored = matches.map((start) => {
      const end = start + searchNeedle.length;
      return {
        start,
        end,
        score: scoreSuggestionRange(fullText, suggestion, start, end),
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return { start: scored[0].start, end: scored[0].end };
  };

  const applyDebateSuggestionToContent = () => {
    if (!debateRewriteSuggestion) return;
    const fullText = String(contentRef.current || content || "");
    const range = resolveRangeFromOriginalText(fullText, debateRewriteSuggestion.originalText);
    if (!range) {
      addToast("warning", "无法在正文中定位原片段，未应用。请先重新选中对应段落后再试。");
      return;
    }
    const rewritten = String(debateRewriteSuggestion.suggestedText || "").trim();
    if (!rewritten) {
      addToast("warning", "建议正文为空，无法应用。");
      return;
    }
    const nextContent = fullText.slice(0, range.start) + rewritten + fullText.slice(range.end);
    handleContentChange(nextContent);
    const nextRange = { start: range.start, end: range.start + rewritten.length };
    setSelectedRange(nextRange);
    setAiTraceSelectedText(rewritten);
    setDebateRewriteSuggestion(null);
    addToast("success", "已应用围读建议正文。");
    focusEditorRange(nextRange.start, nextRange.end);
  };

  const generateDebateRewriteSuggestion = async (quotedText: string, directorAdvice: string) => {
    if (!pid || !currentChapterId) return;
    const quote = String(quotedText || "").trim();
    const advice = String(directorAdvice || "").trim();
    if (!quote || !advice) return;

    setIsGeneratingDebateSuggestion(true);
    try {
      const fullText = String(contentRef.current || content || "");
      const chapterTextForPrompt = clipPromptText(fullText, 18000);
      const beatConstraintBlock = await buildBeatConstraintBlock(currentChapterId);
      const prompt = [
        "请执行“围读结论落地改写”任务。",
        "",
        "任务要求：",
        "1) 基于【主编导演结论】改写【待改写片段】；",
        "2) 必须遵守【本章节拍】推进顺序与事件目标；",
        "3) 保留事实与情节信息，不改人称与时态；",
        "4) 输出可直接入稿的建议正文；",
        "5) 只输出改写后的片段，不要解释。",
        "",
        beatConstraintBlock,
        "",
        "【主编导演结论】",
        clipPromptText(advice, 1400),
        "",
        "【整章正文】",
        chapterTextForPrompt,
        "",
        "【待改写片段】",
        quote,
      ].join("\n");

      const suggestedText = await invokeEditorRewrite(prompt);
      setDebateRewriteSuggestion({
        originalText: quote,
        suggestedText,
        directorAdvice: clipPromptText(advice, 600),
      });
      addToast("success", "围读建议正文已生成，请确认后决定是否应用。");
    } catch (e) {
      console.error("围读建议正文生成失败:", e);
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `建议正文生成失败：${detail}` : "建议正文生成失败，请重试。");
    } finally {
      setIsGeneratingDebateSuggestion(false);
    }
  };

  const resolveDroppedText = (e: any) => {
    const fromTransfer = String(e?.dataTransfer?.getData?.("text/plain") || "").trim();
    if (fromTransfer) return fromTransfer;
    return resolveCurrentSelectedText();
  };

  const handleDebateTextDrop = (e: any) => {
    e.preventDefault();
    const text = resolveDroppedText(e);
    if (!text) return;
    setBottomMode('debate');
    setDebateQuotedText(text);
    setDebateRewriteSuggestion(null);
  };

  const handleQuoteSelectedTextToDebate = () => {
    const text = resolveCurrentSelectedText();
    if (!text) {
      addToast("warning", "请先在左侧正文中选中要引用的文本。");
      return;
    }
    setBottomMode('debate');
    setDebateQuotedText(text);
    setDebateRewriteSuggestion(null);
    addToast("success", `已引用 ${text.length} 字到围读。`);
  };

  const applySuggestionToEditor = (
    suggestion: AssistantRewriteSuggestion,
    successMessage = "已替换正文中的目标片段。",
    options?: {
      silentFailure?: boolean;
      silentSuccess?: boolean;
      focusSelection?: boolean;
    },
  ) => {
    const fullText = String(contentRef.current || content || "");
    const range = resolveRangeForAssistantSuggestion(fullText, suggestion);
    if (!range) {
      if (!options?.silentFailure) {
        addToast("warning", "目标片段已变化或定位失败，正文未改动。请重新选中后再改写。");
      }
      return false;
    }
    const rewritten = String(suggestion.suggestedText || "").trim();
    if (!rewritten) {
      if (!options?.silentFailure) {
        addToast("warning", "改写建议为空，无法应用。");
      }
      return false;
    }

    const nextContent = fullText.slice(0, range.start) + rewritten + fullText.slice(range.end);
    handleContentChange(nextContent);
    const nextRange = { start: range.start, end: range.start + rewritten.length };
    setSelectedRange(nextRange);
    setAiTraceSelectedText(rewritten);
    if (!options?.silentSuccess) {
      addToast("success", successMessage);
    }

    if (options?.focusSelection !== false) {
      focusEditorRange(nextRange.start, nextRange.end);
    }
    return true;
  };

  const applyAssistantRewriteSuggestion = () => {
    if (!assistantRewriteSuggestion) return;
    const applied = applySuggestionToEditor(assistantRewriteSuggestion, "已替换正文中的目标片段。");
    if (applied) {
      setAssistantRewriteSuggestion(null);
    }
  };

  const discardAssistantRewriteSuggestion = () => {
    if (!assistantRewriteSuggestion) return;
    setAssistantRewriteSuggestion(null);
    addToast("info", "已取消本次改写建议。");
  };

  const handleRewriteSelectedText = async () => {
    if (!pid || !currentChapterId) return;
    if (isViewMode) {
      addToast("warning", "请先关闭阅读模式，再选中正文进行改写。");
      return;
    }

    const fullText = String(contentRef.current || content || "");
    const selection = resolveSelectionForRewriteAction(fullText);
    if (!selection) {
      addToast("warning", "请先在左侧正文中选中要改写的文本。");
      return;
    }

    const start = selection.start;
    const end = selection.end;
    const selectedText = selection.text;
    if (!selectedText.trim()) {
      addToast("warning", "选中文本为空，无法改写。");
      return;
    }

    setAssistantRewriteSuggestion(null);
    setIsRewritingSelection(true);
    try {
      const chapterTextForPrompt = clipPromptText(fullText, 18000);
      const beatConstraintBlock = await buildBeatConstraintBlock(currentChapterId);

      const prompt = [
        "请执行“局部改写”任务。",
        "",
        "要求：",
        "1) 必须先理解整章语气与上下文，再改写【待改写片段】；",
        "2) 必须遵守【本章节拍】的推进顺序与事件目标；",
        "3) 保留原片段核心信息与情节事实，不改人称与时态；",
        "4) 优先重写句法与表达组织，不要只做同义词替换；",
        "5) 语言更自然、有画面感，避免套话和AI腔；",
        "6) 仅输出对应片段，不要输出整章或额外前后文；",
        "7) 字数控制在原片段的0.6~1.4倍；",
        "8) 只输出改写后的片段，不要解释。",
        "",
        beatConstraintBlock,
        "",
        "【整章正文】",
        chapterTextForPrompt,
        "",
        "【待改写片段】",
        selectedText,
      ].join("\n");

      const firstRewrite = await invokeEditorRewrite(prompt);
      let rewritten = firstRewrite;

      // 若改写与原文过近，则自动进行一次更强重写，提升“重写感”。
      const similarity = calcBigramSimilarity(selectedText, firstRewrite);
      if (selectedText.trim().length >= 30 && similarity > rewriteSimilarityThreshold) {
        const strongerPrompt = [
          "你上一次输出与原文过于接近。",
          "现在执行“强改写”任务。",
          "",
          "强改写要求：",
          "1) 必须遵守【本章节拍】的推进顺序与事件目标；",
          "2) 不改变事实、人称、时态；",
          "3) 必须显著改写句法与叙述组织，避免复刻原句；",
          "4) 可重排句序与段内节奏，但不得新增关键剧情；",
          "5) 风格继续贴合整章语气；",
          "6) 仅输出对应片段，不要输出整章或额外前后文；",
          "7) 字数控制在原片段的0.6~1.4倍；",
          "8) 只输出最终改写片段，不要解释。",
          "",
          beatConstraintBlock,
          "",
          "【整章正文】",
          chapterTextForPrompt,
          "",
          "【待改写片段】",
          selectedText,
        ].join("\n");

        try {
          rewritten = await invokeEditorRewrite(strongerPrompt);
        } catch (retryError) {
          console.warn("强改写回退到首次改写结果:", retryError);
          rewritten = firstRewrite;
        }
      }

      setAssistantRewriteSuggestion({
        originalText: selectedText,
        suggestedText: rewritten,
        range: { start, end },
        createdAt: Date.now(),
        ...buildSuggestionAnchors(fullText, { start, end }),
      });
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: `【一键改写】${selectedText.slice(0, 80)}${selectedText.length > 80 ? "..." : ""}` },
        { role: "assistant", content: "已生成改写建议（未应用），请在聊天区点击“应用替换”。" },
      ]);
      setActiveTab("chat");
      addToast("success", "改写建议已生成，请确认后再应用到正文。");
    } catch (e) {
      console.error("选中文本改写失败:", e);
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `改写失败：${detail}` : "改写失败，请检查模型配置后重试。");
    } finally {
      setIsRewritingSelection(false);
    }
  };

  const buildConflictRewritePrompt = (
    conflict: ConflictItem,
    chapterTextForPrompt: string,
    beatConstraintBlock: string,
    targetText: string,
  ) => {
    return [
      "请执行“逻辑问题修复改写”任务。",
      "",
      "任务目标：",
      "1) 基于【冲突说明】与【修复建议】改写【待改写片段】；",
      "2) 严格遵守【本章节拍】推进，不新增关键剧情；",
      "3) 保留事实、人称、时态，重点修复因果与动机连贯；",
      "4) 输出可直接入稿的建议正文；",
      "5) 只输出改写片段，不要解释。",
      "",
      beatConstraintBlock,
      "",
      "【冲突说明】",
      clipPromptText(String(conflict.description || ""), 600),
      "",
      "【修复建议】",
      clipPromptText(String(conflict.suggestion || ""), 600),
      "",
      "【整章正文】",
      chapterTextForPrompt,
      "",
      "【待改写片段】",
      targetText,
    ].join("\n");
  };

  const handleGenerateConflictRewriteSuggestion = async (conflict: ConflictItem, index: number) => {
    if (!pid || !currentChapterId) return;
    if (generatingConflictRewriteIndex !== null || isGeneratingChapterConflictRewrite || isApplyingAllConflictRewrites) return;

    const fullText = String(contentRef.current || content || "");
    const quote = String(conflict.quote || "").trim();
    const range = quote ? resolveRangeFromOriginalText(fullText, quote) : null;
    const targetText = range ? fullText.slice(range.start, range.end) : quote;
    if (!targetText.trim()) {
      addToast("warning", "该问题缺少可定位片段，请先手动选中正文后再改写。");
      return;
    }

    setGeneratingConflictRewriteIndex(index);
    setAssistantRewriteSuggestion(null);
    try {
      const chapterTextForPrompt = clipPromptText(fullText, 18000);
      const beatConstraintBlock = await buildBeatConstraintBlock(currentChapterId);
      const prompt = buildConflictRewritePrompt(conflict, chapterTextForPrompt, beatConstraintBlock, targetText);

      const rewritten = await invokeEditorRewrite(prompt);
      setAssistantRewriteSuggestion({
        originalText: targetText,
        suggestedText: rewritten,
        range: range ? { start: range.start, end: range.end } : { start: 0, end: 0 },
        createdAt: Date.now(),
        ...(range ? buildSuggestionAnchors(fullText, range) : {}),
      });
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: `【逻辑修复】${targetText.slice(0, 80)}${targetText.length > 80 ? "..." : ""}` },
        { role: "assistant", content: "已生成逻辑修复建议正文（未应用），请确认后再替换。" },
      ]);
      setActiveTab("chat");
      addToast("success", "逻辑修复建议正文已生成，请确认后应用。");
    } catch (e) {
      console.error("逻辑修复建议生成失败:", e);
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `生成失败：${detail}` : "生成失败，请稍后重试。");
    } finally {
      setGeneratingConflictRewriteIndex(null);
    }
  };

  const handleGenerateChapterConflictRewrite = async () => {
    if (!pid || !currentChapterId || conflicts.length === 0) return;
    if (isGeneratingChapterConflictRewrite || generatingConflictRewriteIndex !== null || isApplyingAllConflictRewrites) return;
    const fullText = String(contentRef.current || content || "").trim();
    if (!fullText) {
      addToast("warning", "当前章节正文为空，无法生成全章重写建议。");
      return;
    }

    setIsGeneratingChapterConflictRewrite(true);
    setAssistantRewriteSuggestion(null);
    try {
      const beatConstraintBlock = await buildBeatConstraintBlock(currentChapterId);
      const conflictLines = conflicts
        .slice(0, 12)
        .map((item, idx) => `- [${idx + 1}] (${item.type}) 问题:${clipPromptText(item.description, 220)} | 建议:${clipPromptText(item.suggestion, 220)}`);

      const prompt = [
        "请执行“整章逻辑修复重写”任务。",
        "",
        "任务要求：",
        "1) 基于【冲突清单】修复整章逻辑连贯性；",
        "2) 严格遵守【本章节拍】顺序与事件目标；",
        "3) 不新增关键剧情，不改变事实、人称与时态；",
        "4) 保持原章节风格与主要信息，但允许重排句段；",
        "5) 只输出整章重写后的正文，不要解释。",
        "",
        beatConstraintBlock,
        "",
        "【冲突清单】",
        ...conflictLines,
        "",
        "【原章节正文】",
        clipPromptText(fullText, 19000),
      ].join("\n");

      const rewritten = await invokeEditorRewrite(prompt);
      setAssistantRewriteSuggestion({
        originalText: fullText,
        suggestedText: rewritten,
        range: { start: 0, end: fullText.length },
        createdAt: Date.now(),
        ...buildSuggestionAnchors(fullText, { start: 0, end: fullText.length }),
      });
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: `【全章逻辑重写】共${conflicts.length}处冲突` },
        { role: "assistant", content: "已生成全章重写建议（未应用），请确认后再替换。"},
      ]);
      setActiveTab("chat");
      addToast("success", "全章重写建议已生成，请确认后应用。");
    } catch (e) {
      console.error("全章重写建议生成失败:", e);
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `生成失败：${detail}` : "生成失败，请稍后重试。");
    } finally {
      setIsGeneratingChapterConflictRewrite(false);
    }
  };

  const handleApplyAllConflictRewriteSuggestions = async () => {
    if (!pid || !currentChapterId || conflicts.length === 0) return;
    if (isApplyingAllConflictRewrites || isGeneratingChapterConflictRewrite || generatingConflictRewriteIndex !== null) return;

    const confirmed = window.confirm(
      `将按当前审查结果逐条生成并替换可定位片段（共 ${conflicts.length} 条）。无法定位的条目会自动跳过，是否继续？`,
    );
    if (!confirmed) return;

    setIsApplyingAllConflictRewrites(true);
    setAssistantRewriteSuggestion(null);
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    const failedIndexes: number[] = [];

    try {
      const beatConstraintBlock = await buildBeatConstraintBlock(currentChapterId);
      for (let i = 0; i < conflicts.length; i += 1) {
        const conflict = conflicts[i];
        setGeneratingConflictRewriteIndex(i);
        const fullText = String(contentRef.current || content || "");
        const quote = String(conflict.quote || "").trim();
        const range = quote ? resolveRangeFromOriginalText(fullText, quote) : null;
        if (!range) {
          skipped += 1;
          continue;
        }

        const targetText = fullText.slice(range.start, range.end);
        if (!targetText.trim()) {
          skipped += 1;
          continue;
        }

        const prompt = buildConflictRewritePrompt(
          conflict,
          clipPromptText(fullText, 18000),
          beatConstraintBlock,
          targetText,
        );

        try {
          const rewritten = await invokeEditorRewrite(prompt);
          const suggestion: AssistantRewriteSuggestion = {
            originalText: targetText,
            suggestedText: rewritten,
            range,
            createdAt: Date.now(),
            ...buildSuggestionAnchors(fullText, range),
          };
          const ok = applySuggestionToEditor(suggestion, "", {
            silentFailure: true,
            silentSuccess: true,
            focusSelection: false,
          });
          if (ok) {
            applied += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          failedIndexes.push(i + 1);
          console.warn(`第${i + 1}条冲突建议生成失败:`, error);
        }
      }
    } finally {
      setGeneratingConflictRewriteIndex(null);
      setIsApplyingAllConflictRewrites(false);
    }

    if (applied > 0) {
      const tail = [
        skipped > 0 ? `跳过 ${skipped} 条` : "",
        failed > 0 ? `失败 ${failed} 条` : "",
      ].filter(Boolean).join("，");
      addToast("success", tail ? `已一键应用 ${applied} 条修复（${tail}）。` : `已一键应用 ${applied} 条修复。`);
      return;
    }

    if (failedIndexes.length > 0) {
      addToast("warning", `本次未成功应用。失败条目：${failedIndexes.join("、")}。`);
      return;
    }
    addToast("warning", "本次未找到可替换片段，建议先定位或刷新冲突列表后重试。");
  };

  const handleSendAiMessage = async () => {
    if (!aiInput.trim() || !pid || !currentChapterId) return;

    const userMsg = aiInput.trim();
    const history = chatMessages
      .slice(-10)
      .map((m) => ({
        role: m.role,
        content: String(m.content || "").trim().slice(0, 1200),
      }))
      .filter((m) => m.content.length > 0);
    setActiveTab('chat');
    setAiInput("");
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsAiLoading(true);

    try {
      const resp = await api<any>("/api/agents/chat", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          chapter_id: currentChapterId,
          message: userMsg,
          history,
        })
      });

      if (resp.resolved_model) console.log("[AgentChat] resolved_model:", resp.resolved_model);
      setChatMessages(prev => [...prev, { role: 'assistant', content: resp.reply }]);
    } catch (e) {
      console.error("AI 对话失败:", e);
      addToast("error", "调用 AI 失败，请检查模型配置");
      setChatMessages(prev => [...prev, { role: 'assistant', content: "抱歉，由于网络或配置原因，我暂时无法回答。请检查模型设置。" }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const buildSpeedModeBackgroundText = () => {
    const lines: string[] = [];
    const projectDesc = clipText(String(currentProject?.description || ""), 220);
    if (projectDesc) {
      lines.push(`- 项目概述：${projectDesc}`);
    }
    if (ctxChars.length > 0) {
      lines.push("- 角色卡：");
      ctxChars.slice(0, 8).forEach((item) => {
        lines.push(`  - ${clipText(item.label, 20)}：${clipText(item.detail, 58)}`);
      });
    }
    if (ctxWorld.length > 0) {
      lines.push("- 世界观：");
      ctxWorld.slice(0, 6).forEach((item) => {
        lines.push(`  - ${clipText(item.label, 24)}：${clipText(item.detail, 64)}`);
      });
    }
    if (ctxForeshadow.length > 0) {
      lines.push("- 伏笔状态：");
      ctxForeshadow.slice(0, 6).forEach((item) => {
        lines.push(`  - ${clipText(item.label, 24)}：${clipText(item.detail, 40)}`);
      });
    }
    if (lines.length === 0) {
      return "- 暂无可用背景资料，请在现有正文语境下合理续写。";
    }
    return lines.join("\n");
  };

  const pickPreviousTailForSpeed = (rawText: string) => {
    const normalized = String(rawText || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";

    const paragraphs = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (paragraphs.length === 0) return "";

    const last2 = paragraphs.slice(-2).join("\n\n").trim();
    if (last2.length > 200) {
      return last2;
    }

    const last3 = paragraphs.slice(-3).join("\n\n").trim();
    if (paragraphs.length >= 3 && last3.length > 200) {
      return last3;
    }

    return normalized.length > 200 ? normalized.slice(-200) : normalized;
  };

  const buildPreviousSummaryForSpeed = async (targetChapterNum: number) => {
    if (!Number.isFinite(targetChapterNum) || targetChapterNum <= 1) {
      return [
        "上一章概括：无（当前为首章）",
        "上一章结尾片段（末尾2-3段>200则取段落，否则取最后约200字）：无（当前为首章）",
      ].join("\n");
    }

    const previousChapter = chapters
      .filter((c) => Number(c.chapter_num || 0) < targetChapterNum)
      .slice()
      .sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0))
      .pop();

    if (!previousChapter?.id) {
      return [
        "上一章概括：无（未找到上一章）",
        "上一章结尾片段（末尾2-3段>200则取段落，否则取最后约200字）：无（未找到上一章）",
      ].join("\n");
    }

    const previousSynopsis = clipText(
      String((previousChapter as any)?.synopsis || (previousChapter as any)?.summary || ""),
      360,
    );

    let previousTail = "";
    try {
      const prevDetail = await api<any>(`/api/chapters/${previousChapter.id}`);
      const prevText = String((prevDetail?.paragraphs || []).map((p: any) => String(p?.content || "")).join("\n"))
        .replace(/\r\n/g, "\n")
        .trim();
      if (prevText) {
        previousTail = pickPreviousTailForSpeed(prevText);
      }
    } catch {
      previousTail = "";
    }

    const previousTitle = String((previousChapter as any)?.title || "").trim() || `第${Number(previousChapter.chapter_num || targetChapterNum - 1)}章`;
    return [
      `上一章：第${Number(previousChapter.chapter_num || targetChapterNum - 1)}章《${previousTitle}》`,
      `上一章概括：${previousSynopsis || "暂无概括（请结合结尾片段承接）"}`,
      "上一章结尾片段（末尾2-3段>200则取段落，否则取最后约200字）：",
      previousTail || "（上一章正文为空或读取失败，请仅依据上一章概括承接）",
    ].join("\n");
  };

  const buildReferenceExcerptForSpeed = () => {
    const selected = resolveCurrentSelectedText();
    if (!selected) return "";
    return clipText(selected, 680);
  };

  const buildNextChapterBridgeBlock = () => {
    if (!chapterNum || !nextChapter || !nextChapterSynopsisText) return "";
    const nextTitle = String((nextChapter as any)?.title || "").trim() || `第${nextChapterNum}章`;
    return [
      "【下一章衔接约束（必须遵守）】",
      `下一章：第${nextChapterNum}章《${nextTitle}》`,
      `下一章梗概：${clipText(nextChapterSynopsisText, 420)}`,
      "硬约束：",
      "1) 本章不得提前写出下一章梗概中的核心事件、关键答案、关键反转；",
      "2) 本章章尾必须给出与下一章梗概一致的进入动机/悬念触发/行动起点；",
      "3) 允许埋伏笔，但不得在本章提前完成下一章主事件。",
    ].join("\n");
  };

  const confirmProceedWithoutNextSynopsis = () => {
    if (!nextChapter || nextChapterSynopsisText) return true;
    const nextTitle = String((nextChapter as any)?.title || "").trim() || `第${nextChapterNum}章`;
    const ok = window.confirm(
      `检测到第${nextChapterNum}章《${nextTitle}》梗概为空。\n继续将按“无下一章梗概”生成（可能降低章节衔接稳定性）。\n是否继续？`,
    );
    if (!ok) {
      addToast("info", "已取消生成，请先补充下一章梗概。");
    }
    return ok;
  };

  const confirmReplaceChapterIfNeeded = (existingText: string) => {
    const hasExisting = String(existingText || "").trim().length > 0;
    if (!hasExisting) return { shouldReplace: false, proceed: true };
    const ok = window.confirm(
      "检测到本章已有正文。继续生成将覆盖本章正文（不再追加到末尾）。是否继续？",
    );
    return { shouldReplace: ok, proceed: ok };
  };

  const generateSpeedTrack = async () => {
    if (!currentChapterId) return;
    setIsGeneratingTrack(true);
    setShowGenerateMenu(false);
    addToast("info", "🚀 速度模式：先生成初稿（审核请手动触发）...");

    try {
      const existingText = String(contentRef.current || content || "");
      const replaceDecision = confirmReplaceChapterIfNeeded(existingText);
      if (!replaceDecision.proceed) return;
      const shouldReplaceExisting = replaceDecision.shouldReplace;
      const writingBaseText = shouldReplaceExisting ? "" : existingText;
      const existingChars = writingBaseText.length;
      const chapterTarget = resolveChapterWordTarget();
      const lenHint = buildLengthHintTags(existingChars, chapterTarget);
      const firstChapterOpeningBlock = buildFirstChapterOpeningBlock(chapterNum);
      if (!confirmProceedWithoutNextSynopsis()) return;
      const nextChapterBridgeBlock = buildNextChapterBridgeBlock();
      const chapterSynopsis = clipText(String((chapter as any)?.synopsis || (chapter as any)?.summary || ""), 360);
      const backgroundText = buildSpeedModeBackgroundText();
      const previousSummary = await buildPreviousSummaryForSpeed(chapterNum);
      const referenceExcerpt = buildReferenceExcerptForSpeed();
      const promptLines = [
        `[MODE:FAST][DRAFT_ONLY][LEN_TARGET:${lenHint.target}][LEN_MIN:${lenHint.min}][LEN_MAX:${lenHint.max}]`,
        "请按照要求创作故事，只输出可直接入稿的正文。",
        "",
        ...(chapterSynopsis ? ["剧情梗概：", chapterSynopsis, ""] : []),
        "要求：",
        "- 详略得当，语言流畅；",
        referenceExcerpt ? "- 保持与参考文段一致的文风；" : "- 贴合当前正文与项目资料形成的文风；",
        chapterNum === 1 ? "- 当前为第一章，必须写出开篇感并尽快建立阅读驱动力；" : "- 与本章已有内容自然衔接；",
        "- 场景、动作、情绪表达清晰，避免空泛套话；",
        "",
        "限制：",
        "- 不要加小标题；",
        "- 不要输出编号、注释、解释或自我说明；",
        "- 不和提供的背景资料矛盾；",
        "- 不要引入之前没有铺垫过的关键剧情；",
        ...(nextChapterBridgeBlock
          ? [
            "- 硬红线：下一章梗概中提到的内容在本章禁止出现（包括事件执行、关键答案揭示、关键反转落地）；仅允许铺垫进入下一章的动机或悬念。",
          ]
          : []),
        "- 若存在章节节拍，必须遵守节拍顺序与事件目标；",
        "- 段落之间保留一个空行（双换行）；",
        ...(chapterNum === 1 ? ["- 第一章不要写成中段章节续写口吻。"] : []),
        "",
        "背景资料：",
        backgroundText,
        "",
        "前情提要（上一章概括 + 上一章结尾片段）：",
        previousSummary,
        "",
        ...(referenceExcerpt ? ["参考文段：", referenceExcerpt, ""] : []),
        ...(nextChapterBridgeBlock ? [nextChapterBridgeBlock, ""] : []),
        ...(firstChapterOpeningBlock ? [firstChapterOpeningBlock, ""] : []),
        `当前正文约 ${existingChars} 字；本章目标约 ${lenHint.totalTarget} 字；本次建议输出约 ${lenHint.target} 字（可在 ${lenHint.min}-${lenHint.max} 字内）。`,
      ];
      const resp = await api<any>("/agent/invoke", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          agent_type: "chapter_writer",
          chapter_id: currentChapterId,
          message: promptLines.join("\n"),
        })
      });
      const generatedText = cleanChapterDraftOutput(resp?.content || "");
      if (!generatedText) {
        addToast("error", "本次未生成有效正文，请重试。");
        return;
      }
      const newText = shouldReplaceExisting
        ? generatedText
        : (existingText ? `${existingText}\n\n${generatedText}` : generatedText);
      handleContentChange(newText);
      addToast("success", shouldReplaceExisting ? "重生成完成，已覆盖本章正文。" : "生成完成！");
    } catch (e) {
      addToast("error", "生成失败，请检查 Agent 配置与网络");
    } finally {
      setIsGeneratingTrack(false);
    }
  };

  const runAiTraceCheck = async () => {
    if (!pid) return;
    const fullText = String(contentRef.current || content || "");
    const useSelection = aiTraceScope === "selection";
    let selectionSnapshot: { start: number; end: number; text: string } | null = null;
    if (useSelection) {
      selectionSnapshot = resolveSelectionForRewriteAction(fullText);
      if (!selectionSnapshot?.text.trim()) {
        addToast("warning", "请先在正文中选中要检测的文本。");
        return;
      }
    }
    if (!useSelection && !currentChapterId && !fullText.trim()) {
      addToast("warning", "请先选择章节或输入正文后再检测。");
      return;
    }
    setAiTraceLoading(true);
    try {
      const res = await api<AITracePreviewResult>("/api/content/ai-trace/preview", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          chapter_id: !useSelection ? currentChapterId || undefined : undefined,
          text: useSelection ? (selectionSnapshot?.text || "") : "",
          strictness: aiTraceStrictness,
        }),
      });
      setAiTraceResult(res);
      setAiTraceResultBaseRange(
        useSelection && selectionSnapshot
          ? { start: selectionSnapshot.start, end: selectionSnapshot.end }
          : null,
      );
      const resolvedInit: Record<string, boolean> = {};
      (res.hits || []).forEach((hit, idx) => {
        const key = `${String(hit.pattern_id || "hit")}::${idx}::${String(hit.evidence || "").slice(0, 40)}`;
        resolvedInit[key] = false;
      });
      setAiTraceResolvedMap(resolvedInit);
      addToast("success", `AI痕迹体检完成：${res.risk_score}/100`);
    } catch (e) {
      addToast("error", "AI痕迹检测失败，请稍后重试");
    } finally {
      setAiTraceLoading(false);
    }
  };

  const handleGenerateAiTraceRewrite = async (autoApply = false) => {
    if (!pid || !aiTraceResult) return;
    const fullText = String(contentRef.current || content || "");
    const useSelection = aiTraceScope === "selection";
    let targetText = "";
    let targetRange: { start: number; end: number } = { start: 0, end: 0 };

    if (useSelection) {
      const selection = resolveSelectionForRewriteAction(fullText);
      if (!selection) {
        addToast("warning", "请先选中要优化的正文片段。");
        return;
      }
      targetText = selection.text;
      targetRange = { start: selection.start, end: selection.end };
    } else {
      if (!fullText.trim()) {
        addToast("warning", "当前章节正文为空，无法生成建议。");
        return;
      }
      targetText = fullText;
      targetRange = { start: 0, end: fullText.length };
    }

    if (!targetText.trim()) {
      addToast("warning", "目标文本为空，无法生成建议。");
      return;
    }

    if (autoApply) {
      const ok = window.confirm(
        useSelection
          ? "将基于AI痕迹建议直接替换当前选中文本，是否继续？"
          : "将基于AI痕迹建议直接替换当前章节正文，是否继续？",
      );
      if (!ok) return;
    }

    setAiTraceRewriteLoading(true);
    try {
      const beatConstraintBlock = currentChapterId
        ? await buildBeatConstraintBlock(currentChapterId)
        : "【本章节拍】暂无节拍数据：保持当前事件推进，不新增关键剧情。";
      let rewritten = "";
      let targetedAppliedCount = 0;

      // 优先按命中片段逐个定点改写，避免整章重写偏移。
      const targetedRanges = buildAiTraceRewriteRanges(targetText, aiTraceResult.hits || []);
      if (targetedRanges.length > 0) {
        const targeted = await rewriteAiTraceHitRanges(targetText, targetedRanges, beatConstraintBlock);
        rewritten = targeted.rewrittenText;
        targetedAppliedCount = targeted.appliedCount;
      }

      // 若无法定位命中片段，则回退为整段降噪改写，保证功能可用。
      if (!String(rewritten || "").trim() || targetedAppliedCount === 0) {
        const hitLines = (aiTraceResult.hits || [])
          .slice(0, 10)
          .map((hit, idx) => `- [${idx + 1}] ${hit.pattern_name}(${Math.round(hit.confidence * 100)}%) 证据:${clipPromptText(hit.evidence, 120)} 建议:${clipPromptText(hit.advice, 120)}`);
        const strictnessLabel = aiTraceStrictness === "high" ? "高敏感" : aiTraceStrictness === "low" ? "低敏感" : "中敏感";
        const fallbackPrompt = [
          "请执行“AI痕迹降噪改写”任务。",
          "",
          "任务要求：",
          "1) 根据【AI痕迹报告】优化表达，降低模板化与机械化口吻；",
          "2) 保留原有事实、剧情推进、角色关系、人称与时态；",
          "3) 严格遵守【本章节拍】事件目标，不新增关键剧情；",
          "4) 优先增强动作、感官、物件与细节真实感；",
          "5) 只输出改写后的目标文本，不要解释。",
          useSelection ? "6) 仅改写目标片段，不要带出额外前后文；" : "6) 改写对象为当前章节正文全量内容；",
          "",
          beatConstraintBlock,
          "",
          "【AI痕迹报告】",
          `- 检测范围：${useSelection ? "选中文本" : "当前章节"}`,
          `- 敏感度：${strictnessLabel}`,
          `- 风险分：${aiTraceResult.risk_score}（${aiTraceResult.risk_level}）`,
          `- 摘要：${clipPromptText(aiTraceResult.summary || "", 600)}`,
          ...(hitLines.length > 0 ? hitLines : ["- 无明显命中"]),
          "",
          "【整章正文（用于风格与上下文）】",
          clipPromptText(fullText, 18000),
          "",
          "【待改写文本】",
          clipPromptText(targetText, 14000),
        ].join("\n");
        rewritten = await invokeEditorRewrite(fallbackPrompt);
      }

      if (targetedAppliedCount > 0) {
        addToast("info", `已按命中点定点改写 ${targetedAppliedCount} 处。`);
      }

      const fitted = await fitAiTraceRewriteToLength(rewritten, targetText, useSelection, beatConstraintBlock);
      rewritten = fitted.text;
      if (fitted.adjusted) {
        addToast("info", `已按目标字数校准（${fitted.beforeLen} -> ${fitted.afterLen}）。`);
      }

      const suggestion: AssistantRewriteSuggestion = {
        originalText: targetText,
        suggestedText: rewritten,
        range: targetRange,
        createdAt: Date.now(),
        ...buildSuggestionAnchors(fullText, targetRange),
      };

      if (autoApply) {
        const applied = applySuggestionToEditor(
          suggestion,
          useSelection ? "已按AI痕迹建议替换选中片段。" : "已按AI痕迹建议替换当前章节正文。",
        );
        if (applied) {
          setAssistantRewriteSuggestion(null);
          setShowAiTraceModal(false);
          setChatMessages((prev) => [
            ...prev,
            { role: "user", content: `【AI痕迹优化】${useSelection ? "选中片段直替" : "全章直替"}` },
            { role: "assistant", content: "已根据AI痕迹报告完成替换。"},
          ]);
          return;
        }
      }

      setAssistantRewriteSuggestion(suggestion);
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: `【AI痕迹优化】${useSelection ? "选中片段" : "当前章节"}` },
        { role: "assistant", content: "已生成AI痕迹优化建议正文（未应用），请确认后替换。"},
      ]);
      setActiveTab("chat");
      addToast("success", "AI痕迹建议正文已生成，请确认后应用。");
    } catch (e) {
      console.error("AI痕迹建议正文生成失败:", e);
      const detail = e instanceof Error ? e.message : "";
      addToast("error", detail ? `生成失败：${detail}` : "生成失败，请稍后重试。");
    } finally {
      setAiTraceRewriteLoading(false);
    }
  };

  function buildAiTraceHitKey(hit: AITraceHit, idx: number) {
    return `${String(hit.pattern_id || "hit")}::${idx}::${String(hit.evidence || "").slice(0, 40)}`;
  }

  const extractAiTraceEvidenceCandidates = (evidence: string) => {
    const raw = String(evidence || "").replace(/\s+/g, " ").trim();
    if (!raw) return [] as string[];
    const primary = raw.replace(/^[\.\u2026…]+|[\.\u2026…]+$/g, "").trim();
    const bucket: string[] = [];
    if (primary.length >= 6) bucket.push(primary);

    const byEllipsis = primary
      .split(/\.{2,}|…+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4);
    bucket.push(...byEllipsis);

    byEllipsis.forEach((part) => {
      part
        .split(/[，。！？；,.!?;:：]/)
        .map((seg) => seg.trim())
        .filter((seg) => seg.length >= 4)
        .forEach((seg) => bucket.push(seg));
    });

    const deduped = Array.from(new Set(bucket.map((item) => item.trim()).filter(Boolean)));
    deduped.sort((a, b) => b.length - a.length);
    return deduped.slice(0, 12);
  };

  type AITraceRewriteRange = {
    start: number;
    end: number;
    hit: AITraceHit;
    idx: number;
  };

  const locateAiTraceEvidenceRange = (
    fullText: string,
    evidence: string,
    expectedStart?: number | null,
    constrainRange?: { start: number; end: number } | null,
  ) => {
    const candidates = extractAiTraceEvidenceCandidates(evidence);
    if (candidates.length === 0) return null;
    const scopeStart = constrainRange
      ? Math.max(0, Math.min(constrainRange.start, fullText.length))
      : 0;
    const scopeEnd = constrainRange
      ? Math.max(scopeStart, Math.min(constrainRange.end, fullText.length))
      : fullText.length;
    const searchText = fullText.slice(scopeStart, scopeEnd);
    if (!searchText) return null;

    const expected = Number.isFinite(Number(expectedStart))
      ? Math.max(scopeStart, Math.min(Number(expectedStart), scopeEnd))
      : null;

    let best: { start: number; end: number; score: number } | null = null;
    for (const candidate of candidates) {
      const hits = findAllOccurrences(searchText, candidate);
      if (hits.length === 0) continue;
      for (const localStart of hits) {
        const start = scopeStart + localStart;
        const end = start + candidate.length;
        let score = candidate.length;
        if (expected !== null) {
          const distance = Math.abs(start - expected);
          score += Math.max(0, 280 - distance) / 6;
        }
        const prev = start > 0 ? fullText[start - 1] : "";
        const next = end < fullText.length ? fullText[end] : "";
        if (/[\n。！？!?；;，,、]/.test(prev)) score += 3;
        if (/[\n。！？!?；;，,、]/.test(next)) score += 3;
        if (!best || score > best.score) {
          best = { start, end, score };
        }
      }
    }
    if (best) return { start: best.start, end: best.end };

    for (const candidate of candidates) {
      if (candidate.length < 8) continue;
      const probe = candidate.slice(0, 8);
      const hits = findAllOccurrences(searchText, probe);
      if (hits.length > 0) {
        const localIdx = expected !== null
          ? hits.slice().sort((a, b) => Math.abs((scopeStart + a) - expected) - Math.abs((scopeStart + b) - expected))[0]
          : hits[0];
        const start = scopeStart + localIdx;
        const end = Math.min(scopeEnd, start + Math.max(8, Math.min(candidate.length, 80)));
        return { start, end };
      }
    }
    return null;
  };

  const resolveAiTraceHitRangeInText = (
    fullText: string,
    hit: AITraceHit,
    mode: "highlight" | "rewrite" = "highlight",
  ) => {
    const constrainRange = aiTraceResultBaseRange;
    const offset = constrainRange ? Math.max(0, Math.min(constrainRange.start, fullText.length)) : 0;
    const rawStart = Number(hit.start);
    const rawEnd = Number(hit.end);
    const expectedStart = Number.isFinite(rawStart) ? Math.floor(rawStart) + offset : null;

    const evidenceLocated = locateAiTraceEvidenceRange(
      fullText,
      String(hit.evidence || ""),
      expectedStart,
      constrainRange,
    );
    if (mode === "highlight" && evidenceLocated && evidenceLocated.end > evidenceLocated.start) {
      return evidenceLocated;
    }

    if (Number.isFinite(rawStart) && Number.isFinite(rawEnd)) {
      let start = Math.max(0, Math.min(Math.floor(rawStart) + offset, fullText.length));
      let end = Math.max(start, Math.min(Math.floor(rawEnd) + offset, fullText.length));
      if (constrainRange) {
        const cStart = Math.max(0, Math.min(constrainRange.start, fullText.length));
        const cEnd = Math.max(cStart, Math.min(constrainRange.end, fullText.length));
        start = Math.max(cStart, Math.min(start, cEnd));
        end = Math.max(start, Math.min(end, cEnd));
      }
      if (end > start) return { start, end };
    }
    if (evidenceLocated && evidenceLocated.end > evidenceLocated.start) return evidenceLocated;
    return null;
  };

  const resolveConflictQuoteRangeInText = (fullText: string, quote: string) => {
    const raw = String(quote || "");
    const exact = fullText.indexOf(raw);
    if (exact >= 0 && raw.length > 0) {
      return { start: exact, end: exact + raw.length };
    }
    const trimmed = raw.trim();
    if (trimmed) {
      const trimmedIdx = fullText.indexOf(trimmed);
      if (trimmedIdx >= 0) {
        return { start: trimmedIdx, end: trimmedIdx + trimmed.length };
      }
      const approx = resolveApproximateQuoteRange(fullText, trimmed, null);
      if (approx && approx.end > approx.start) return approx;
    }
    return null;
  };

  const buildMergedHighlightRanges = (
    fullText: string,
    aiRanges: Array<{ start: number; end: number; tip: string }>,
    conflictRanges: Array<{ start: number; end: number; tip: string }>,
  ): ChapterEditorHighlightRange[] => {
    const docLen = fullText.length;
    if (docLen <= 0) return [];
    if (aiRanges.length === 0 && conflictRanges.length === 0) return [];

    const points = new Set<number>([0, docLen]);
    [...aiRanges, ...conflictRanges].forEach((range) => {
      const start = Math.max(0, Math.min(range.start, docLen));
      const end = Math.max(start, Math.min(range.end, docLen));
      if (end <= start) return;
      points.add(start);
      points.add(end);
    });

    const sortedPoints = Array.from(points).sort((a, b) => a - b);
    const merged: ChapterEditorHighlightRange[] = [];
    const buildHoverText = (
      aiMatches: Array<{ tip: string }>,
      conflictMatches: Array<{ tip: string }>,
      kind: ChapterEditorHighlightRange["kind"],
    ) => {
      const unique = (items: Array<{ tip: string }>) =>
        Array.from(
          new Set(
            items
              .map((item) => String(item.tip || "").trim())
              .filter(Boolean),
          ),
        );
      const aiTips = unique(aiMatches);
      const conflictTips = unique(conflictMatches);
      const lines: string[] = [];
      if (kind === "ai_trace") {
        if (aiTips[0]) lines.push(aiTips[0]);
      } else if (kind === "conflict") {
        if (conflictTips[0]) lines.push(conflictTips[0]);
      } else {
        if (conflictTips[0]) lines.push(conflictTips[0]);
        if (aiTips[0]) lines.push(aiTips[0]);
      }
      const hiddenCount =
        Math.max(0, aiTips.length - (kind === "conflict" ? 0 : Math.min(1, aiTips.length))) +
        Math.max(0, conflictTips.length - (kind === "ai_trace" ? 0 : Math.min(1, conflictTips.length)));
      if (hiddenCount > 0) {
        lines.push(`另有 ${hiddenCount} 条相关问题`);
      }
      if (lines.length === 0) {
        if (kind === "conflict") return "逻辑冲突命中";
        if (kind === "overlap") return "AI痕迹与逻辑冲突重叠命中";
        return "AI痕迹命中";
      }
      return lines.join("\n\n");
    };

    for (let i = 0; i < sortedPoints.length - 1; i += 1) {
      const start = sortedPoints[i];
      const end = sortedPoints[i + 1];
      if (end <= start) continue;
      const aiMatches = aiRanges.filter((r) => r.start < end && start < r.end);
      const conflictMatches = conflictRanges.filter((r) => r.start < end && start < r.end);
      const hasAi = aiMatches.length > 0;
      const hasConflict = conflictMatches.length > 0;
      if (!hasAi && !hasConflict) continue;
      const kind: ChapterEditorHighlightRange["kind"] = hasAi && hasConflict
        ? "overlap"
        : hasConflict
          ? "conflict"
          : "ai_trace";
      const tooltip = buildHoverText(aiMatches, conflictMatches, kind);

      const last = merged[merged.length - 1];
      if (last && last.kind === kind && last.end === start && last.tooltip === tooltip) {
        last.end = end;
      } else {
        merged.push({ start, end, kind, tooltip });
      }
    }

    return merged;
  };

  const hasRangeOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
    aStart < bEnd && bStart < aEnd;

  const buildAiTraceRewriteRanges = (sourceText: string, hits: AITraceHit[]) => {
    const candidates: AITraceRewriteRange[] = [];
    hits.forEach((hit, idx) => {
      const range = resolveAiTraceHitRangeInText(sourceText, hit, "rewrite");
      if (!range) return;
      if (range.end - range.start < 2) return;
      candidates.push({ start: range.start, end: range.end, hit, idx });
    });
    if (candidates.length === 0) return [] as AITraceRewriteRange[];

    // 先按置信度挑选，再去重叠，避免重复改同一段。
    candidates.sort((a, b) => {
      const conf = (Number(b.hit.confidence) || 0) - (Number(a.hit.confidence) || 0);
      if (conf !== 0) return conf;
      return (b.end - b.start) - (a.end - a.start);
    });
    const selected: AITraceRewriteRange[] = [];
    for (const item of candidates) {
      if (selected.some((picked) => hasRangeOverlap(item.start, item.end, picked.start, picked.end))) {
        continue;
      }
      selected.push(item);
    }
    selected.sort((a, b) => a.start - b.start);
    return selected.slice(0, 10);
  };

  const rewriteAiTraceHitRanges = async (
    sourceText: string,
    ranges: AITraceRewriteRange[],
    beatConstraintBlock: string,
  ) => {
    let rewrittenText = String(sourceText || "");
    let appliedCount = 0;
    const rangesDesc = [...ranges].sort((a, b) => b.start - a.start);

    for (const item of rangesDesc) {
      const start = Math.max(0, Math.min(item.start, rewrittenText.length));
      const end = Math.max(start, Math.min(item.end, rewrittenText.length));
      if (end <= start) continue;

      const targetChunk = rewrittenText.slice(start, end);
      if (!String(targetChunk || "").trim()) continue;

      const leftContext = clipPromptText(rewrittenText.slice(Math.max(0, start - 260), start), 260);
      const rightContext = clipPromptText(
        rewrittenText.slice(end, Math.min(rewrittenText.length, end + 260)),
        260,
      );

      const localPrompt = [
        "请执行“AI痕迹定点改写”任务。",
        "",
        "硬约束：",
        "1) 只改写【目标片段】本身，不能改动片段外文字；",
        "2) 保留原有事实、剧情推进、角色关系、人称与时态；",
        "3) 严格遵守【本章节拍】事件目标，不新增关键剧情；",
        "4) 消除该命中点的模板化表达，优先替换为具体动作、物件、感官细节；",
        "5) 只输出改写后的【目标片段】，不要解释。",
        "",
        beatConstraintBlock,
        "",
        "【命中信息】",
        `- 类型：${item.hit.pattern_name}`,
        `- 建议：${clipPromptText(String(item.hit.advice || ""), 160)}`,
        `- 证据：${clipPromptText(String(item.hit.evidence || ""), 180)}`,
        "",
        "【前文（仅供衔接）】",
        leftContext || "（无）",
        "",
        "【目标片段（只改这里）】",
        clipPromptText(targetChunk, 2600),
        "",
        "【后文（仅供衔接）】",
        rightContext || "（无）",
      ].join("\n");

      try {
        const rewrittenChunk = await invokeEditorRewrite(localPrompt);
        if (!String(rewrittenChunk || "").trim()) continue;
        rewrittenText = rewrittenText.slice(0, start) + rewrittenChunk + rewrittenText.slice(end);
        appliedCount += 1;
      } catch (error) {
        console.warn("AI痕迹定点改写失败，跳过该命中:", error);
      }
    }

    return { rewrittenText, appliedCount };
  };

  const handleLocateAiTraceHit = (hit: AITraceHit, idx: number) => {
    const fullText = String(contentRef.current || content || "");
    if (!fullText.trim()) {
      addToast("warning", "当前正文为空，无法定位命中片段。");
      return;
    }
    const range = resolveAiTraceHitRangeInText(fullText, hit, "highlight");
    if (!range) {
      addToast("warning", `未能定位“${hit.pattern_name}”命中片段，请手动搜索相关语句。`);
      return;
    }
    const selected = fullText.slice(range.start, range.end).trim();
    setShowAiTraceModal(false);
    setIsViewMode(false);
    setSelectedRange(range);
    setAiTraceSelectedText(selected || fullText.slice(range.start, range.end));
    focusEditorRange(range.start, range.end);
    addToast("success", `已定位并高亮第${idx + 1}条命中片段。`);
  };

  const toggleAiTraceResolved = (hit: AITraceHit, idx: number, checked: boolean) => {
    const key = buildAiTraceHitKey(hit, idx);
    setAiTraceResolvedMap((prev) => ({ ...prev, [key]: checked }));
  };

  const handleClearAssistantChat = () => {
    if (isAiLoading) return;
    setChatMessages([]);
    setAssistantRewriteSuggestion(null);
    addToast("success", "已清空写作助手对话。");
  };

  const parseAiBeatLines = (raw: string) => {
    const blacklist = [
      /请提供|需要你提供|我需要|还需要|先告诉我|为了生成|才能生成|信息不足|补充信息|背景信息|请补充|先确认|再提供|是什么题材|主线剧情|推进到哪里|谁是主角/i,
      /无法生成|不能生成|暂时无法/i,
      /请问|能否|可以吗|是否|怎么|为何|为什么/i,
    ];
    const normalized = String(raw || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/^[\s>*\-•\d\.\)、\(\[\]【】]+/, "").trim())
      .filter(Boolean);

    const result: string[] = [];
    const seen = new Set<string>();
    for (const line of normalized) {
      if (line.length < 6 || line.length > 120) continue;
      if (/[？?]/.test(line)) continue;
      if (blacklist.some((re) => re.test(line))) continue;
      if (/^(我|你|请你|作为|为了|先)/.test(line)) continue;
      if (/^(输出|要求|说明|以下|请|注意)[:：]/.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      result.push(line);
      if (result.length >= 5) break;
    }
    return result;
  };

  const clipText = (text: string, limit: number) => {
    const v = String(text || "").trim();
    return v.length > limit ? `${v.slice(0, limit)}...` : v;
  };

  const resolveChapterWordTarget = () => {
    const fallbackByProject = Number(currentProject?.word_target || 0);
    let target = 5000;
    if (Number.isFinite(fallbackByProject) && fallbackByProject > 0) {
      target = Math.max(1500, Math.min(12000, Math.round(fallbackByProject / 22)));
    }
    const configuredChapterWords = Number(currentProject?.chapter_words || 0);
    if (Number.isFinite(configuredChapterWords) && configuredChapterWords > 0) {
      return Math.max(1500, Math.min(12000, Math.floor(configuredChapterWords)));
    }
    if (!pid) return target;
    try {
      const raw = localStorage.getItem(`project-autofill-extra-${pid}`);
      if (!raw) return target;
      const parsed = JSON.parse(raw) as { chapterWords?: number };
      const cw = Number(parsed?.chapterWords);
      if (Number.isFinite(cw) && cw > 0) {
        return Math.max(1500, Math.min(12000, Math.floor(cw)));
      }
    } catch { }
    return target;
  };
  const chapterWordTarget = resolveChapterWordTarget();

  const buildLengthHintTags = (existingChars: number, chapterTarget: number) => {
    const current = Math.max(0, Number(existingChars || 0));
    const totalTarget = Math.max(1500, Math.min(12000, Math.floor(chapterTarget || 5000)));
    let target = totalTarget - current;
    if (target <= 0) {
      target = Math.max(600, Math.min(2600, Math.round(totalTarget * 0.45)));
    }
    target = Math.max(500, Math.min(9000, Math.round(target)));
    const min = Math.max(400, Math.round(target * 0.85));
    const max = Math.max(min + 80, Math.round(target * 1.15));
    return { target, min, max, totalTarget };
  };

  const buildFallbackBeatLines = (
    chapterTitle: string,
    chapterSynopsis: string,
    chapterPhase: string,
    isFirstChapterFallback = false,
  ) => {
    const seeds: string[] = [];
    const synopsis = String(chapterSynopsis || "").trim();
    if (synopsis) {
      synopsis
        .split(/[。！？；;\n]/)
        .map((s) => s.trim().replace(/^[\d\.\)、\s]+/, ""))
        .filter((s) => s.length >= 8)
        .slice(0, 4)
        .forEach((s) => seeds.push(clipText(s, 40)));
    }
    const phaseHint = chapterPhase ? `（${chapterPhase}阶段）` : "";
    const titleHint = chapterTitle ? `《${chapterTitle}》` : "本章";
    const openingTemplates = (() => {
      const anchorBy = Math.max(2, Math.min(12, Math.round(firstChapterAnchorChapter || DEFAULT_FIRST_CHAPTER_ANCHOR_CHAPTER)));
      const modeForPrompt = effectiveFirstChapterOpeningMode;
      switch (modeForPrompt) {
        case "protagonist":
          return [
            `围绕${titleHint}${phaseHint}开场即触发异常，推动主角迅速入局`,
            "主角在阻力中给出首次行动选择并暴露短期目标",
            "冲突升级，抛出首章核心疑问或风险后果",
            "以未解问题或悬念钩子收束，形成下一章行动牵引",
          ];
        case "sidestory":
          return [
            `围绕${titleHint}${phaseHint}用旁线人物遭遇引爆异常事件`,
            "旁线行动暴露与主线相关的关键锚点（先不解释全貌）",
            `锚点带出潜在主线方向，暗示最晚第${anchorBy}章回收`,
            "以新风险或未解线索收束，引导读者继续追主线",
          ];
        case "decoy":
          return [
            `围绕${titleHint}${phaseHint}由假主角视角进入冲突现场`,
            "假主角的选择造成局势升级并制造认知误导",
            "在后段抛出视角错位信号，暗示真实主线并不一致",
            "以身份/因果悬念收束，为下一章反转预埋空间",
          ];
        case "cold_event":
        default:
          return [
            `围绕${titleHint}${phaseHint}先抛事件后果或异常现场`,
            "补入关键人物反应与即时行动，避免背景铺陈",
            "冲突继续升级，给出明确代价或风险",
            "用未解问题/下一步动机/悬念钩子收束，驱动后续阅读",
          ];
      }
    })();
    const normalTemplates = [
      `围绕${titleHint}${phaseHint}抛出本章首个实质冲突`,
      "关键阻力升级，迫使主角调整行动策略",
      "人物关系或利益对撞，触发新的情节拐点",
      "以明确后果或悬念收束，为下一段承接",
    ];
    const templates = isFirstChapterFallback ? openingTemplates : normalTemplates;
    const merged = [...seeds, ...templates];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of merged) {
      const v = clipText(item, 42);
      if (!v || seen.has(v)) continue;
      seen.add(v);
      result.push(v);
      if (result.length >= 5) break;
    }
    return result.slice(0, 5);
  };

  const autoGenerateBeatsForChapter = async (existingBeats: ChapterBeat[]) => {
    if (!currentChapterId || !pid) return 0;

    const [chapter, chaptersRes, bibleRes, outlinesRes, charsRes, worldRes] = await Promise.all([
      api<any>(`/api/chapters/${currentChapterId}`),
      api<any[]>(`/api/chapters/?project_id=${pid}`).catch(() => []),
      api<any | null>(`/api/pipeline/bible/latest?project_id=${pid}`).catch(() => null),
      api<any[]>(`/api/content/outlines?project_id=${pid}`).catch(() => []),
      api<any[]>(`/api/characters/?project_id=${pid}`).catch(() => []),
      api<any[]>(`/api/content/worldbuilding?project_id=${pid}`).catch(() => []),
    ]);
    const chapterNum = Number(chapter?.chapter_num || 0);
    const chapterTitle = String(chapter?.title || "").trim() || (chapterNum > 0 ? `第${chapterNum}章` : "当前章节");
    const chapterSynopsis = String(chapter?.synopsis || chapter?.summary || "").trim();
    const chapterPhase = String(chapter?.phase || "").trim();
    const bibleText = String(bibleRes?.content || "").trim();
    const outlines = Array.isArray(outlinesRes) ? outlinesRes : [];
    const characters = Array.isArray(charsRes) ? charsRes : [];
    const worldbuilding = Array.isArray(worldRes) ? worldRes : [];
    const chapterList = Array.isArray(chaptersRes) ? chaptersRes : [];
    const sortedChapters = chapterList
      .slice()
      .sort((a, b) => Number(a?.chapter_num || 0) - Number(b?.chapter_num || 0));
    const nextChapter = sortedChapters.find((c) => Number(c?.chapter_num || 0) > chapterNum);
    const nextChapterNum = Number(nextChapter?.chapter_num || 0);
    const nextChapterTitle = String(nextChapter?.title || "").trim() || (nextChapterNum > 0 ? `第${nextChapterNum}章` : "");
    const nextChapterSynopsis = String(nextChapter?.synopsis || nextChapter?.summary || "").trim();
    const splitSynopsisClauses = (text: string, limit = 10) =>
      String(text || "")
        .split(/[。！？；;\n]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 6)
        .slice(0, limit);
    const collectSynopsisNameTokens = (text: string, limit = 12) => {
      const stop = new Set([
        "透明人", "图书馆", "校园", "论坛", "梗概", "事件", "证词", "目击者", "值班", "保安",
        "时间", "形态", "根本", "矛盾", "情绪", "激动", "含糊", "当晚", "深夜", "帖子",
      ]);
      const raw = String(text || "").match(/[\u4e00-\u9fa5]{2,6}/g) || [];
      const tokens = raw
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && token.length <= 6)
        .filter((token) => !stop.has(token));
      return Array.from(new Set(tokens)).slice(0, limit);
    };
    const hardExecutionKeywords = [
      "采访", "询问", "问询", "约见", "会面", "见面", "联系", "拜访", "对话", "对谈",
      "盘问", "对质", "核对", "核实", "取证", "证词", "目击", "指认", "辨认", "值班", "保安",
      "前往", "进入", "抵达", "开始", "展开", "实施", "完成", "拿到", "确认", "证明", "查明",
    ];
    const softHookKeywords = [
      "准备", "决定", "打算", "计划", "将", "欲", "可能", "怀疑", "线索", "疑点", "预感",
      "未解", "悬念", "动机", "起点", "先", "待", "拟",
    ];
    const extractSynopsisKeywords = (text: string, limit = 24) => {
      const stop = new Set([
        "然后", "于是", "最后", "开始", "进行", "继续", "出现", "发生", "他们", "她们", "我们", "你们",
        "一个", "一些", "这个", "那个", "这里", "那里", "已经", "需要", "必须", "可以", "通过",
      ]);
      const normalized = String(text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, " ").trim();
      if (!normalized) return [] as string[];
      const tokens = normalized
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && token.length <= 12)
        .filter((token) => !stop.has(token))
        .filter((token) => !/^[0-9]+$/.test(token));
      return Array.from(new Set(tokens)).slice(0, limit);
    };
    const crossChapterActionFamilies = [
      ["采访", "询问", "问询", "约见", "会面", "见面", "联系", "拜访", "对话", "对谈", "盘问", "对质"],
      ["取证", "证词", "目击", "指认", "辨认", "核对", "核实", "值班", "保安"],
      ["前往", "进入", "抵达", "开始", "展开", "实施", "完成", "拿到", "确认", "证明", "查明"],
    ];
    const activeCrossChapterActionTokens = Array.from(
      new Set(
        crossChapterActionFamilies
          .filter((family) => family.some((token) => nextChapterSynopsis.includes(token)))
          .flat(),
      ),
    );
    const activeHardExecutionTokens = activeCrossChapterActionTokens.filter((token) =>
      hardExecutionKeywords.includes(token),
    );
    const nextRoleTokensFromProject = characters
      .map((c: any) => String(c?.name || "").trim())
      .filter(Boolean)
      .filter((name) => nextChapterSynopsis.includes(name));
    const nextRoleTokens = Array.from(
      new Set([...nextRoleTokensFromProject, ...collectSynopsisNameTokens(nextChapterSynopsis, 12)]),
    ).slice(0, 12);
    const sanitizeCurrentSynopsisForBeatPlanning = (currentSynopsis: string, upcomingSynopsis: string) => {
      if (!currentSynopsis || !upcomingSynopsis) {
        return { sanitized: currentSynopsis, removedCount: 0 };
      }
      const nextClauses = splitSynopsisClauses(upcomingSynopsis, 12);
      const nextKeywords = extractSynopsisKeywords(upcomingSynopsis, 28);
      if (nextClauses.length === 0 && nextKeywords.length === 0) {
        return { sanitized: currentSynopsis, removedCount: 0 };
      }
      const currentClauses = splitSynopsisClauses(currentSynopsis, 14);
      if (currentClauses.length === 0) {
        return { sanitized: currentSynopsis, removedCount: 0 };
      }
      const kept: string[] = [];
      let removedCount = 0;
      currentClauses.forEach((clause) => {
        const keywordHits = nextKeywords.filter((kw) => clause.includes(kw)).length;
        const maxSimilarity = nextClauses.reduce((max, nextClause) => Math.max(max, calcBigramSimilarity(clause, nextClause)), 0);
        const hasRoleToken = nextRoleTokens.some((token) => token.length >= 2 && clause.includes(token));
        const hasActionToken =
          activeCrossChapterActionTokens.length > 0 &&
          activeCrossChapterActionTokens.some((kw) => clause.includes(kw));
        if (
          maxSimilarity >= 0.58 ||
          (maxSimilarity >= 0.46 && keywordHits >= 2) ||
          keywordHits >= 4 ||
          (hasRoleToken && hasActionToken)
        ) {
          removedCount += 1;
          return;
        }
        kept.push(clause);
      });
      if (kept.length === 0) {
        return { sanitized: currentSynopsis, removedCount };
      }
      return { sanitized: kept.join("；"), removedCount };
    };
    const { sanitized: chapterSynopsisForPlanning, removedCount: synopsisFilteredCount } =
      sanitizeCurrentSynopsisForBeatPlanning(chapterSynopsis, nextChapterSynopsis);
    if (synopsisFilteredCount > 0 && nextChapterSynopsis) {
      addToast("info", `已从本章梗概中过滤 ${synopsisFilteredCount} 条可能越界句（参照下一章梗概）。`);
    }

    const existingBeatText = existingBeats
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .map((b) => `- ${b.content}`)
      .join("\n");

    const hasCoreData = Boolean(
      chapterSynopsisForPlanning || bibleText || outlines.length > 0 || characters.length > 0 || worldbuilding.length > 0
    );
    if (!hasCoreData) {
      addToast("warning", "缺少可用资料（圣经/大纲/角色/世界观/章节梗概），请先补充任一项后再生成节拍。");
      return 0;
    }

    const planningPrompt = [
      "你是小说章节节拍规划助手。",
      "请先使用“已给资料”生成节拍，禁止把追问写进结果。",
      "若资料不完整，先结合现有上下文自行补全，不要向用户提问。",
      "",
      "【章节信息】",
      `- 标题：${chapterTitle}`,
      `- 阶段：${chapterPhase || "未标注"}`,
      `- 梗概：${chapterSynopsisForPlanning || "暂无梗概，请结合下列资料与项目上下文合理补全。"}`,
      "",
      "【项目信息】",
      `- 题材：${currentProject?.genre || "未指定"}`,
      `- 项目简介：${clipText(String(currentProject?.description || ""), 200) || "未填写"}`,
      "",
      "【小说圣经摘要（若有）】",
      bibleText ? clipText(bibleText.replace(/\s+/g, " "), 1200) : "无",
      "",
      "【大纲锚点（若有）】",
      outlines.length > 0
        ? outlines
            .slice(0, 6)
            .map((o: any) => `- [${String(o?.phase || "")}] ${clipText(String(o?.title || ""), 24)}：${clipText(String(o?.content || ""), 80)}`)
            .join("\n")
        : "无",
      "",
      "【角色（若有）】",
      characters.length > 0
        ? characters
            .slice(0, 8)
            .map((c: any) => `- ${clipText(String(c?.name || ""), 16)}：${clipText(String(c?.identity || c?.personality || ""), 50)}`)
            .join("\n")
        : "无",
      "",
      "【世界观（若有）】",
      worldbuilding.length > 0
        ? worldbuilding
            .slice(0, 6)
            .map((w: any) => `- ${clipText(String(w?.title || ""), 22)}：${clipText(String(w?.content || ""), 70)}`)
            .join("\n")
        : "无",
    ];
    if (nextChapter && nextChapterSynopsis) {
      planningPrompt.push(
        "",
        "【下一章衔接对比（节拍必须遵守）】",
        `- 下一章：第${nextChapterNum}章《${nextChapterTitle}》`,
        `- 下一章梗概：${clipText(nextChapterSynopsis, 360)}`,
        synopsisFilteredCount > 0 ? `- 已过滤本章梗概中 ${synopsisFilteredCount} 条与下一章冲突信息` : "",
        "约束：",
        "A) 本章节拍不得提前写出下一章梗概中的核心事件、关键答案、关键反转；",
        "B) 本章末条节拍需要形成能自然进入下一章的动机/悬念/行动起点。",
      );
    } else if (nextChapter && !nextChapterSynopsis) {
      addToast("warning", `第${nextChapterNum}章梗概为空：本次节拍无法进行跨章对比约束。`);
    }
    if (existingBeatText) {
      planningPrompt.push("", "【已存在节拍（避免重复）】", existingBeatText);
    }
    const firstChapterBeatHint = buildFirstChapterBeatHint(chapterNum);
    if (firstChapterBeatHint) {
      planningPrompt.push("", firstChapterBeatHint);
    }
    planningPrompt.push(
      "",
      "输出要求（必须严格执行）：",
      "1) 只输出 4 到 5 行，每行 1 条节拍；",
      "2) 每条 16-40 字，必须是动作推进句，不要问题句；",
      "3) 禁止编号、禁止前后解释、禁止Markdown；",
      "4) 若信息不完整，按题材与上下文合理补全并直接输出；",
      "5) 结果中严禁出现提问、索要资料、让用户补充信息的句子。"
    );

    const runPlannerRaw = async (message: string) => {
      const resp = await api<any>("/agent/invoke", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          agent_type: "outline_writer",
          chapter_id: currentChapterId,
          message: `[DRAFT_ONLY]\n${message}`,
        }),
      });
      return String(resp?.content || "");
    };

    const runPlanner = async (message: string) => parseAiBeatLines(await runPlannerRaw(message));

    const parseViolationIndices = (raw: string, maxCount: number) => {
      const text = String(raw || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim();
      let indices: number[] = [];
      try {
        const parsed = JSON.parse(text);
        const arr = (parsed?.violating_indices || parsed?.indices || parsed?.violations || []) as any[];
        indices = arr
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v >= 1 && v <= maxCount);
      } catch {
        const fallback = text.match(/\d+/g) || [];
        indices = fallback
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v >= 1 && v <= maxCount);
      }
      return Array.from(new Set(indices)).sort((a, b) => a - b);
    };

    const detectViolationsLocal = (lines: string[]) => {
      if (!nextChapterSynopsis) return [] as number[];
      const clauses = splitSynopsisClauses(nextChapterSynopsis, 8);
      const keywords = extractSynopsisKeywords(nextChapterSynopsis, 24);
      const result: number[] = [];
      lines.forEach((line, idx) => {
        const text = String(line || "").trim();
        if (!text) return;
        const keywordHits = keywords.filter((kw) => text.includes(kw)).length;
        const clauseSimilarity = clauses.reduce((max, clause) => Math.max(max, calcBigramSimilarity(text, clause)), 0);
        const synopsisSimilarity = calcBigramSimilarity(text, nextChapterSynopsis);
        const isTailLine = idx === lines.length - 1;
        const hasRoleToken = nextRoleTokens.some((token) => token.length >= 2 && text.includes(token));
        const hasActionToken =
          activeCrossChapterActionTokens.length > 0 &&
          activeCrossChapterActionTokens.some((kw) => text.includes(kw));
        const hasHardExecution =
          activeHardExecutionTokens.length > 0 &&
          activeHardExecutionTokens.some((kw) => text.includes(kw));
        const hasSoftHook = softHookKeywords.some((kw) => text.includes(kw));
        const roleActionConflict = hasRoleToken && hasActionToken;
        if (roleActionConflict && !(isTailLine && hasSoftHook && !hasHardExecution)) {
          result.push(idx + 1);
          return;
        }
        if (
          clauseSimilarity >= 0.52 ||
          synopsisSimilarity >= 0.38 ||
          keywordHits >= 3 ||
          (isTailLine && hasHardExecution && keywordHits >= 2)
        ) {
          result.push(idx + 1);
        }
      });
      return result;
    };

    const detectViolationsWithModel = async (lines: string[]) => {
      if (!nextChapterSynopsis || lines.length === 0) return [] as number[];
      const draftText = lines.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
      const judgePrompt = [
        "你是章节边界审查器。请判断本章节拍是否提前写出了下一章核心事件。",
        "只输出 JSON：{\"violating_indices\":[序号,...]}，不要其它文本。",
        "",
        "【判定标准】",
        "若某条节拍已经写到下一章梗概中的关键事件/关键答案/关键反转，视为违规。",
        "若某条节拍出现下一章关键角色，并执行“下一章梗概中已出现动作家族”的同类动作（同义表达也算），视为违规。",
        "若只是“调查准备/动机铺垫/悬念触发”，不算违规。",
        "",
        "【下一章梗概】",
        clipText(nextChapterSynopsis, 520),
        "",
        "【本章节拍】",
        draftText,
      ].join("\n");
      const raw = await runPlannerRaw(judgePrompt);
      return parseViolationIndices(raw, lines.length);
    };

    const rewriteViolatingBeats = async (lines: string[], violatingIndices: number[]) => {
      if (!nextChapterSynopsis || lines.length === 0 || violatingIndices.length === 0) return lines;
      const draftText = lines.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
      const rewritePrompt = [
        "你是章节节拍重写器。请重写“违规序号”的节拍，消除提前触及下一章事件的问题。",
        `违规序号：${violatingIndices.join("、")}`,
        "",
        "【下一章梗概】",
        clipText(nextChapterSynopsis, 520),
        "",
        "【本章节拍草案】",
        draftText,
        "",
        "重写要求：",
        `1) 输出行数必须与草案完全一致（${lines.length}行），每行一条，不要编号、不要解释；`,
        "2) 违规条要改成“准备/决定/触发悬念”，不能写成下一章事件已发生；",
        "2.1) 若违规条涉及下一章关键角色，不得写成已接触/已问询/已对质，只能写成计划或未完成状态；",
        "3) 非违规条可微调措辞，但不得改变本章推进顺序；",
        "4) 仅最后一条可保留进入下一章的钩子。",
      ].join("\n");
      const rewritten = await runPlanner(rewritePrompt);
      if (rewritten.length === lines.length) return rewritten;
      return lines;
    };

    const enforceNextChapterGuard = async (lines: string[]) => {
      if (!nextChapterSynopsis || lines.length === 0) {
        return { ok: true, lines, violating: [] as number[] };
      }
      let current = lines.slice();
      for (let round = 0; round < 2; round += 1) {
        const local = detectViolationsLocal(current);
        let ai: number[] = [];
        try {
          ai = await detectViolationsWithModel(current);
        } catch {
          ai = [];
        }
        const violating = Array.from(new Set([...local, ...ai])).sort((a, b) => a - b);
        if (violating.length === 0) {
          return { ok: true, lines: current, violating: [] as number[] };
        }
        const rewritten = await rewriteViolatingBeats(current, violating);
        const changed = rewritten.length === current.length && rewritten.some((line, idx) => line !== current[idx]);
        current = rewritten;
        if (!changed) {
          return { ok: false, lines: current, violating };
        }
      }
      const finalLocal = detectViolationsLocal(current);
      let finalAi: number[] = [];
      try {
        finalAi = await detectViolationsWithModel(current);
      } catch {
        finalAi = [];
      }
      const finalViolating = Array.from(new Set([...finalLocal, ...finalAi])).sort((a, b) => a - b);
      return { ok: finalViolating.length === 0, lines: current, violating: finalViolating };
    };

    let beatLines = await runPlanner(planningPrompt.join("\n"));
    if (!beatLines.length) {
      const retryPrompt = [
        planningPrompt.join("\n"),
        "",
        "你上一次输出包含无效内容（追问/说明/格式不符）。",
        "现在请只输出 4-5 条“可直接写作”的动作节拍，不要出现任何问句和“请提供信息”语句。"
      ].join("\n");
      beatLines = await runPlanner(retryPrompt);
    }
    if (!beatLines.length) {
      beatLines = buildFallbackBeatLines(chapterTitle, chapterSynopsisForPlanning, chapterPhase, chapterNum === 1);
    }
    if (beatLines.length > 0 && nextChapterSynopsis) {
      const guarded = await enforceNextChapterGuard(beatLines);
      if (!guarded.ok) {
        const bad = guarded.violating.length > 0 ? guarded.violating.join("、") : "未知";
        addToast("warning", `节拍可能触及下一章核心内容（序号：${bad}）。已保留生成结果，请在节拍页手动调整。`);
      }
      if (guarded.lines.length === beatLines.length) {
        beatLines = guarded.lines;
      }
      const changed = guarded.lines.length === beatLines.length && guarded.lines.some((line, idx) => line !== beatLines[idx]);
      if (changed) addToast("info", "已执行跨章硬校验并自动修订冲突节拍。");
    }
    if (!beatLines.length) return 0;

    let currentOrder = existingBeats.length > 0 ? Math.max(...existingBeats.map((b) => b.order_index)) : 0;
    for (const text of beatLines) {
      currentOrder += 1;
      await api("/api/beats/", {
        method: "POST",
        body: JSON.stringify({
          chapter_id: currentChapterId,
          order_index: currentOrder,
          content: text,
        }),
      });
    }
    emitBeatsUpdated(currentChapterId, "auto-generate");
    return beatLines.length;
  };

  const generateBlendTrack = async () => {
    if (!currentChapterId || !pid) return;
    setIsGeneratingTrack(true);
    setShowGenerateMenu(false);
    addToast("info", "⚡ 品质速度（新）：先生成结构化提示词，再一次扩写...");

    try {
      const existingText = String(contentRef.current || content || "");
      const replaceDecision = confirmReplaceChapterIfNeeded(existingText);
      if (!replaceDecision.proceed) return;
      const shouldReplaceExisting = replaceDecision.shouldReplace;
      const writingBaseText = shouldReplaceExisting ? "" : existingText;
      const existingChars = countVisibleChars(writingBaseText);
      const chapterTarget = resolveChapterWordTarget();
      const lenHint = buildLengthHintTags(existingChars, chapterTarget);
      const chapterSynopsis = clipText(String((chapter as any)?.synopsis || (chapter as any)?.summary || ""), 360);
      const fallbackRoles = (() => {
        const fromContext = ctxChars
          .map((c) => clipSingleLine(String(c.label || ""), 12))
          .filter(Boolean)
          .slice(0, 8);
        if (fromContext.length > 0) return fromContext.join("、");
        return "按背景资料自动识别";
      })();
      const fallbackPlotLine = (() => {
        const phase = String((chapter as any)?.phase || "").trim();
        if (/感情|恋爱|情感/i.test(phase)) return "感情线";
        if (/支线|副线|旁线/i.test(phase)) return "支线";
        return "主线";
      })();
      const fallbackRhythm = "中";
      const fallbackHook = clipSingleLine(
        String(chapterSynopsis || "章尾保留未解问题或行动动机"),
        110,
      );
      if (!confirmProceedWithoutNextSynopsis()) return;
      const nextChapterBridgeBlock = buildNextChapterBridgeBlock();
      const backgroundText = buildSpeedModeBackgroundText();
      const referenceExcerpt = buildReferenceExcerptForSpeed();
      const previousSummary = await buildPreviousSummaryForSpeed(chapterNum);
      const firstChapterOpeningBlock = buildFirstChapterOpeningBlock(chapterNum);

      const plannerPromptLines = [
        "[DRAFT_ONLY]",
        "你是小说章节规划助手。请根据已给资料生成本章结构化写作卡片。",
        "必须只输出以下5行，禁止输出其它任何说明：",
        "**内容要点**：[本章核心事件和情节推进描述]",
        "**涉及角色**：[角色名，用顿号分隔]",
        "**情节线**：[主线/支线/感情线]",
        "**节奏类型**：[快/中/慢]",
        "**关键钩子**：[留给下一章的悬念或行动动机]",
        "",
        "章节信息：",
        `- 标题：${String((chapter as any)?.title || `第${chapterNum || "?"}章`)}`,
        `- 梗概：${chapterSynopsis || "无（请结合资料自动补全）"}`,
        `- 目标字数：约 ${lenHint.target} 字（范围 ${lenHint.min}-${lenHint.max} 字）`,
        "",
        "背景资料：",
        backgroundText,
        "",
        "前情提要（上一章概括 + 上一章结尾片段）：",
        previousSummary,
        "",
        ...(referenceExcerpt ? ["参考文段：", referenceExcerpt, ""] : []),
        ...(nextChapterBridgeBlock ? [nextChapterBridgeBlock, ""] : []),
        ...(firstChapterOpeningBlock ? [firstChapterOpeningBlock, ""] : []),
      ];
      const plannerResp = await api<any>("/agent/invoke", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          agent_type: "outline_writer",
          chapter_id: currentChapterId,
          message: plannerPromptLines.join("\n"),
        }),
      });
      const plannerRaw = String(plannerResp?.content || "").trim();
      const pickField = (label: string, fallback: string, maxChars = 220) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const reBold = new RegExp(`\\*\\*${escaped}\\*\\*\\s*[：:]\\s*([^\\n]+)`, "i");
        const rePlain = new RegExp(`${escaped}\\s*[：:]\\s*([^\\n]+)`, "i");
        const value = (plannerRaw.match(reBold)?.[1] || plannerRaw.match(rePlain)?.[1] || "").trim();
        return clipSingleLine(value || fallback, maxChars);
      };

      const contentPoints = pickField("内容要点", chapterSynopsis || "围绕本章主题推进关键事件并形成章尾牵引", 520);
      const involvedRoles = pickField("涉及角色", fallbackRoles, 120);
      const plotLine = pickField("情节线", fallbackPlotLine, 24);
      const rhythmType = pickField("节奏类型", fallbackRhythm, 8);
      const hookHint = pickField("关键钩子", fallbackHook, 150);

      const structuredBrief = [
        `**内容要点**：${contentPoints}`,
        `**涉及角色**：${involvedRoles}`,
        `**情节线**：${plotLine}`,
        `**节奏类型**：${rhythmType}`,
        `**关键钩子**：${hookHint}`,
      ];

      const promptLines = [
        `[MODE:BLEND][DRAFT_ONLY][LEN_TARGET:${lenHint.target}][LEN_MIN:${lenHint.min}][LEN_MAX:${lenHint.max}]`,
        "请按照以下结构化提示词创作故事，只输出可直接入稿正文。",
        "",
        ...structuredBrief,
        "",
        ...(chapterSynopsis ? ["剧情梗概：", chapterSynopsis, ""] : []),
        "要求：",
        "- 详略得当，语言流畅；",
        "- 保持与背景资料一致，不和既有设定冲突；",
        "- 场景、动作、情绪表达清晰；",
        "- 严格围绕“内容要点”推进，不偏题；",
        "",
        "限制：",
        "- 不要加小标题，不要输出编号、注释、解释；",
        "- 不要输出“***”“---”等分隔符号行；",
        "- 不要引入没有铺垫过的关键新设定；",
        "- 段落之间保留一个空行（双换行）；",
        ...(chapterNum === 1 ? ["- 第一章必须有明确开篇驱动力与章尾牵引。"] : []),
        "",
        "背景资料：",
        backgroundText,
        "",
        "前情提要（上一章概括 + 上一章结尾片段）：",
        previousSummary,
        "",
        ...(referenceExcerpt ? ["参考文段：", referenceExcerpt, ""] : []),
        ...(nextChapterBridgeBlock ? [nextChapterBridgeBlock, ""] : []),
        ...(firstChapterOpeningBlock ? [firstChapterOpeningBlock, ""] : []),
        `当前正文约 ${existingChars} 字；本章目标约 ${lenHint.totalTarget} 字；本次建议输出约 ${lenHint.target} 字（可在 ${lenHint.min}-${lenHint.max} 字内）。`,
      ];

      const resp = await api<any>("/agent/invoke", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          agent_type: "chapter_writer",
          chapter_id: currentChapterId,
          message: promptLines.join("\n"),
        }),
      });

      const generatedText = cleanChapterDraftOutput(resp?.content || "");
      if (!generatedText) {
        addToast("error", "本次未生成有效正文，请重试");
        return;
      }

      const newText = shouldReplaceExisting
        ? generatedText
        : (existingText ? `${existingText}\n\n${generatedText}` : generatedText);
      handleContentChange(newText);

      addToast("success", shouldReplaceExisting
        ? "品质速度（新）重生成完成：已覆盖本章正文"
        : "品质速度（新）生成完成",
      );
    } catch {
      addToast("error", "生成失败，请检查 Agent 配置与网络");
    } finally {
      setIsGeneratingTrack(false);
    }
  };

  const generateQualityTrack = async () => {
    if (!currentChapterId || !pid) return;
    setIsGeneratingTrack(true);
    setShowGenerateMenu(false);

    const updateBeatStatusSafe = async (beatId: string, status: ChapterBeat["status"]) => {
      try {
        await api(`/api/beats/${beatId}`, { method: "PUT", body: JSON.stringify({ status }) });
        emitBeatsUpdated(currentChapterId, `status:${status}`);
        return true;
      } catch {
        return false;
      }
    };

    try {
      // 1. Fetch beats
      let beats = await api<ChapterBeat[]>(`/api/beats/?chapter_id=${currentChapterId}`);
      let pendingBeats = beats.filter((b) => b.status === "pending" || b.status === "writing");
      const hasAnyBeats = beats.length > 0;

      if (!hasAnyBeats) {
        addToast("info", "当前无节拍，正在按章节标题/梗概自动生成节拍...");
        const created = await autoGenerateBeatsForChapter(beats);
        if (created > 0) {
          addToast("success", `已自动生成 ${created} 条节拍，开始写作`);
          beats = await api<ChapterBeat[]>(`/api/beats/?chapter_id=${currentChapterId}`);
          pendingBeats = beats.filter((b) => b.status === "pending" || b.status === "writing");
        }
      }

      if (pendingBeats.length === 0 && hasAnyBeats) {
        const doneBeats = beats.filter((b) => b.status === "done");
        if (doneBeats.length > 0) {
          addToast("info", "检测到节拍已全部写完：本次将按原节拍重新生成。");
          pendingBeats = doneBeats;
        }
      }

      if (pendingBeats.length === 0) {
        addToast("warning", "自动生成节拍失败。请补充章节梗概后重试，或手动新增1条节拍。");
        setIsGeneratingTrack(false);
        return;
      }

      const existingText = String(contentRef.current || content || "");
      const replaceDecision = confirmReplaceChapterIfNeeded(existingText);
      if (!replaceDecision.proceed) return;
      const shouldReplaceExisting = replaceDecision.shouldReplace;

      const orderedBeats = pendingBeats.sort((a, b) => a.order_index - b.order_index);
      addToast("info", `🎬 品质模式：按节拍逐条生成（共 ${orderedBeats.length} 条）...`);
      setActiveTab('beats');

      const chapterTarget = resolveChapterWordTarget();
      const firstChapterOpeningBlock = buildFirstChapterOpeningBlock(chapterNum);
      if (!confirmProceedWithoutNextSynopsis()) return;
      const nextChapterBridgeBlock = buildNextChapterBridgeBlock();
      let mergedContent = shouldReplaceExisting ? "" : String(contentRef.current || content || "").trim();
      const doneBeatOrders: number[] = [];
      const failedBeatOrders: number[] = [];
      let remainingBudget = Math.max(220, chapterTarget - countVisibleChars(mergedContent));

      for (let idx = 0; idx < orderedBeats.length; idx += 1) {
        const beat = orderedBeats[idx];
        await updateBeatStatusSafe(beat.id, "writing");
        const lenPerBeat = resolvePerBeatLengthHint(remainingBudget, orderedBeats.length - idx);
        const coveredBeatsText = orderedBeats
          .slice(0, idx)
          .map((b) => `- (${b.order_index}) ${clipSingleLine(b.content, 56)}`)
          .join("\n");

        try {
          const beatResp = await api<any>("/agent/invoke", {
            method: "POST",
            body: JSON.stringify({
              project_id: pid,
              agent_type: "chapter_writer",
              chapter_id: currentChapterId,
              message: `[MODE:QUALITY][DRAFT_ONLY][LEN_TARGET:${lenPerBeat.target}][LEN_MIN:${lenPerBeat.min}][LEN_MAX:${lenPerBeat.max}]
请为本章按顺序写当前这一条节拍，仅输出对应的新正文段落：
- [当前节拍${beat.order_index}] ${beat.content}

已写节拍（仅供衔接，禁止重写）：
${coveredBeatsText || "- 无"}

当前章节正文（仅供衔接，禁止改写前文）：
${clipPromptText(mergedContent, 2600)}

输出要求：
1) 只写当前节拍，不提前推进后续节拍；
2) 与当前正文结尾自然衔接，不重复前文；
3) 不要输出编号、标题、注释、说明；
4) 只输出可直接入稿正文；
5) 段落之间保留一个空行（双换行）。
${nextChapterBridgeBlock ? `\n${nextChapterBridgeBlock}` : ""}
${idx === 0 && firstChapterOpeningBlock ? `\n${firstChapterOpeningBlock}` : ""}`
            }),
          });

          const beatText = cleanChapterDraftOutput(beatResp?.content || "");
          if (!beatText) {
            failedBeatOrders.push(beat.order_index);
            await updateBeatStatusSafe(beat.id, "pending");
            continue;
          }

          mergedContent = mergedContent ? `${mergedContent}\n\n${beatText}` : beatText;
          handleContentChange(mergedContent);
          doneBeatOrders.push(beat.order_index);
          await updateBeatStatusSafe(beat.id, "done");
          remainingBudget = Math.max(220, chapterTarget - countVisibleChars(mergedContent));
        } catch {
          failedBeatOrders.push(beat.order_index);
          await updateBeatStatusSafe(beat.id, "pending");
        }
      }

      if (doneBeatOrders.length === 0) {
        addToast("error", "本次未生成有效正文，请重试。");
        return;
      }

      if (failedBeatOrders.length > 0) {
        addToast("warning", `以下节拍生成失败，已保留待写：${failedBeatOrders.join("、")}`);
      }
      emitBeatsUpdated(currentChapterId, "quality-finished");
      addToast("success", shouldReplaceExisting
        ? `重生成完成：已写 ${doneBeatOrders.length}/${orderedBeats.length} 条`
        : `品质生成完成：已写 ${doneBeatOrders.length}/${orderedBeats.length} 条`,
      );
    } catch (e) {
      try {
        const beats = await api<ChapterBeat[]>(`/api/beats/?chapter_id=${currentChapterId}`);
        const writingBeats = beats.filter((b) => b.status === "writing");
        if (writingBeats.length > 0) {
          await Promise.allSettled(
            writingBeats.map((beat) =>
              api(`/api/beats/${beat.id}`, { method: "PUT", body: JSON.stringify({ status: "pending" }) }),
            ),
          );
          emitBeatsUpdated(currentChapterId, "quality-reset-pending");
        }
      } catch { }
      addToast("error", "生成失败，请检查 Agent 配置与网络");
    } finally {
      setIsGeneratingTrack(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isAiLoading]);

  // 监听从 DebateRoomPanel 通过拖拽放入的文本
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (text) {
        setDebateQuotedText(text);
        setBottomMode('debate');
      }
    };
    window.addEventListener('debate-drop-text', handler);
    return () => window.removeEventListener('debate-drop-text', handler);
  }, []);

  // 围读消息自动滚动
  useEffect(() => {
    debateEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [debateMessages]);

  // 围读 SSE 逻辑
  const startDebate = async () => {
    if (!debateTopic.trim() && !debateQuotedText.trim()) return;
    if (!currentProject) {
      addToast("warning", "请先选择一个项目");
      return;
    }
    const quotedSnapshot = String(debateQuotedText || "").trim();
    let directorReply = "";
    setIsDebating(true);
    setDebateRewriteSuggestion(null);
    const fullTopic = debateQuotedText
      ? `【参考文本】\n${debateQuotedText}\n\n【我的问题】\n${debateTopic || "请围绕以上文本进行围读讨论"}`
      : debateTopic;
    const userDisplay = debateQuotedText
      ? `📋 [引用 ${debateQuotedText.length} 字]\n${debateTopic || "请围绕以上文本进行围读讨论"}`
      : debateTopic;
    setDebateMessages(prev => [...prev, {
      id: Date.now().toString(), agent: "user", name: "你", text: userDisplay, isComplete: true, type: "system"
    }]);
    try {
      const response = await fetch(`${API_BASE}/api/debate/start`, {
        method: "POST",
        headers: withLocalApiAuth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ project_id: currentProject.id, topic: fullTopic }),
      });
      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let activeAgentMessageId = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.event === "system") {
                setDebateMessages(prev => [...prev, { id: Date.now().toString(), agent: "system", name: "系统", text: data.text, isComplete: true, type: "system" }]);
              } else if (data.event === "agent_start") {
                const newId = Date.now().toString() + Math.random();
                activeAgentMessageId = newId;
                setDebateMessages(prev => [...prev, { id: newId, agent: data.agent, name: data.name, text: "", isComplete: false, type: "agent" }]);
              } else if (data.event === "token") {
                setDebateMessages(prev => prev.map(m => m.id === activeAgentMessageId ? { ...m, text: m.text + data.text } : m));
                if (data.agent === "director" && data.text) {
                  directorReply += String(data.text);
                }
              } else if (data.event === "agent_done") {
                setDebateMessages(prev => prev.map(m => m.id === activeAgentMessageId ? { ...m, isComplete: true } : m));
              } else if (data.event === "error") {
                setDebateMessages(prev => [...prev, { id: Date.now().toString(), agent: "system", name: "错误", text: data.text || "未知错误", isComplete: true, type: "system" }]);
              }
            } catch (e) { console.error("Parse error on SSE line", line, e); }
          }
        }
      }
      if (quotedSnapshot && directorReply.trim()) {
        await generateDebateRewriteSuggestion(quotedSnapshot, directorReply);
      }
    } catch (e) {
      addToast("error", "围读服务连接失败");
      console.error(e);
    } finally {
      setIsDebating(false);
      setDebateTopic("");
    }
  };

  const editorHighlights = useMemo(() => {
    if (!showIssueHighlights) return [] as ChapterEditorHighlightRange[];
    const fullText = String(contentRef.current || content || "");
    if (!fullText.trim()) return [] as ChapterEditorHighlightRange[];

    const aiRanges = (aiTraceResult?.hits || [])
      .map((hit, idx) => {
        const key = buildAiTraceHitKey(hit, idx);
        if (aiTraceResolvedMap[key]) return null;
        const range = resolveAiTraceHitRangeInText(fullText, hit, "highlight");
        if (!range || range.end <= range.start) return null;
        const pattern = String(hit.pattern_name || hit.pattern_id || "未知模式").trim();
        const advice = String(hit.advice || "").trim();
        const confidence = Number(hit.confidence);
        const confidenceText = Number.isFinite(confidence) ? `（置信${Math.round(confidence * 100)}%）` : "";
        const tip = advice
          ? `AI痕迹：${pattern}${confidenceText}\n建议：${advice}`
          : `AI痕迹：${pattern}${confidenceText}`;
        return { ...range, tip };
      })
      .filter((r): r is { start: number; end: number; tip: string } => Boolean(r && r.end > r.start));

    const conflictRanges = conflicts
      .map((item) => {
        const range = resolveConflictQuoteRangeInText(fullText, String(item.quote || ""));
        if (!range || range.end <= range.start) return null;
        const description = String(item.description || item.type || "疑似逻辑冲突").trim();
        const suggestion = String(item.suggestion || "").trim();
        const tip = suggestion
          ? `逻辑冲突：${description}\n建议：${suggestion}`
          : `逻辑冲突：${description}`;
        return { ...range, tip };
      })
      .filter((r): r is { start: number; end: number; tip: string } => Boolean(r && r.end > r.start));

    return buildMergedHighlightRanges(fullText, aiRanges, conflictRanges);
  }, [content, aiTraceResult, aiTraceResolvedMap, aiTraceResultBaseRange, conflicts, showIssueHighlights]);

  const toolbarGhostButtonBaseStyle = {
    height: 26,
    padding: "0 8px",
    borderRadius: 7,
    border: "1px solid var(--bg-border)",
    background: "var(--bg-card)",
    color: "var(--text-secondary)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    lineHeight: 1,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    transition: "all 0.2s",
  };

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8 }}>
            <BookOpen size={16} style={{ color: "var(--text-secondary)" }} />
            <input
              type="number"
              min={1}
              max={Math.max(1, maxChapterNum || totalChapterCount)}
              value={chapterJumpInput}
              onChange={(e) => setChapterJumpInput(e.target.value)}
              onBlur={applyChapterJumpInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyChapterJumpInput();
                }
              }}
              style={{
                width: 56,
                height: 24,
                borderRadius: 6,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                fontSize: 12,
                padding: "0 6px",
              }}
              title="输入章节号并回车跳转"
            />
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>/ {Math.max(0, totalChapterCount)}</span>
            <button
              onClick={() => setShowChapterMenu((prev) => !prev)}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                borderRadius: 6,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="打开章节列表"
            >
              <ChevronDown size={14} />
            </button>
            <span
              style={{
                maxWidth: 340,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontSize: 13,
                color: "var(--text-secondary)",
              }}
              title={chapter ? `第${chapter.chapter_num}章 · ${chapter.title}` : "无章节"}
            >
              {chapter ? `第${chapter.chapter_num}章 · ${chapter.title}` : "无章节"}
            </span>
            {showChapterMenu && (
              <div style={{
                position: "absolute",
                top: 30,
                left: 0,
                background: "var(--bg)",
                border: "1px solid var(--bg-border)",
                borderRadius: 8,
                padding: 4,
                zIndex: 30,
                minWidth: 260,
                maxHeight: "calc(100vh - 96px)",
                overflowY: "auto",
                boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
              }}>
                {chapters
                  .slice()
                  .sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0))
                  .map((c) => (
                    <button key={c.id} onClick={() => { setCurrentChapterId(c.id); setShowChapterMenu(false); }} style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "11px 12px",
                      border: "1px solid transparent",
                      borderRadius: 6,
                      background: c.id === currentChapterId ? "var(--accent-dim)" : "var(--bg)",
                      color: c.id === currentChapterId ? "var(--text-primary)" : "var(--text-secondary)",
                      fontSize: 12,
                      lineHeight: 1.45,
                      minHeight: 42,
                      cursor: "pointer",
                      marginBottom: 4,
                    }}>第{c.chapter_num}章 · {c.title}</button>
                  ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap" }}>
            {activeProfile?.profile_id && activeProfile.enabled ? (
              <div
                title={`当前规则包：${activeProfile.name || "未命名"} v${activeProfile.version || 1}${activeProfile.genre ? ` · ${activeProfile.genre}` : ""}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  borderRadius: 999,
                  border: "1px solid var(--accent-gold-dim)",
                  padding: "3px 10px",
                  fontSize: 11,
                  color: "var(--accent-gold)",
                  background: "rgba(255, 215, 0, 0.08)",
                  maxWidth: 260,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <BookOpenText size={12} />
                规则包：{activeProfile.name || "未命名"} v{activeProfile.version || 1}
              </div>
            ) : (
              <div
                title="当前项目未启用规则包"
                style={{
                  borderRadius: 999,
                  border: "1px solid var(--bg-border)",
                  padding: "3px 10px",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "var(--bg-card)",
                }}
              >
                未启用规则包
              </div>
            )}
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }} title={`当前已写 ${wordCount.toLocaleString()} 字；本章目标 ${chapterWordTarget.toLocaleString()} 字`}>
              当前 {wordCount.toLocaleString()} / 目标 {chapterWordTarget.toLocaleString()} 字
            </span>
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
              borderRadius: 6, fontSize: 12, background: "var(--bg-card)",
              color: saving ? "var(--accent-gold)" : "var(--text-secondary)"
            }}>
              {saving ? (
                <><Loader2 size={12} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> 保存中...</>
              ) : lastSaved ? (
                <><Check size={12} />已保存 {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
              ) : (
                <><Check size={12} />就绪</>
              )}
            </div>

            <div style={{ position: "relative" }}>
              <button disabled={conflictLoading} onClick={runConflictCheck} style={{
                ...toolbarGhostButtonBaseStyle,
                cursor: conflictLoading ? "not-allowed" : "pointer",
                opacity: conflictLoading ? 0.75 : 1,
              }}
              title="逻辑扫描：检查当前章节中的潜在设定、因果与时序冲突"
              >
                {conflictLoading ? <Loader2 size={14} className="animate-spin" /> : <BugPlay size={14} />}
                {conflictLoading ? "审查中..." : "逻辑扫描"}
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowAiTraceModal(true)}
              style={{
                ...toolbarGhostButtonBaseStyle,
              }}
              title="AI痕迹体检（文风风险评估）"
            >
              <Eye size={12} />
              AI痕迹
            </button>

            <button
              type="button"
              onClick={() => {
                const next = !showIssueHighlights;
                setShowIssueHighlights(next);
                if (typeof window !== "undefined") {
                  window.localStorage.setItem(ISSUE_HIGHLIGHTS_VISIBLE_KEY, next ? "1" : "0");
                }
              }}
              style={{
                ...toolbarGhostButtonBaseStyle,
                border: showIssueHighlights ? "1px solid rgba(33, 150, 243, 0.35)" : "1px solid var(--bg-border)",
                background: showIssueHighlights ? "rgba(33, 150, 243, 0.08)" : "var(--bg-card)",
                color: showIssueHighlights ? "#2196f3" : "var(--text-secondary)",
              }}
              title={showIssueHighlights ? "关闭正文问题高亮" : "开启正文问题高亮"}
            >
              {showIssueHighlights ? <Eye size={12} /> : <EyeOff size={12} />}
              高亮
            </button>

            <button onClick={toggleViewMode} style={{
              ...toolbarGhostButtonBaseStyle,
              background: isViewMode ? "var(--bg-input)" : "var(--bg-card)",
              color: isViewMode ? "var(--accent-gold)" : "var(--text-secondary)",
              border: isViewMode ? "1px solid var(--accent-gold-dim)" : "1px solid var(--bg-border)",
            }}
            title="实体识别（NER） 识别人/物/地点/组织/道具等实体，辅助上下文洞察"
            >
              <BookOpenText size={14} />
              NER
            </button>

            <div
              title={`NER 模型来源：${nerModelInfo.source}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 22,
                borderRadius: 999,
                border: nerModelInfo.enabled ? "1px solid var(--accent-gold-dim)" : "1px solid rgba(233, 30, 99, 0.35)",
                padding: "0 7px",
                fontSize: 9,
                lineHeight: 1,
                color: nerModelInfo.enabled ? "var(--accent-gold)" : "#e91e63",
                background: nerModelInfo.enabled ? "rgba(255, 215, 0, 0.08)" : "rgba(233, 30, 99, 0.08)",
                maxWidth: 180,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              NER：{nerModelInfo.modelLabel}{!nerModelInfo.enabled ? "（已禁用）" : ""}
            </div>

            <div style={{ position: "relative" }}>
              <button onClick={() => setShowGenerateMenu(!showGenerateMenu)} disabled={isGeneratingTrack} style={{
                ...toolbarGhostButtonBaseStyle,
                border: "none",
                background: "var(--accent-gold)",
                color: "#000",
                cursor: isGeneratingTrack ? "not-allowed" : "pointer",
                opacity: isGeneratingTrack ? 0.7 : 1,
              }}>
                {isGeneratingTrack ? <Loader2 size={14} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> : <Wand2 size={14} />}
                {isGeneratingTrack ? "AI创作中..." : "AI创作"}
              </button>
              {showGenerateMenu && (
                <div style={{ position: "absolute", top: 32, right: 0, background: "var(--bg)", border: "1px solid var(--accent-gold-dim)", borderRadius: 8, padding: 4, zIndex: 10, minWidth: 200, boxShadow: "0 4px 12px rgba(0,0,0,0.2)" }}>
                  {isFirstChapter && (
                    <div style={{ border: "1px solid var(--bg-border)", borderRadius: 6, padding: "7px 8px", marginBottom: 6, display: "flex", flexDirection: "column", gap: 6, background: "var(--bg)" }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: "var(--accent-gold)" }}>首章开篇规则</div>
                      <select
                        value={firstChapterOpeningMode}
                        onChange={(e) => setFirstChapterOpeningMode(e.target.value as FirstChapterOpeningMode)}
                        style={{
                          height: 24,
                          borderRadius: 6,
                          border: "1px solid var(--bg-border)",
                          background: "var(--bg)",
                          color: "var(--text-primary)",
                          fontSize: 11,
                          padding: "0 6px",
                        }}
                        title="第1章开篇类型"
                      >
                        <option value="auto">自动判断（推荐）</option>
                        <option value="cold_event">事件冷开</option>
                        <option value="protagonist">主角直入</option>
                        <option value="sidestory">旁线引子</option>
                        <option value="decoy">假主角开场</option>
                      </select>
                      <div style={{ fontSize: 10, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                        {getOpeningModeHint(firstChapterOpeningMode)}
                      </div>
                      {(firstChapterOpeningMode === "sidestory" || (firstChapterOpeningMode === "auto" && effectiveFirstChapterOpeningMode === "sidestory")) && (
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-secondary)" }}>
                          锚点回收≤第
                          <input
                            type="number"
                            min={2}
                            max={12}
                            step={1}
                            value={firstChapterAnchorChapter}
                            onChange={(e) => {
                              const nextRaw = Number(e.target.value);
                              if (!Number.isFinite(nextRaw)) return;
                              setFirstChapterAnchorChapter(Math.min(12, Math.max(2, Math.round(nextRaw))));
                            }}
                            style={{
                              width: 46,
                              height: 20,
                              borderRadius: 4,
                              border: "1px solid var(--bg-border)",
                              background: "var(--bg)",
                              color: "var(--text-primary)",
                              fontSize: 10,
                              padding: "0 4px",
                              outline: "none",
                            }}
                          />
                          章
                        </label>
                      )}
                    </div>
                  )}
                  <button onClick={generateSpeedTrack} style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "10px 12px", border: "none", borderRadius: 6,
                    background: "transparent", color: "var(--text-primary)", fontSize: 13, cursor: "pointer", marginTop: 4
                  }}>
                    <Zap size={15} color="var(--accent-gold)" /> <div style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 600 }}>速度推土机</span><span style={{ fontSize: 10, color: "var(--text-secondary)" }}>一次成稿，无视节拍约束</span></div>
                  </button>
                  <button onClick={generateQualityTrack} style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "10px 12px", border: "none", borderRadius: 6,
                    background: "transparent", color: "var(--text-primary)", fontSize: 13, cursor: "pointer", marginTop: 4
                  }}>
                    <LayoutList size={15} color="#4CAF50" /> <div style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 600 }}>品质导演</span><span style={{ fontSize: 10, color: "var(--text-secondary)" }}>严格按右侧节拍，逐段生成</span></div>
                  </button>
                  <button onClick={generateBlendTrack} style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "10px 12px", border: "none", borderRadius: 6,
                    background: "transparent", color: "var(--text-primary)", fontSize: 13, cursor: "pointer", marginTop: 4
                  }}>
                    <Wand2 size={15} color="#00BCD4" /> <div style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontWeight: 600 }}>品质速度（新）</span><span style={{ fontSize: 10, color: "var(--text-secondary)" }}>AI先生成结构化提示词，再一次扩写</span></div>
                  </button>
                </div>
              )}
            </div>
            </div>
        </div>
        {showAiTraceModal && (
          <div
            onClick={() => setShowAiTraceModal(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1200,
              background: "rgba(0, 0, 0, 0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
            }}
          >
            <div
              className="solid-popup"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(760px, 100%)",
                maxHeight: "82vh",
                overflow: "hidden",
                border: "1px solid var(--bg-border)",
                borderRadius: 12,
                background: "var(--bg-popup)",
                boxShadow: "0 16px 36px rgba(0,0,0,0.24)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: 14,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>AI痕迹体检</div>
                <button
                  type="button"
                  onClick={() => setShowAiTraceModal(false)}
                  style={{
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-popup-soft)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: 12,
                    borderRadius: 8,
                    padding: "4px 10px",
                  }}
                >
                  关闭
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto auto", gap: 8, alignItems: "center" }}>
                <select
                  value={aiTraceScope}
                  onChange={(e) => setAiTraceScope(e.target.value as "chapter" | "selection")}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-popup-soft)",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    padding: "0 8px",
                  }}
                >
                  <option value="chapter">当前章节</option>
                  <option value="selection">选中文本</option>
                </select>
                <select
                  value={aiTraceStrictness}
                  onChange={(e) => setAiTraceStrictness(e.target.value as "low" | "medium" | "high")}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-popup-soft)",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    padding: "0 8px",
                  }}
                >
                  <option value="low">低敏感</option>
                  <option value="medium">中敏感</option>
                  <option value="high">高敏感</option>
                </select>
                <button
                  type="button"
                  onClick={runAiTraceCheck}
                  disabled={aiTraceLoading}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid var(--bg-border)",
                    background: aiTraceLoading ? "var(--bg-border)" : "var(--accent-gold)",
                    color: aiTraceLoading ? "var(--text-secondary)" : "#000",
                    cursor: aiTraceLoading ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "0 12px",
                  }}
                >
                  {aiTraceLoading ? "检测中..." : "开始检测"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerateAiTraceRewrite(false)}
                  disabled={aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid var(--bg-border)",
                    background: "var(--bg-popup-soft)",
                    color: (aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult) ? "var(--text-secondary)" : "var(--text-primary)",
                    cursor: (aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult) ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "0 10px",
                  }}
                  title="先生成建议正文，再由你确认是否应用"
                >
                  {aiTraceRewriteLoading ? "生成中..." : "生成建议"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerateAiTraceRewrite(true)}
                  disabled={aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid var(--bg-border)",
                    background: (aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult) ? "var(--bg-border)" : "var(--accent-gold)",
                    color: (aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult) ? "var(--text-secondary)" : "#000",
                    cursor: (aiTraceLoading || aiTraceRewriteLoading || !aiTraceResult) ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "0 10px",
                  }}
                  title="生成后直接替换正文（会先二次确认）"
                >
                  {aiTraceRewriteLoading ? "替换中..." : "应用替换"}
                </button>
              </div>

              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                说明：用于文风风险评估，不用于判断作者身份。
                {aiTraceScope === "selection" && (
                  <span> 当前已选：{aiTraceSelectedText ? `${Math.min(aiTraceSelectedText.length, 9999)} 字` : "未选中"}</span>
                )}
              </div>

              <div className="popup-surface" style={{ flex: 1, minHeight: 0, overflowY: "auto", border: "1px solid var(--bg-border)", borderRadius: 10, background: "var(--bg-popup-soft)", padding: 10 }}>
                {!aiTraceResult ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>暂无检测结果。</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                        风险分：{aiTraceResult.risk_score}
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          borderRadius: 999,
                          padding: "3px 8px",
                          border: "1px solid var(--bg-border)",
                          color: aiTraceResult.risk_level === "high"
                            ? "#e57373"
                            : aiTraceResult.risk_level === "medium"
                              ? "#f6c26b"
                              : "#81c784",
                        }}
                      >
                        {aiTraceResult.risk_level === "high" ? "高风险" : aiTraceResult.risk_level === "medium" ? "中风险" : "低风险"}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      {aiTraceResult.summary}
                    </div>
                    {aiTraceResult.hits.length > 0 && (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        修正确认：{aiTraceResolvedCount}/{aiTraceResult.hits.length}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {aiTraceResult.hits.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>未命中明显模式。</div>
                      ) : aiTraceResult.hits.map((hit, idx) => (
                        <div key={`${hit.pattern_id}-${idx}`} style={{
                          border: aiTraceResolvedMap[buildAiTraceHitKey(hit, idx)]
                            ? "1px solid rgba(76, 175, 80, 0.45)"
                            : "1px dashed var(--bg-border)",
                          borderRadius: 8,
                          padding: "8px 9px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 5
                        }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
                              {hit.pattern_name}（{Math.round(hit.confidence * 100)}%）
                            </div>
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                              <button
                                type="button"
                                onClick={() => handleLocateAiTraceHit(hit, idx)}
                                style={{
                                  border: "1px solid var(--bg-border)",
                                  borderRadius: 6,
                                  background: "var(--bg-popup-soft)",
                                  color: "var(--text-primary)",
                                  cursor: "pointer",
                                  fontSize: 11,
                                  padding: "2px 7px",
                                }}
                                title="关闭弹窗并在正文中定位高亮"
                              >
                                定位高亮
                              </button>
                              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(aiTraceResolvedMap[buildAiTraceHitKey(hit, idx)])}
                                  onChange={(e) => toggleAiTraceResolved(hit, idx, e.target.checked)}
                                  style={{ width: 13, height: 13, margin: 0, accentColor: "#4CAF50" }}
                                />
                                已修正
                              </label>
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>{hit.evidence}</div>
                          <div style={{ fontSize: 12, color: "var(--accent-gold)", lineHeight: 1.55 }}>{hit.advice}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <div style={{
          flex: 1,
          background: "var(--bg-card)",
          borderRadius: 12,
          padding: 20,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
          gap: 12,
        }}>
          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingBottom: 8,
            maxWidth: 980,
            width: "100%",
            margin: "0 auto",
          }}>
            <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
              <div style={{ position: "relative", display: "inline-flex", alignItems: "baseline", gap: 18, minWidth: 0, maxWidth: "100%" }}>
                <span style={{
                  fontSize: 25,
                  fontWeight: 760,
                  color: "var(--text-primary)",
                  lineHeight: 1.12,
                  whiteSpace: "nowrap",
                  letterSpacing: "0.01em",
                }}>
                  {chapter ? `第${chapter.chapter_num}章` : "第?章"}
                </span>
                <span
                  ref={chapterTitleMeasureRef}
                  aria-hidden
                  style={{
                    position: "absolute",
                    visibility: "hidden",
                    pointerEvents: "none",
                    whiteSpace: "pre",
                    fontSize: 25,
                    fontWeight: 760,
                    lineHeight: 1.12,
                    letterSpacing: "0.01em",
                    fontFamily: "inherit",
                  }}
                />
                <input
                  className="chapter-title-input"
                  type="text"
                  value={chapterTitleDraft}
                  onChange={(e) => setChapterTitleDraft(e.target.value)}
                  onBlur={() => {
                    void saveChapterTitle();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveChapterTitle();
                    }
                  }}
                disabled={!chapter || isSavingChapterTitle}
                placeholder={chapter ? "输入章节标题" : "请先选择章节"}
                style={{
                  width: chapterTitleInputWidth,
                  height: 44,
                  minWidth: 0,
                  borderRadius: 0,
                  border: "none",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: 25,
                  fontWeight: 760,
                  lineHeight: 1.12,
                  padding: 0,
                  outline: "none",
                  letterSpacing: "0.01em",
                  textAlign: "left",
                  boxShadow: "none",
                  appearance: "none",
                  WebkitAppearance: "none",
                  MozAppearance: "textfield",
                }}
              />
            </div>
            </div>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              flexWrap: "wrap",
              fontSize: 11,
              color: "var(--text-secondary)",
            }}>
              <span>阶段：{String(chapter?.phase || "").trim() || "未设置"}</span>
              <span>字数：{wordCount.toLocaleString()}</span>
              <span>
                {lastSaved
                  ? `保存于 ${new Date(lastSaved).toLocaleDateString("zh-CN")} ${new Date(lastSaved).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
                  : "尚未保存"}
              </span>
              {isSavingChapterTitle ? <span>标题保存中...</span> : null}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {isViewMode ? (
              <div style={{ width: "100%", height: "100%", overflowY: "auto" }}>
                {nerLoading ? (
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100%", color: "var(--text-secondary)", gap: 12 }}>
                    <Loader2 size={24} className="animate-spin" />
                    <span style={{ fontSize: 13 }}>正在进行深度实体溯源分析...</span>
                  </div>
                ) : (
                  <EntityHighlighter content={content} entities={nerEntities} />
                )}
              </div>
            ) : (
              <ChapterRichEditor
                ref={chapterEditorRef}
                value={content}
                onChange={handleContentChange}
                onSelectionChange={handleEditorSelectionChange}
                placeholderText="开始创作..."
                highlights={editorHighlights}
                readOnly={!currentChapterId}
              />
            )}
          </div>
        </div>
      </div>
      <div className="workshop-side-rail" style={{ width: 320, borderLeft: "1px solid var(--bg-border)", display: "flex", flexDirection: "column", padding: "24px 20px", minHeight: 0 }}>
        <div className="workshop-side-shell" style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-card)",
          border: "1px solid var(--bg-border)",
          borderRadius: 12,
          boxShadow: "var(--shadow-sm)"
        }}
          onDragOverCapture={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDropCapture={handleDebateTextDrop}
        >
          {/* ====== 上方区域（flex:1）：Tab+内容 OR 围读消息 ====== */}
          <div className="workshop-side-main" style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "10px 10px 0"
          }}>
          {bottomMode === 'debate' ? (
            /* 围读消息区 */
            <div className="workshop-panel-surface" style={{
              flex: 1, minHeight: 0, overflowY: "auto", padding: 12,
              display: "flex", flexDirection: "column", gap: 10,
              background: "var(--bg-input)", borderRadius: 10, border: "1px solid var(--bg-border)"
            }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={handleDebateTextDrop}
            >
              {debateMessages.length === 0 ? (
                <div style={{
                  height: "100%", display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  color: "var(--text-secondary)", opacity: 0.5, gap: 8, textAlign: "center"
                }}>
                  <MessageSquare size={28} />
                  <span style={{ fontSize: 11, lineHeight: 1.5 }}>
                    选中左侧文字拖到这里，<br />或在下方输入你的剧情卡壳点
                  </span>
                </div>
              ) : (
                debateMessages.map((m) => (
                  <div key={m.id} style={{
                    display: "flex", gap: 8,
                    justifyContent: m.type === "system" && m.agent === "user" ? "flex-end" : "flex-start"
                  }}>
                    {m.type === "agent" && (
                      <div style={{
                        width: 24, height: 24, borderRadius: "50%",
                        background: getDebateAgentColor(m.agent) + "20",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0, fontSize: 12
                      }}>
                        {m.agent === "villain" ? "😈" : m.agent === "reader" ? "🧐" : m.agent === "architect" ? "🌍" : "🎬"}
                      </div>
                    )}
                    <div style={{
                      maxWidth: "85%",
                      background: m.type === "system" ? "transparent" : "var(--bg)",
                      border: m.type === "system" ? "none" : "1px solid var(--bg-border)",
                      padding: m.type === "system" ? "0 8px" : "8px 10px",
                      borderRadius: 8,
                      color: m.type === "system" ? "var(--text-secondary)" : "var(--text-primary)",
                      fontStyle: m.type === "system" ? "italic" : "normal",
                      fontSize: 12, lineHeight: 1.6
                    }}>
                      {m.type === "agent" && (
                        <div style={{
                          fontSize: 10, fontWeight: 600, color: getDebateAgentColor(m.agent),
                          marginBottom: 2, display: "flex", alignItems: "center", gap: 4
                        }}>
                          {m.name} {!m.isComplete && <span className="animate-pulse">...</span>}
                        </div>
                      )}
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                    </div>
                  </div>
                ))
              )}
              {(isGeneratingDebateSuggestion || debateRewriteSuggestion) && (
                <div className="workshop-panel-surface" style={{
                  marginTop: 6,
                  padding: "8px 10px",
                  background: "var(--bg-input)",
                  border: "1px solid rgba(33, 150, 243, 0.28)",
                  borderRadius: 8,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#2196f3" }}>
                      ✍ 围读建议正文（待你确认）
                    </span>
                    {debateRewriteSuggestion && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button
                          onClick={applyDebateSuggestionToContent}
                          style={{
                            border: "1px solid rgba(76, 175, 80, 0.35)",
                            borderRadius: 6,
                            padding: "2px 8px",
                            fontSize: 10,
                            fontWeight: 600,
                            background: "rgba(76, 175, 80, 0.14)",
                            color: "#2e7d32",
                            cursor: "pointer",
                          }}
                        >
                          应用到正文
                        </button>
                        <button
                          onClick={() => setDebateRewriteSuggestion(null)}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            padding: "2px 8px",
                            fontSize: 10,
                            background: "transparent",
                            color: "var(--text-secondary)",
                            cursor: "pointer",
                          }}
                        >
                          关闭
                        </button>
                      </div>
                    )}
                  </div>

                  {isGeneratingDebateSuggestion ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                      <Loader2 size={12} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                      正在根据围读结论生成建议正文...
                    </div>
                  ) : debateRewriteSuggestion ? (
                    <div style={{
                      maxHeight: 176,
                      overflowY: "auto",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--bg)",
                      border: "1px solid var(--bg-border)",
                      color: "var(--text-primary)",
                    }}>
                      {debateRewriteSuggestion.suggestedText}
                    </div>
                  ) : null}
                </div>
              )}
              <div ref={debateEndRef} />
            </div>
          ) : (
            /* 原有 Tab + 内容 */
            <>
              <div className="workshop-panel-surface" style={{ display: "flex", background: "var(--bg-input)", borderRadius: 8, padding: 4, border: "1px solid var(--bg-border)" }}>
                <button onClick={() => setActiveTab('beats')} style={{
                  flex: 1, padding: "6px 0", border: "none", background: activeTab === 'beats' ? "var(--bg-input)" : "transparent",
                  color: activeTab === 'beats' ? "var(--text-primary)" : "var(--text-secondary)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>章节节拍</button>
                <button onClick={() => setActiveTab('context')} style={{
                  flex: 1, padding: "6px 0", border: "none", background: activeTab === 'context' ? "var(--bg-input)" : "transparent",
                  color: activeTab === 'context' ? "var(--text-primary)" : "var(--text-secondary)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>上下文</button>
                <button onClick={() => setActiveTab('conflict')} style={{
                  flex: 1, padding: "6px 0", border: "none", background: activeTab === 'conflict' ? "rgba(244, 67, 54, 0.1)" : "transparent",
                  color: activeTab === 'conflict' ? "#f44336" : "var(--text-secondary)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>逻辑审查</button>
                <button onClick={() => setActiveTab('chat')} style={{
                  flex: 1, padding: "6px 0", border: "none", background: activeTab === 'chat' ? "rgba(33, 150, 243, 0.12)" : "transparent",
                  color: activeTab === 'chat' ? "#2196f3" : "var(--text-secondary)", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
                }}>聊天对话</button>
              </div>

              <div className="workshop-panel-surface" style={{
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                background: "var(--bg-input)",
                border: "1px solid var(--bg-border)",
                borderRadius: 10,
                padding: 10
              }}>
                {activeTab === 'beats' ? (
                  <BeatSheetSidebar chapterId={currentChapterId} />
                ) : activeTab === 'conflict' ? (
                  <div style={{ flex: 1, overflow: "auto" }}>
                    <ConflictPanel
                      conflicts={conflicts}
                      summary={conflictSummary}
                      loading={conflictLoading}
                      onGenerateRewriteSuggestion={handleGenerateConflictRewriteSuggestion}
                      generatingRewriteIndex={generatingConflictRewriteIndex}
                      onGenerateChapterRewriteSuggestion={handleGenerateChapterConflictRewrite}
                      generatingChapterRewrite={isGeneratingChapterConflictRewrite}
                      onApplyAllRewriteSuggestions={handleApplyAllConflictRewriteSuggestions}
                      applyingAllRewrite={isApplyingAllConflictRewrites}
                    />
                  </div>
                ) : activeTab === 'chat' ? (
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 }}>
                    <div style={{ display: "flex", justifyContent: "flex-end", position: "sticky", top: 0, zIndex: 2 }}>
                      <button
                        onClick={handleClearAssistantChat}
                        disabled={isAiLoading || chatMessages.length === 0}
                        style={{
                          width: 24,
                          height: 24,
                          border: "1px solid rgba(244, 67, 54, 0.35)",
                          borderRadius: 6,
                          background: (isAiLoading || chatMessages.length === 0) ? "rgba(244, 67, 54, 0.08)" : "rgba(244, 67, 54, 0.18)",
                          color: (isAiLoading || chatMessages.length === 0) ? "rgba(183, 28, 28, 0.72)" : "#b71c1c",
                          cursor: (isAiLoading || chatMessages.length === 0) ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "all 0.2s",
                          opacity: (isAiLoading || chatMessages.length === 0) ? 0.82 : 1,
                        }}
                        title="清空写作助手对话"
                      >
                        <span style={{ fontSize: 13, lineHeight: 1, fontFamily: '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif' }}>🧹</span>
                      </button>
                    </div>
                    {assistantRewriteSuggestion && (
                      <div
                        style={{
                          border: "1px solid rgba(33, 150, 243, 0.28)",
                          background: "var(--bg)",
                          borderRadius: 8,
                          padding: "8px 9px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: "#2196f3" }}>
                            ✍ 改写建议（未应用）
                          </span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              onClick={applyAssistantRewriteSuggestion}
                              style={{
                                border: "1px solid rgba(76, 175, 80, 0.35)",
                                borderRadius: 6,
                                padding: "2px 8px",
                                fontSize: 10,
                                fontWeight: 600,
                                background: "rgba(76, 175, 80, 0.14)",
                                color: "#2e7d32",
                                cursor: "pointer",
                              }}
                            >
                              应用替换
                            </button>
                            <button
                              onClick={discardAssistantRewriteSuggestion}
                              style={{
                                border: "1px solid var(--bg-border)",
                                borderRadius: 6,
                                padding: "2px 8px",
                                fontSize: 10,
                                background: "transparent",
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                              }}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                          目标片段：{assistantRewriteSuggestion.originalText.length} 字（仅替换这段）
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>建议正文：</div>
                        <div
                          style={{
                            maxHeight: 164,
                            overflowY: "auto",
                            lineHeight: 1.55,
                            whiteSpace: "pre-wrap",
                            padding: "6px 8px",
                            borderRadius: 6,
                            background: "var(--bg-input)",
                            border: "1px solid var(--bg-border)",
                            fontSize: 11,
                            color: "var(--text-primary)",
                          }}
                        >
                          {assistantRewriteSuggestion.suggestedText}
                        </div>
                      </div>
                    )}
                    {chatMessages.length === 0 && !isAiLoading ? (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", opacity: 0.7, padding: "6px 4px" }}>
                        还没有聊天记录，先在下方输入问题。
                      </div>
                    ) : (
                      <>
                        {chatMessages.map((msg, i) => (
                          <div key={i} style={{
                            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                            background: msg.role === 'user' ? 'var(--accent-gold)' : 'var(--bg)',
                            color: msg.role === 'user' ? '#000' : 'var(--text-primary)',
                            padding: "6px 10px", borderRadius: 8, fontSize: 11, maxWidth: "85%",
                            lineHeight: 1.5,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                            border: msg.role === 'assistant' ? '1px solid var(--bg-border)' : 'none'
                          }}>
                            {msg.content}
                          </div>
                        ))}
                        {isAiLoading && (
                          <div style={{ alignSelf: 'flex-start', padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--bg-border)", borderRadius: 8, display: "flex", alignItems: "center", gap: 6 }}>
                            <Loader2 size={12} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>思考中...</span>
                          </div>
                        )}
                      </>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                ) : (
                  <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 20 }}>
                    {contextLoading && !contextLoadedOnce && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", padding: "4px 6px" }}>
                        <Loader2 size={12} className="animate-spin" /> 正在加载上下文数据...
                      </div>
                    )}
                    {contextLoading && contextLoadedOnce && (
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", opacity: 0.78, padding: "2px 6px" }}>
                        正在同步最新数据...
                      </div>
                    )}
                    {!contextLoading && contextLoadedOnce && !contextHasAnyData && (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", opacity: 0.78, padding: "4px 6px" }}>
                        当前项目暂无可展示的角色/伏笔/世界观数据。
                      </div>
                    )}
                    {unknownNerEntities.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--status-active)", fontWeight: 500 }}>
                          <Wand2 size={14} /> 潜在新设定 (AI提示)
                        </div>
                        {unknownNerEntities.map(ent => (
                          <div key={ent.name} style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg-card)", fontSize: 12, border: "1px dashed var(--status-active)" }}>
                            <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span>{ent.name} <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>[{ent.category}]</span></span>
                              <button onClick={() => addToast("info", "设定暂存功能将在主设定页开放！")} style={{ background: "none", border: "none", color: "var(--status-active)", cursor: "pointer", fontSize: 11 }}>+ 录入</button>
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>{ent.description || "无描述"}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {sections.map(({ title, icon: Icon, items }) => (
                      <div key={title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--accent-gold)", fontWeight: 500 }}>
                          <Icon size={14} />{title}
                        </div>
                        {items.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", opacity: 0.5, padding: "4px 12px" }}>
                            {contextLoading ? "加载中..." : "暂无数据"}
                          </div>
                        ) : items.map((item) => (
                          <div key={item.label} style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg-card)", fontSize: 12 }}>
                            <div style={{ fontWeight: 500, marginBottom: 2 }}>{item.label}</div>
                            <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>{item.detail}</div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          </div>

          {/* ====== 底部控制台：与上方连成一个整体 ====== */}
          <div className="workshop-side-console" style={{
            minHeight: 120,
            maxHeight: 260,
            flexBasis: "26%",
            flexShrink: 0,
            overflow: "hidden",
            borderTop: "1px solid var(--bg-border)",
            padding: "10px 10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8
          }}>

          {/* ====== 模式切换条 ====== */}
          <div className="workshop-panel-surface" style={{ display: "flex", flexDirection: "column", gap: 6, background: "var(--bg-input)", border: "1px solid var(--bg-border)", borderRadius: 8, padding: 3, flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setBottomMode('assistant')} style={{
                flex: 1, padding: "5px 0", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer",
                background: bottomMode === 'assistant' ? "var(--bg-input)" : "transparent",
                color: bottomMode === 'assistant' ? "var(--accent-gold)" : "var(--text-secondary)",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                transition: "all 0.2s"
              }}>
                <MessageSquare size={12} /> 写作助手
              </button>
              <button onClick={() => setBottomMode('debate')} style={{
                flex: 1, padding: "5px 0", border: "none", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer",
                background: bottomMode === 'debate' ? "var(--bg-input)" : "transparent",
                color: bottomMode === 'debate' ? "#e91e63" : "var(--text-secondary)",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                transition: "all 0.2s"
              }}>
                <Drama size={12} /> 剧本围读
              </button>
            </div>
            {bottomMode === "assistant" ? (
              <div
                title={`写作助手模型来源：${assistantModelInfo.source}`}
                style={{
                  alignSelf: "flex-start",
                  marginLeft: 2,
                  borderRadius: 999,
                  border: "1px solid var(--accent-gold-dim)",
                  padding: "2px 8px",
                  fontSize: 10,
                  color: "var(--accent-gold)",
                  background: "rgba(255, 215, 0, 0.08)",
                  maxWidth: 230,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                助手：{assistantModelLabel}
              </div>
            ) : (
              <div
                title={`围读模型来源：${debateModelInfo.source}`}
                style={{
                  alignSelf: "flex-start",
                  marginLeft: 2,
                  borderRadius: 999,
                  border: debateModelInfo.enabled ? "1px solid rgba(233, 30, 99, 0.28)" : "1px solid rgba(233, 30, 99, 0.42)",
                  padding: "2px 8px",
                  fontSize: 10,
                  color: debateModelInfo.enabled ? "#e91e63" : "var(--text-secondary)",
                  background: debateModelInfo.enabled ? "rgba(233, 30, 99, 0.08)" : "rgba(233, 30, 99, 0.04)",
                  maxWidth: 230,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                围读：{debateModelText}{!debateModelInfo.enabled ? "（已禁用）" : ""}
              </div>
            )}
          </div>

          {/* ====== 历史消息与输入区 (flex: 1 用于将输入框挤到最底) ====== */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 8, overflow: "hidden" }}>
            {bottomMode === 'assistant' ? (
              /* AI 写作助手：纯输入 */
              <div className="workshop-panel-surface" style={{ flex: 1, minHeight: 0, background: "var(--bg-input)", border: "1px solid var(--bg-border)", borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{
                  padding: "8px 10px",
                  position: "relative",
                  flexShrink: 0
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 10, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        {selectedRange ? `已选中 ${Math.max(0, selectedRange.end - selectedRange.start)} 字` : "未选中文本"}
                      </span>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--text-secondary)" }}>
                        阈值
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={rewriteSimilarityThreshold}
                          onChange={(e) => {
                            const nextRaw = Number(e.target.value);
                            if (!Number.isFinite(nextRaw)) return;
                            const next = Math.min(1, Math.max(0, nextRaw));
                            setRewriteSimilarityThreshold(Number(next.toFixed(2)));
                          }}
                          style={{
                            width: 52,
                            height: 20,
                            borderRadius: 4,
                            border: "1px solid var(--bg-border)",
                            background: "var(--bg)",
                            color: "var(--text-primary)",
                            fontSize: 10,
                            padding: "0 4px",
                            outline: "none",
                          }}
                          title="强改写触发阈值（0-1）：越低越容易触发强改写"
                        />
                      </label>
                    </div>
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 4px",
                      borderRadius: 7,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg)",
                    }}>
                      <button
                        onClick={() => setShowAssistantActionHelp((v) => !v)}
                        style={{
                          width: 24,
                          height: 24,
                          border: "1px solid rgba(71, 124, 191, 0.35)",
                          borderRadius: 6,
                          background: showAssistantActionHelp ? "rgba(71, 124, 191, 0.22)" : "rgba(71, 124, 191, 0.10)",
                          color: "#4a6587",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "all 0.2s",
                        }}
                        title="操作说明"
                      >
                        <span style={{ fontSize: 13, lineHeight: 1, fontFamily: '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif' }}>❔</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowAssistantActionHelp(false);
                          handleQuoteSelectedTextToDebate();
                        }}
                        disabled={isRewritingSelection || isAiLoading || !currentChapterId}
                        style={{
                          width: 24,
                          height: 24,
                          border: "1px solid rgba(76, 175, 80, 0.35)",
                          borderRadius: 6,
                          background: (isRewritingSelection || isAiLoading || !currentChapterId)
                            ? "rgba(76, 175, 80, 0.08)"
                            : "rgba(76, 175, 80, 0.20)",
                          color: (isRewritingSelection || isAiLoading || !currentChapterId)
                            ? "rgba(46, 125, 50, 0.72)"
                            : "#1f6a29",
                          cursor: (isRewritingSelection || isAiLoading || !currentChapterId) ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "all 0.2s",
                          opacity: (isRewritingSelection || isAiLoading || !currentChapterId) ? 0.82 : 1,
                        }}
                        title="引用到围读"
                      >
                        <span style={{ fontSize: 13, lineHeight: 1, fontFamily: '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif' }}>📌</span>
                      </button>
                      <button
                        onClick={() => {
                          setShowAssistantActionHelp(false);
                          handleRewriteSelectedText();
                        }}
                        disabled={isRewritingSelection || isAiLoading || !currentChapterId}
                        style={{
                          width: 24,
                          height: 24,
                          border: "1px solid rgba(33, 150, 243, 0.38)",
                          borderRadius: 6,
                          background: (isRewritingSelection || isAiLoading || !currentChapterId)
                            ? "rgba(33, 150, 243, 0.08)"
                            : "rgba(33, 150, 243, 0.20)",
                          color: (isRewritingSelection || isAiLoading || !currentChapterId)
                            ? "rgba(25, 107, 176, 0.72)"
                            : "#196bb0",
                          cursor: (isRewritingSelection || isAiLoading || !currentChapterId) ? "not-allowed" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "all 0.2s",
                          opacity: (isRewritingSelection || isAiLoading || !currentChapterId) ? 0.82 : 1,
                        }}
                        title={isRewritingSelection ? "改写中..." : "一键改写选中"}
                      >
                        <span style={{ fontSize: 13, lineHeight: 1, fontFamily: '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif' }}>✍️</span>
                      </button>
                    </div>
                  </div>
                  {showAssistantActionHelp && (
                    <div
                      style={{
                        position: "absolute",
                        right: 10,
                        top: 34,
                        zIndex: 3,
                        width: 160,
                        borderRadius: 8,
                        padding: "6px 8px",
                        background: "var(--bg)",
                        border: "1px solid var(--bg-border)",
                        boxShadow: "var(--shadow-sm)",
                        color: "var(--text-secondary)",
                        fontSize: 10,
                        lineHeight: 1.5,
                      }}
                    >
                      <div>剧本围读图标：引用当前选中。</div>
                      <div>魔杖图标：按节拍改写选中。</div>
                    </div>
                  )}
                  <textarea
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendAiMessage();
                      }
                    }}
                    disabled={isAiLoading || isRewritingSelection || !currentChapterId}
                    placeholder={currentChapterId ? "输入你的问题... (Shift+Enter 换行)" : "请先选择章节"}
                    style={{
                      width: "100%",
                      minHeight: 72,
                      height: 78,
                      borderRadius: 8, border: "none", padding: "10px", paddingRight: 42,
                      background: "var(--bg)", color: "var(--text-primary)", fontSize: 12, outline: "none",
                      resize: "none", lineHeight: 1.5,
                    }}
                  />
                  <button
                    onClick={handleSendAiMessage}
                    disabled={isAiLoading || isRewritingSelection || !aiInput.trim() || !currentChapterId}
                    style={{
                      position: "absolute", right: 16, bottom: 14,
                      width: 28, height: 28, borderRadius: 6, border: "none",
                      background: (isAiLoading || isRewritingSelection || !aiInput.trim() || !currentChapterId) ? "transparent" : "var(--accent-gold)",
                      color: (isAiLoading || isRewritingSelection || !aiInput.trim() || !currentChapterId) ? "var(--text-secondary)" : "#000",
                      cursor: (isAiLoading || isRewritingSelection || !aiInput.trim() || !currentChapterId) ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.2s"
                    }}
                  >
                    <Send size={12} />
                  </button>
                </div>
              </div>
            ) : (
              /* 围读：大输入框 + 引用块 */
              <>
                {debateQuotedText && (
                  <div className="workshop-panel-surface" style={{
                    padding: "8px 10px", background: "var(--bg-input)",
                    border: "1px solid var(--accent-gold-dim)", borderRadius: 8,
                    fontSize: 11, color: "var(--text-secondary)", flexShrink: 0
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent-gold)" }}>
                        📋 引用文本 · {debateQuotedText.length}字
                      </span>
                      <button onClick={() => setDebateQuotedText("")} style={{
                        background: "none", border: "none", cursor: "pointer",
                        color: "var(--text-secondary)", padding: 0, fontSize: 12
                      }}>✕</button>
                    </div>
                    <div style={{ lineHeight: 1.5, maxHeight: 40, overflow: "hidden" }}>
                      {debateQuotedText.length > 80 ? debateQuotedText.substring(0, 80) + "..." : debateQuotedText}
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0, position: "relative" }}>
                  <textarea
                    value={debateTopic}
                    onChange={(e) => setDebateTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        startDebate();
                      }
                    }}
                    disabled={isDebating}
                    placeholder={debateQuotedText ? "说说你的诉求... (Shift+Enter 换行)" : "抛出剧情难题... (Shift+Enter 换行)"}
                    style={{
                      flex: 1, borderRadius: 8, border: "none", padding: "10px", paddingRight: 45,
                      background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 12, outline: "none",
                      resize: "none", lineHeight: 1.5,
                    }}
                  />
                  <button
                    onClick={startDebate}
                    disabled={isDebating || (!debateTopic.trim() && !debateQuotedText.trim())}
                    style={{
                      position: "absolute", right: 6, bottom: 6,
                      width: 30, height: 30, borderRadius: 6, border: "none",
                      background: (isDebating || (!debateTopic.trim() && !debateQuotedText.trim())) ? "transparent" : "var(--accent-gold)",
                      color: (isDebating || (!debateTopic.trim() && !debateQuotedText.trim())) ? "var(--text-secondary)" : "#000",
                      cursor: (isDebating || (!debateTopic.trim() && !debateQuotedText.trim())) ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.2s"
                    }}
                  >
                    {isDebating ? <Loader2 size={12} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={12} />}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
