import { useState, useEffect, useCallback, useRef } from "react";
import { Check, ChevronDown, Edit2, LayoutList, Loader2, Plus, Sparkles, Trash2, X, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { Loading, EmptyState, ErrorBanner, PageHeader, PrimaryButton } from "../components/ui";
import { useToast } from "../components/ui/ToastProvider";

interface Chapter {
  id: string;
  chapter_num: number;
  title: string;
  synopsis: string;
  word_count: number;
  status: string;
  phase: string;
  sort_order: number;
}

interface BootstrapRangeInfo {
  start_chapter: number;
  end_chapter: number;
}

interface BootstrapBatchInfo {
  planned_batches?: number;
  success_batches?: number;
}

interface VolumePlan {
  volume_index: number;
  title: string;
  start_chapter: number;
  end_chapter: number;
  goal?: string;
  key_turning_point?: string;
  end_hook?: string;
}

interface VolumePlanResponse {
  items: VolumePlan[];
  message: string;
}

interface BootstrapChaptersResponse {
  message: string;
  inserted?: { chapters?: number };
  skipped?: { chapters?: number };
  effective_range?: BootstrapRangeInfo;
  batch_stats?: BootstrapBatchInfo;
  failed_range?: BootstrapRangeInfo | null;
  retry_count?: number;
  format_degraded?: boolean;
}

interface BatchDeleteResponse {
  ok: boolean;
  requested: number;
  deleted: number;
  not_found: number;
  deleted_ids: string[];
}

interface BatchWriteFailureItem {
  chapter_num: number;
  title: string;
  reason: string;
}

interface BatchWriteResult {
  scope_label: string;
  planned: number;
  to_write: number;
  written: number;
  skipped_non_empty: number;
  failed: number;
  failed_items: BatchWriteFailureItem[];
  overwrite: boolean;
  mode: BatchWriteMode;
}

interface BatchWriteProgress {
  current: number;
  total: number;
  chapter_num: number;
  title: string;
}

interface ChapterBeat {
  id: string;
  chapter_id: string;
  order_index: number;
  content: string;
  status: string;
}

type BatchWriteMode = "speed" | "quality";

const BATCH_WRITE_MODE_LABEL: Record<BatchWriteMode, string> = {
  speed: "速度推土机",
  quality: "品质导演",
};

const BATCH_WRITE_MODE_DESC: Record<BatchWriteMode, string> = {
  speed: "一次成稿，无视节拍约束",
  quality: "严格按章节节拍，逐段生成",
};

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft: { label: "计划中", color: "#9E9E9E" },
  planned: { label: "计划中", color: "#9E9E9E" },
  writing: { label: "写作中", color: "#FF9800" },
  drafting: { label: "写作中", color: "#FF9800" },
  done: { label: "已完成", color: "#4CAF50" },
  written: { label: "已完成", color: "#4CAF50" },
  reviewing: { label: "审阅中", color: "#42A5F5" },
  revised: { label: "已修订", color: "#42A5F5" },
  final: { label: "定稿", color: "#2196F3" },
};

const PHASE_COLORS: Record<string, string> = {
  "起": "#42A5F5", "承": "#66BB6A", "转": "#FFA726", "合": "#EF5350",
};

export default function Chapters() {
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const pid = currentProject?.id;

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isAiPlanning, setIsAiPlanning] = useState(false);
  const [forceRewriteChapters, setForceRewriteChapters] = useState(false);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [savingTitleId, setSavingTitleId] = useState<string | null>(null);
  const [editingSynopsisChapterId, setEditingSynopsisChapterId] = useState<string | null>(null);
  const [editingSynopsis, setEditingSynopsis] = useState("");
  const [savingSynopsisId, setSavingSynopsisId] = useState<string | null>(null);
  const [deletingChapterId, setDeletingChapterId] = useState<string | null>(null);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [lastAiResult, setLastAiResult] = useState<BootstrapChaptersResponse | null>(null);
  const [volumePlans, setVolumePlans] = useState<VolumePlan[]>([]);
  const [selectedVolumeIndex, setSelectedVolumeIndex] = useState<number | "">("");
  const [targetVolumeCount, setTargetVolumeCount] = useState("8");
  const [isGeneratingVolumes, setIsGeneratingVolumes] = useState(false);
  const [isBatchWriting, setIsBatchWriting] = useState(false);
  const [batchWriteOverwrite, setBatchWriteOverwrite] = useState(false);
  const [batchWriteMode, setBatchWriteMode] = useState<BatchWriteMode>("speed");
  const [showBatchWriteModeMenu, setShowBatchWriteModeMenu] = useState(false);
  const [batchWriteProgress, setBatchWriteProgress] = useState<BatchWriteProgress | null>(null);
  const [lastBatchWriteResult, setLastBatchWriteResult] = useState<BatchWriteResult | null>(null);
  const reqId = useRef(0);

  const normalizeBootstrapError = (err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err || "");
    const payload = raw.replace(/^API\s+\d+\s*:\s*/i, "").trim();
    const lowered = payload.toLowerCase();
    if (
      lowered.includes("timeout") ||
      lowered.includes("timed out") ||
      lowered.includes("apitimeouterror")
    ) {
      return "AI 章节规划超时，建议将范围缩小到 10-20 章后重试。";
    }
    if (payload.includes("start_chapter") || payload.includes("end_chapter")) {
      return `区间参数错误：${payload}`;
    }
    if (lowered.includes("超出上限")) {
      return `${payload}，请缩小结束章或分批生成。`;
    }
    return payload || "AI 章节规划失败";
  };

  // 切换项目时立即清空旧数据
  useEffect(() => {
    setChapters([]);
    setError("");
    setLoading(true);
    setLastAiResult(null);
    setLastBatchWriteResult(null);
    setBatchWriteProgress(null);
    setShowBatchWriteModeMenu(false);
    setVolumePlans([]);
    setSelectedVolumeIndex("");
    setSelectedChapterIds([]);
  }, [pid]);

  const loadVolumePlans = useCallback(async () => {
    if (!pid) return;
    try {
      const plans = await api<VolumePlan[]>(`/api/pipeline/volume-plans?project_id=${pid}`);
      setVolumePlans(Array.isArray(plans) ? plans : []);
    } catch {
      setVolumePlans([]);
    }
  }, [pid, api]);

  const load = useCallback(() => {
    if (!pid) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError("");
    api<Chapter[]>(`/api/chapters/?project_id=${pid}`)
      .then((data) => { if (reqId.current === id) setChapters(data); })
      .catch((e: Error) => { if (reqId.current === id) setError(e.message); })
      .finally(() => { if (reqId.current === id) setLoading(false); });
  }, [pid, api]);

  useEffect(load, [load]);
  useEffect(() => { void loadVolumePlans(); }, [loadVolumePlans]);
  useEffect(() => {
    setSelectedChapterIds((prev) => {
      if (prev.length === 0) return prev;
      const idSet = new Set(chapters.map((ch) => ch.id));
      const next = prev.filter((id) => idSet.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [chapters]);

  const createChapter = async () => {
    if (!pid) return;
    const num = chapters.length > 0 ? Math.max(...chapters.map((ch) => Number(ch.chapter_num) || 0)) + 1 : 1;
    try {
      const ch = await api<Chapter>("/api/chapters/", {
        method: "POST",
        body: JSON.stringify({ project_id: pid, title: `第${num}章`, chapter_num: num }),
      });
      setChapters((prev) => [...prev, ch]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    }
  };

  const startEditTitle = (chapter: Chapter) => {
    setEditingChapterId(chapter.id);
    setEditingTitle(chapter.title || "");
    setEditingSynopsisChapterId(null);
    setEditingSynopsis("");
  };

  const cancelEditTitle = () => {
    setEditingChapterId(null);
    setEditingTitle("");
  };

  const startEditSynopsis = (chapter: Chapter) => {
    setEditingSynopsisChapterId(chapter.id);
    setEditingSynopsis(String(chapter.synopsis || ""));
    setEditingChapterId(null);
    setEditingTitle("");
  };

  const cancelEditSynopsis = () => {
    setEditingSynopsisChapterId(null);
    setEditingSynopsis("");
  };

  const saveTitle = async (chapterId: string) => {
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      addToast("warning", "章节标题不能为空");
      return;
    }
    setSavingTitleId(chapterId);
    try {
      const updated = await api<Chapter>(`/api/chapters/${chapterId}`, {
        method: "PUT",
        body: JSON.stringify({ title: nextTitle }),
      });
      setChapters((prev) => prev.map((ch) => (ch.id === chapterId ? { ...ch, ...updated } : ch)));
      setEditingChapterId(null);
      setEditingTitle("");
      addToast("success", "章节标题已更新");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "章节标题更新失败");
      addToast("error", "章节标题更新失败");
    } finally {
      setSavingTitleId(null);
    }
  };

  const saveSynopsis = async (chapterId: string) => {
    const nextSynopsis = editingSynopsis.trim();
    setSavingSynopsisId(chapterId);
    try {
      const updated = await api<Chapter>(`/api/chapters/${chapterId}`, {
        method: "PUT",
        body: JSON.stringify({ synopsis: nextSynopsis }),
      });
      setChapters((prev) => prev.map((ch) => (ch.id === chapterId ? { ...ch, ...updated } : ch)));
      setEditingSynopsisChapterId(null);
      setEditingSynopsis("");
      addToast("success", "章节梗概已更新");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "章节梗概更新失败");
      addToast("error", "章节梗概更新失败");
    } finally {
      setSavingSynopsisId(null);
    }
  };

  const deleteChapter = async (chapter: Chapter) => {
    if (!pid || deletingChapterId) return;
    if (!window.confirm(`确定删除「第${chapter.chapter_num}章 · ${chapter.title}」吗？此操作不可恢复。`)) return;
    setDeletingChapterId(chapter.id);
    try {
      await api<{ ok: boolean }>(`/api/chapters/${chapter.id}`, { method: "DELETE" });
      setChapters((prev) => prev.filter((item) => item.id !== chapter.id));
      setSelectedChapterIds((prev) => prev.filter((id) => id !== chapter.id));
      if (editingChapterId === chapter.id) {
        setEditingChapterId(null);
        setEditingTitle("");
      }
      if (editingSynopsisChapterId === chapter.id) {
        setEditingSynopsisChapterId(null);
        setEditingSynopsis("");
      }
      addToast("success", "章节已删除");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "章节删除失败";
      setError(msg);
      addToast("error", "章节删除失败");
    } finally {
      setDeletingChapterId(null);
    }
  };

  const toggleChapterSelection = (chapterId: string, checked: boolean) => {
    setSelectedChapterIds((prev) => {
      if (checked) {
        if (prev.includes(chapterId)) return prev;
        return [...prev, chapterId];
      }
      return prev.filter((id) => id !== chapterId);
    });
  };

  const clearChapterSelection = () => {
    setSelectedChapterIds([]);
  };

  const toggleSelectAllChapters = () => {
    if (chapters.length === 0) return;
    const allIds = chapters.map((ch) => ch.id);
    setSelectedChapterIds((prev) => (prev.length === allIds.length ? [] : allIds));
  };

  const deleteSelectedChapters = async () => {
    if (!pid || isBatchDeleting || selectedChapterIds.length === 0) return;
    const selectedNums = chapters
      .filter((ch) => selectedChapterIds.includes(ch.id))
      .map((ch) => Number(ch.chapter_num) || 0)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const previewNums = selectedNums.slice(0, 8).map((n) => `第${n}章`).join("、");
    const overflow = selectedNums.length > 8 ? ` 等${selectedNums.length}章` : "";
    const ok = window.confirm(
      `确定批量删除已选 ${selectedChapterIds.length} 章吗？此操作不可恢复。\n${previewNums}${overflow}`,
    );
    if (!ok) return;

    setIsBatchDeleting(true);
    try {
      const res = await api<BatchDeleteResponse>("/api/chapters/batch-delete", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          chapter_ids: selectedChapterIds,
        }),
      });
      const deletedIds = new Set((res.deleted_ids || []).map((id) => String(id)));
      if (deletedIds.size > 0) {
        setChapters((prev) => prev.filter((ch) => !deletedIds.has(ch.id)));
      }
      setSelectedChapterIds([]);
      if (editingChapterId && deletedIds.has(editingChapterId)) {
        setEditingChapterId(null);
        setEditingTitle("");
      }
      if ((res.deleted || 0) > 0) {
        addToast("success", `批量删除完成：已删除 ${res.deleted} 章`);
      } else {
        addToast("warning", "未删除任何章节（可能已不存在）");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "批量删除失败";
      setError(msg);
      addToast("error", "批量删除失败");
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const generateChapterPlanByAi = async () => {
    if (!pid || isAiPlanning) return;
    const parsedStart = Number(rangeStart);
    const parsedEnd = Number(rangeEnd);
    const hasStart = Number.isFinite(parsedStart) && parsedStart > 0;
    const hasEnd = Number.isFinite(parsedEnd) && parsedEnd > 0;
    if (hasStart && hasEnd && parsedEnd < parsedStart) {
      addToast("warning", "结束章必须大于等于起始章");
      return;
    }
    if (forceRewriteChapters) {
      const ok = window.confirm("已开启覆盖重生成章节，现有章节标题与梗概将被重写。确定继续吗？");
      if (!ok) return;
    }
    const selectedVolume = selectedVolumeIndex === ""
      ? null
      : volumePlans.find((v) => v.volume_index === selectedVolumeIndex) || null;
    setIsAiPlanning(true);
    try {
      const payload: Record<string, unknown> = {
        project_id: pid,
        scope: "chapters",
        force: forceRewriteChapters,
      };
      if (hasStart) payload.start_chapter = Math.floor(parsedStart);
      if (hasEnd) payload.end_chapter = Math.floor(parsedEnd);
      if (selectedVolume) {
        payload.volume_index = selectedVolume.volume_index;
        payload.volume_title = selectedVolume.title || `第${selectedVolume.volume_index}卷`;
        payload.volume_start_chapter = selectedVolume.start_chapter;
        payload.volume_end_chapter = selectedVolume.end_chapter;
      }
      const res = await api<BootstrapChaptersResponse>("/api/pipeline/bootstrap", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await load();
      setLastAiResult(res);
      addToast("success", res.message || "AI 章节规划生成完成（仅章节）");
    } catch (e: unknown) {
      const msg = normalizeBootstrapError(e);
      setError(msg);
      addToast("error", msg);
    } finally {
      setIsAiPlanning(false);
    }
  };

  const fillNextTwentyRange = () => {
    const maxNum = chapters.length > 0 ? Math.max(...chapters.map((ch) => Number(ch.chapter_num) || 0)) : 0;
    const nextStart = maxNum + 1;
    const nextEnd = nextStart + 19;
    setRangeStart(String(nextStart));
    setRangeEnd(String(nextEnd));
  };

  const applySelectedVolumeRange = () => {
    if (selectedVolumeIndex === "") return;
    const selected = volumePlans.find((v) => v.volume_index === selectedVolumeIndex);
    if (!selected) return;
    setRangeStart(String(selected.start_chapter));
    setRangeEnd(String(selected.end_chapter));
  };

  const generateVolumePlansByAi = async () => {
    if (!pid || isGeneratingVolumes) return;
    const parsedCount = Number(targetVolumeCount);
    if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 36) {
      addToast("warning", "目标卷数请输入 1-36");
      return;
    }
    if (volumePlans.length > 0) {
      const ok = window.confirm("将覆盖已有卷计划，是否继续？");
      if (!ok) return;
    }
    setIsGeneratingVolumes(true);
    try {
      const res = await api<VolumePlanResponse>("/api/pipeline/volume-plans/generate", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          target_volume_count: Math.floor(parsedCount),
          target_word_count: currentProject?.word_target,
          force: true,
        }),
      });
      const plans = Array.isArray(res.items) ? res.items : [];
      setVolumePlans(plans);
      if (plans.length > 0) {
        setSelectedVolumeIndex(plans[0].volume_index);
        setRangeStart(String(plans[0].start_chapter));
        setRangeEnd(String(plans[0].end_chapter));
      }
      addToast("success", res.message || "卷计划生成完成");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "卷计划生成失败");
      addToast("error", "卷计划生成失败");
    } finally {
      setIsGeneratingVolumes(false);
    }
  };

  const parsePositiveInt = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  };

  const resolveChapterWordTarget = () => {
    const chapterWords = Number(currentProject?.chapter_words || 0);
    if (Number.isFinite(chapterWords) && chapterWords > 0) {
      return Math.max(1200, Math.min(12000, Math.floor(chapterWords)));
    }
    const totalWords = Number(currentProject?.word_target || 0);
    if (Number.isFinite(totalWords) && totalWords > 0) {
      return Math.max(1200, Math.min(12000, Math.round(totalWords / 22)));
    }
    return 2600;
  };

  const cleanGeneratedDraft = (raw: unknown) => {
    let text = String(raw || "").replace(/\r\n/g, "\n").trim();
    if (!text) return "";
    text = text.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*/, "").replace(/\s*```$/, "").trim();
    text = text.replace(/^\s*(正文|草稿|内容|章节正文)\s*[：:]\s*/i, "").trim();
    return text;
  };

  const buildBatchWriteSpeedPrompt = (
    chapter: Chapter,
    previousSynopsis: string,
    chapterTarget: number,
  ) => {
    const chapterNum = Number(chapter.chapter_num || 0);
    const title = String(chapter.title || "").trim() || `第${chapterNum}章`;
    const synopsis = String(chapter.synopsis || "").trim();
    const projectDesc = String(currentProject?.description || "").trim();
    const lenMin = Math.max(900, Math.round(chapterTarget * 0.8));
    const lenMax = Math.max(lenMin + 120, Math.round(chapterTarget * 1.2));
    const lines = [
      `[MODE:FAST][DRAFT_ONLY][LEN_TARGET:${chapterTarget}][LEN_MIN:${lenMin}][LEN_MAX:${lenMax}]`,
      "请按照要求创作本章正文，只输出可直接入稿的正文。",
      "",
      "章节信息：",
      `- 章节：第${chapterNum}章《${title}》`,
      `- 梗概：${synopsis || "无（请基于项目信息与章节标题合理创作）"}`,
      previousSynopsis ? `- 前情提要：${previousSynopsis}` : "- 前情提要：无",
      "",
      "项目信息：",
      `- 题材：${currentProject?.genre || "未指定"}`,
      `- 项目简介：${projectDesc || "无"}`,
      "",
      "要求：",
      "- 情节推进清晰，语言流畅，避免空泛套话；",
      "- 与已知设定一致，不引入突兀新设定；",
      chapterNum === 1
        ? "- 当前是第一章：需要有明确开篇感，快速建立阅读驱动力；"
        : "- 与前章衔接自然，不要重复前章已完成信息；",
      "- 章尾保留“未解问题 / 悬念 / 下一步行动动机”之一；",
      "",
      "限制：",
      "- 不要输出小标题、编号、注释、解释或自我说明；",
      "- 只输出正文；",
      "- 段落之间保留一个空行（双换行）；",
    ];
    return lines.join("\n");
  };

  const buildFallbackBeatLinesForBatch = (chapter: Chapter) => {
    const chapterNum = Number(chapter.chapter_num || 0);
    const title = String(chapter.title || "").trim() || `第${chapterNum}章`;
    const synopsis = String(chapter.synopsis || "").trim();
    const seedLines = synopsis
      .split(/[。！？；;\n]/)
      .map((s) => s.trim().replace(/^[\d\.\)、\s]+/, ""))
      .filter((s) => s.length >= 8)
      .slice(0, 4);
    if (seedLines.length >= 4) return seedLines;

    const base = chapterNum === 1
      ? [
        `围绕《${title}》开场即触发异常事件`,
        "主角在阻力中给出首次行动选择",
        "冲突升级并抛出核心疑问",
        "以未解问题或行动钩子收束章节",
      ]
      : [
        `围绕《${title}》抛出本章首个实质冲突`,
        "关键阻力升级，迫使主角调整策略",
        "关系或利益对撞，触发情节拐点",
        "用后果或悬念收束，驱动下一章",
      ];
    return [...seedLines, ...base].slice(0, 5);
  };

  const loadQualityBeatLines = async (chapter: Chapter) => {
    const chapterId = String(chapter.id || "");
    if (!chapterId) return buildFallbackBeatLinesForBatch(chapter);
    const beats = await api<ChapterBeat[]>(`/api/beats/?chapter_id=${chapterId}`).catch(() => []);
    const list = Array.isArray(beats) ? beats : [];
    const sorted = list.slice().sort((a, b) => Number(a.order_index || 0) - Number(b.order_index || 0));
    const pendingFirst = sorted.filter((b) => ["pending", "writing"].includes(String(b.status || "").toLowerCase()));
    const target = pendingFirst.length > 0 ? pendingFirst : sorted;
    const lines = target
      .map((b) => String(b.content || "").trim())
      .filter((v) => v.length >= 4)
      .slice(0, 5);
    return lines.length > 0 ? lines : buildFallbackBeatLinesForBatch(chapter);
  };

  const buildBatchWriteQualityPrompt = (
    chapter: Chapter,
    beatLines: string[],
    chapterTarget: number,
  ) => {
    const chapterNum = Number(chapter.chapter_num || 0);
    const title = String(chapter.title || "").trim() || `第${chapterNum}章`;
    const synopsis = String(chapter.synopsis || "").trim();
    const projectDesc = String(currentProject?.description || "").trim();
    const lenMin = Math.max(900, Math.round(chapterTarget * 0.8));
    const lenMax = Math.max(lenMin + 120, Math.round(chapterTarget * 1.2));
    const mergedBeatPrompt = beatLines.map((line, idx) => `${idx + 1}. [节拍${idx + 1}] ${line}`).join("\n");
    const lines = [
      `[MODE:QUALITY][DRAFT_ONLY][LEN_TARGET:${chapterTarget}][LEN_MIN:${lenMin}][LEN_MAX:${lenMax}]`,
      "请按顺序一次性完成以下全部节拍，输出一段连续正文：",
      mergedBeatPrompt,
      "",
      "章节信息：",
      `- 章节：第${chapterNum}章《${title}》`,
      `- 梗概：${synopsis || "无（请基于节拍与项目信息合理补全）"}`,
      "",
      "项目信息：",
      `- 题材：${currentProject?.genre || "未指定"}`,
      `- 项目简介：${projectDesc || "无"}`,
      "",
      "硬要求：",
      "1) 严格按节拍序号推进，不跳写、不漏写；",
      "2) 段与段自然衔接，不能像提纲；",
      chapterNum === 1
        ? "3) 第一章必须有开篇感，快速建立主冲突或阅读驱动力；"
        : "3) 与前文语气一致，不要重复铺垫已知信息；",
      "4) 不要输出编号、标题、注释、说明；",
      "5) 只输出可直接入稿的正文；",
      "6) 段落之间保留一个空行（双换行）；",
      "7) 章尾保留“未解问题 / 悬念 / 下一步行动动机”之一。",
    ];
    return lines.join("\n");
  };

  const getSortedChapters = () =>
    chapters.slice().sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0));

  const runBatchWriteByAi = async (modeOverride?: BatchWriteMode) => {
    if (!pid || isBatchWriting || isAiPlanning || isGeneratingVolumes) return;
    setShowBatchWriteModeMenu(false);
    const resolvedMode: BatchWriteMode = modeOverride || batchWriteMode;
    if (modeOverride) setBatchWriteMode(modeOverride);
    const sorted = getSortedChapters();
    if (sorted.length === 0) {
      addToast("warning", "暂无章节可写作");
      return;
    }

    const selectedSet = new Set(selectedChapterIds);
    const rangeStartNum = parsePositiveInt(rangeStart);
    const rangeEndNum = parsePositiveInt(rangeEnd);
    let scopeLabel = "全部章节";
    let targets: Chapter[] = sorted;

    if (selectedSet.size > 0) {
      targets = sorted.filter((ch) => selectedSet.has(ch.id));
      scopeLabel = `已勾选章节（${targets.length}章）`;
    } else if (rangeStartNum != null || rangeEndNum != null) {
      const start = rangeStartNum ?? 1;
      const end = rangeEndNum ?? Number.MAX_SAFE_INTEGER;
      if (end < start) {
        addToast("warning", "结束章必须大于等于起始章");
        return;
      }
      targets = sorted.filter((ch) => {
        const n = Number(ch.chapter_num || 0);
        return n >= start && n <= end;
      });
      scopeLabel = rangeStartNum != null && rangeEndNum != null
        ? `第${rangeStartNum}-${rangeEndNum}章`
        : (rangeStartNum != null ? `第${rangeStartNum}章及以后` : `第${rangeEndNum}章及以前`);
    }

    if (targets.length === 0) {
      addToast("warning", "当前筛选范围内没有可写章节");
      return;
    }

    let toWrite = targets;
    let skippedNonEmpty = 0;
    if (!batchWriteOverwrite) {
      toWrite = targets.filter((ch) => Number(ch.word_count || 0) <= 0);
      skippedNonEmpty = targets.length - toWrite.length;
    }
    if (toWrite.length === 0) {
      addToast("warning", "目标章节都有正文了。若要重写，请勾选“覆盖已有正文”。");
      return;
    }

    const confirmText = [
      `将执行 AI 批量写正文：${scopeLabel}`,
      `计划章节：${targets.length} 章`,
      `实际写入：${toWrite.length} 章`,
      skippedNonEmpty > 0 ? `跳过已有正文：${skippedNonEmpty} 章` : "",
      `创作模式：${BATCH_WRITE_MODE_LABEL[resolvedMode]}（${BATCH_WRITE_MODE_DESC[resolvedMode]}）`,
      `模式：${batchWriteOverwrite ? "覆盖已有正文" : "仅写空章（推荐）"}`,
      "",
      "是否继续？",
    ].filter(Boolean).join("\n");
    if (!window.confirm(confirmText)) return;

    const chapterTarget = resolveChapterWordTarget();
    const chapterByNum = new Map<number, Chapter>();
    sorted.forEach((c) => chapterByNum.set(Number(c.chapter_num || 0), c));

    let written = 0;
    const failures: BatchWriteFailureItem[] = [];
    setIsBatchWriting(true);
    setLastBatchWriteResult(null);
    setBatchWriteProgress(null);

    try {
      for (let idx = 0; idx < toWrite.length; idx += 1) {
        const ch = toWrite[idx];
        const chapterNum = Number(ch.chapter_num || 0);
        const chapterTitle = String(ch.title || "").trim() || `第${chapterNum}章`;
        setBatchWriteProgress({
          current: idx + 1,
          total: toWrite.length,
          chapter_num: chapterNum,
          title: chapterTitle,
        });

        try {
          const prev = chapterByNum.get(chapterNum - 1);
          const previousSynopsis = String(prev?.synopsis || "").trim();
          const prompt = resolvedMode === "quality"
            ? buildBatchWriteQualityPrompt(ch, await loadQualityBeatLines(ch), chapterTarget)
            : buildBatchWriteSpeedPrompt(ch, previousSynopsis, chapterTarget);
          const resp = await api<any>("/agent/invoke", {
            method: "POST",
            body: JSON.stringify({
              project_id: pid,
              agent_type: "chapter_writer",
              chapter_id: ch.id,
              message: prompt,
            }),
          });

          const generated = cleanGeneratedDraft(resp?.content || "");
          if (!generated) {
            throw new Error("模型未返回有效正文");
          }

          const paragraphs = generated.split("\n").map((line, i) => ({ para_index: i, content: line }));
          await api("/api/chapters/paragraphs/save", {
            method: "POST",
            body: JSON.stringify({
              chapter_id: ch.id,
              paragraphs,
              auto_extract: true,
            }),
          });
          written += 1;
        } catch (e: unknown) {
          const reason = (e instanceof Error ? e.message : String(e || "写作失败"))
            .replace(/^API\s+\d+\s*:\s*/i, "")
            .trim();
          failures.push({
            chapter_num: chapterNum,
            title: chapterTitle,
            reason: reason || "写作失败",
          });
        }
      }

      await load();

      const result: BatchWriteResult = {
        scope_label: scopeLabel,
        planned: targets.length,
        to_write: toWrite.length,
        written,
        skipped_non_empty: skippedNonEmpty,
        failed: failures.length,
        failed_items: failures.slice(0, 10),
        overwrite: batchWriteOverwrite,
        mode: resolvedMode,
      };
      setLastBatchWriteResult(result);

      if (failures.length === 0) {
        addToast("success", `批量写作完成：成功 ${written} 章`);
      } else {
        addToast("warning", `批量写作完成：成功 ${written} 章，失败 ${failures.length} 章`);
      }
    } finally {
      setIsBatchWriting(false);
      setBatchWriteProgress(null);
    }
  };

  if (!pid) {
    return (
      <div style={{ padding: 32 }}>
        <EmptyState icon="📖" title="请先选择一个项目" description="在项目列表中选择或创建一个项目后，即可管理章节" />
      </div>
    );
  }

  const selectedCount = selectedChapterIds.length;
  const allSelected = chapters.length > 0 && selectedCount === chapters.length;

  const openChapterInWorkshop = useCallback((chapterId: string) => {
    if (!chapterId) return;
    navigate(`/workshop?chapter_id=${encodeURIComponent(chapterId)}`);
  }, [navigate]);

  const isInteractiveTarget = (target: EventTarget | null) => {
    const node = target instanceof Element ? target : null;
    return Boolean(node?.closest("button, input, textarea, select, a, label"));
  };
  const selectedIdSet = new Set(selectedChapterIds);

  return (
    <div style={{ padding: 32, height: "100vh", overflow: "auto" }}>
      <PageHeader
        title="章节管理"
        subtitle={chapters.length > 0 ? `共 ${chapters.length} 章 · ${chapters.reduce((s, c) => s + (c.word_count || 0), 0).toLocaleString()} 字` : undefined}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
              }}
              title="先生成卷计划，再按卷自动回填章节范围"
            >
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>卷</span>
              <input
                type="number"
                min={1}
                max={36}
                step={1}
                value={targetVolumeCount}
                onChange={(e) => setTargetVolumeCount(e.target.value)}
                disabled={isGeneratingVolumes || isAiPlanning}
                style={{
                  width: 50,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  padding: "0 8px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <button
                onClick={generateVolumePlansByAi}
                disabled={isGeneratingVolumes || isAiPlanning}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: (isGeneratingVolumes || isAiPlanning) ? "not-allowed" : "pointer",
                }}
              >
                {isGeneratingVolumes ? "生成中..." : "AI卷计划"}
              </button>
              <select
                value={selectedVolumeIndex === "" ? "" : String(selectedVolumeIndex)}
                onChange={(e) => setSelectedVolumeIndex(e.target.value ? Number(e.target.value) : "")}
                disabled={isAiPlanning || volumePlans.length === 0}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  padding: "0 8px",
                  outline: "none",
                  minWidth: 160,
                }}
              >
                <option value="">选择卷</option>
                {volumePlans.map((v) => (
                  <option key={v.volume_index} value={v.volume_index}>
                    {v.title || `第${v.volume_index}卷`}（{v.start_chapter}-{v.end_chapter}章）
                  </option>
                ))}
              </select>
              <button
                onClick={applySelectedVolumeRange}
                disabled={isAiPlanning || selectedVolumeIndex === ""}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: (isAiPlanning || selectedVolumeIndex === "") ? "not-allowed" : "pointer",
                }}
              >
                套用卷范围
              </button>
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
              }}
              title="留空表示按系统默认范围生成；建议按区间分批生成以降低超时风险"
            >
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>范围</span>
              <input
                type="number"
                min={1}
                step={1}
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                disabled={isAiPlanning}
                placeholder="起始章"
                style={{
                  width: 74,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  padding: "0 8px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>-</span>
              <input
                type="number"
                min={1}
                step={1}
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                disabled={isAiPlanning}
                placeholder="结束章"
                style={{
                  width: 74,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  padding: "0 8px",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              <button
                onClick={fillNextTwentyRange}
                disabled={isAiPlanning}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: isAiPlanning ? "not-allowed" : "pointer",
                }}
                title="自动填充下一批 20 章"
              >
                下一批20章
              </button>
              <button
                onClick={() => {
                  setRangeStart("");
                  setRangeEnd("");
                }}
                disabled={isAiPlanning}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: isAiPlanning ? "not-allowed" : "pointer",
                }}
                title="清空范围并恢复默认行为"
              >
                清空
              </button>
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
              }}
            >
              <PrimaryButton onClick={generateChapterPlanByAi} disabled={isAiPlanning}>
                {isAiPlanning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {isAiPlanning ? "规划中..." : "AI 章节规划"}
              </PrimaryButton>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  userSelect: "none",
                }}
                title="仅影响“AI章节规划”"
              >
                <input
                  type="checkbox"
                  checked={forceRewriteChapters}
                  onChange={(e) => setForceRewriteChapters(e.currentTarget.checked)}
                  disabled={isAiPlanning}
                  style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                />
                覆盖重生成
              </label>
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
              }}
              title="优先使用勾选章节；未勾选时使用上方范围；范围为空时对全部章节执行"
            >
              <div style={{ position: "relative" }}>
                <PrimaryButton
                  onClick={() => setShowBatchWriteModeMenu((prev) => !prev)}
                  disabled={isBatchWriting || isAiPlanning || isGeneratingVolumes || chapters.length === 0}
                >
                  {isBatchWriting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {isBatchWriting && batchWriteProgress
                    ? `写作中 ${batchWriteProgress.current}/${batchWriteProgress.total}`
                    : "AI 批量写"}
                  {!isBatchWriting && <ChevronDown size={12} />}
                </PrimaryButton>
                {showBatchWriteModeMenu && (
                  <div
                    style={{
                      position: "absolute",
                      top: 30,
                      left: 0,
                      zIndex: 40,
                      minWidth: 210,
                      borderRadius: 8,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg)",
                      padding: 4,
                      boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <button
                      onClick={() => {
                        void runBatchWriteByAi("speed");
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        border: "none",
                        borderRadius: 6,
                        background: batchWriteMode === "speed" ? "var(--accent-dim)" : "transparent",
                        color: "var(--text-primary)",
                        textAlign: "left",
                        padding: "8px 10px",
                        cursor: "pointer",
                      }}
                    >
                      <Zap size={14} color="var(--accent-gold)" />
                      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>速度推土机</span>
                        <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>一次成稿，无视节拍约束</span>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        void runBatchWriteByAi("quality");
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        border: "none",
                        borderRadius: 6,
                        background: batchWriteMode === "quality" ? "var(--accent-dim)" : "transparent",
                        color: "var(--text-primary)",
                        textAlign: "left",
                        padding: "8px 10px",
                        cursor: "pointer",
                      }}
                    >
                      <LayoutList size={14} color="#4CAF50" />
                      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>品质导演</span>
                        <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>严格按章节节拍，逐段生成</span>
                      </div>
                    </button>
                  </div>
                )}
              </div>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  userSelect: "none",
                }}
                title="开启后会覆盖已有正文；关闭时仅写空章（推荐）"
              >
                <input
                  type="checkbox"
                  checked={batchWriteOverwrite}
                  onChange={(e) => setBatchWriteOverwrite(e.currentTarget.checked)}
                  disabled={isBatchWriting || isAiPlanning || isGeneratingVolumes}
                  style={{ width: 14, height: 14, margin: 0, accentColor: "var(--accent-gold)" }}
                />
                覆盖正文
              </label>
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
              }}
              title="勾选章节后可批量删除"
            >
              <button
                onClick={toggleSelectAllChapters}
                disabled={isAiPlanning || isBatchDeleting || chapters.length === 0}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: (isAiPlanning || isBatchDeleting || chapters.length === 0) ? "not-allowed" : "pointer",
                }}
              >
                {allSelected ? "取消全选" : "全选"}
              </button>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>已选 {selectedCount}</span>
              <button
                onClick={clearChapterSelection}
                disabled={isAiPlanning || isBatchDeleting || selectedCount === 0}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: (isAiPlanning || isBatchDeleting || selectedCount === 0) ? "not-allowed" : "pointer",
                }}
              >
                清空
              </button>
              <button
                onClick={deleteSelectedChapters}
                disabled={isAiPlanning || isBatchDeleting || selectedCount === 0}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--bg-border)",
                  background: "transparent",
                  color: "var(--status-inactive)",
                  fontSize: 12,
                  padding: "0 8px",
                  cursor: (isAiPlanning || isBatchDeleting || selectedCount === 0) ? "not-allowed" : "pointer",
                  opacity: (isAiPlanning || isBatchDeleting || selectedCount === 0) ? 0.7 : 1,
                }}
              >
                {isBatchDeleting ? "删除中..." : `批量删除(${selectedCount})`}
              </button>
            </div>
            <PrimaryButton onClick={createChapter}><Plus size={14} />新建章节</PrimaryButton>
          </div>
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {lastAiResult && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--bg-border)",
            background: "var(--bg-card)",
            fontSize: 12,
            color: "var(--text-secondary)",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          {lastAiResult.effective_range && (
            <span>
              区间：第{lastAiResult.effective_range.start_chapter}-{lastAiResult.effective_range.end_chapter}章
            </span>
          )}
          {lastAiResult.batch_stats && (
            <span>
              批次：{lastAiResult.batch_stats.success_batches ?? 0}/{lastAiResult.batch_stats.planned_batches ?? 0}
            </span>
          )}
          <span>新增/更新：{lastAiResult.inserted?.chapters ?? 0}</span>
          <span>跳过：{lastAiResult.skipped?.chapters ?? 0}</span>
          <span>降批重试：{lastAiResult.retry_count ?? 0}</span>
          {lastAiResult.failed_range && (
            <span style={{ color: "var(--status-warning)" }}>
              未完成：第{lastAiResult.failed_range.start_chapter}-{lastAiResult.failed_range.end_chapter}章
            </span>
          )}
          {lastAiResult.failed_range && (
            <span style={{ color: "var(--status-warning)" }}>
              建议：从失败区间起按 10-20 章重试，或先点「下一批20章」。
            </span>
          )}
          {lastAiResult.format_degraded && (
            <span style={{ color: "var(--status-warning)" }}>提示：4.4 缺失，已使用默认章节格式</span>
          )}
        </div>
      )}
      {lastBatchWriteResult && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--bg-border)",
            background: "var(--bg-card)",
            fontSize: 12,
            color: "var(--text-secondary)",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          <span>范围：{lastBatchWriteResult.scope_label}</span>
          <span>计划：{lastBatchWriteResult.planned} 章</span>
          <span>执行：{lastBatchWriteResult.to_write} 章</span>
          <span>成功：{lastBatchWriteResult.written} 章</span>
          <span>失败：{lastBatchWriteResult.failed} 章</span>
          <span>跳过已有正文：{lastBatchWriteResult.skipped_non_empty} 章</span>
          <span>创作模式：{BATCH_WRITE_MODE_LABEL[lastBatchWriteResult.mode]}</span>
          <span>模式：{lastBatchWriteResult.overwrite ? "覆盖已有正文" : "仅写空章"}</span>
          {lastBatchWriteResult.failed_items.length > 0 && (
            <span style={{ color: "var(--status-warning)" }}>
              失败示例：
              {lastBatchWriteResult.failed_items
                .slice(0, 3)
                .map((item) => `第${item.chapter_num}章（${item.reason.slice(0, 24)}${item.reason.length > 24 ? "..." : ""}）`)
                .join("、")}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <Loading />
      ) : chapters.length === 0 ? (
        <EmptyState
          icon="📝"
          title="还没有章节"
          description="点击右上角「新建章节」开始创作"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {chapters.map((ch) => {
            const st = STATUS_MAP[ch.status] || STATUS_MAP.draft;
            const phaseColor = PHASE_COLORS[ch.phase] || "var(--text-secondary)";
            const isSelected = selectedIdSet.has(ch.id);
            const normalizedDefaultTitle = `第${ch.chapter_num}章`;
            const rawTitle = String(ch.title || "").trim();
            const mergedTitle = !rawTitle || rawTitle === normalizedDefaultTitle
              ? normalizedDefaultTitle
              : `${normalizedDefaultTitle} · ${rawTitle}`;
            const synopsisText = String(ch.synopsis || "").trim() || "暂无梗概";
            return (
              <div
                key={ch.id}
                role="button"
                tabIndex={0}
                aria-label={`进入写作工坊：第${ch.chapter_num}章`}
                style={{
                  display: "flex", alignItems: "center", gap: 16,
                  padding: "16px 20px", borderRadius: 12,
                  border: isSelected ? "1px solid var(--accent)" : "1px solid var(--bg-border)", cursor: "pointer",
                  background: isSelected ? "rgba(201,168,76,0.08)" : "transparent",
                  transition: "border-color 0.15s, background 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent)";
                  e.currentTarget.style.background = "rgba(201,168,76,0.04)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = isSelected ? "var(--accent)" : "var(--bg-border)";
                  e.currentTarget.style.background = isSelected ? "rgba(201,168,76,0.08)" : "transparent";
                }}
                onClick={(e) => {
                  if (isInteractiveTarget(e.target)) return;
                  openChapterInWorkshop(ch.id);
                }}
                onKeyDown={(e) => {
                  if (isInteractiveTarget(e.target)) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openChapterInWorkshop(ch.id);
                  }
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => toggleChapterSelection(ch.id, e.currentTarget.checked)}
                  disabled={isBatchDeleting}
                  style={{
                    width: 16,
                    height: 16,
                    margin: 0,
                    accentColor: "var(--accent-gold)",
                    cursor: isBatchDeleting ? "not-allowed" : "pointer",
                    flexShrink: 0,
                  }}
                  title="选择章节"
                />
                <div style={{
                  width: 40, height: 40, borderRadius: "50%",
                  background: st.color + "22", display: "flex",
                  alignItems: "center", justifyContent: "center",
                  color: st.color, fontSize: 14, fontWeight: 700, flexShrink: 0,
                }}>
                  {ch.chapter_num}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
                    {editingChapterId === ch.id ? (
                      <>
                        <span style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>第{ch.chapter_num}章 ·</span>
                        <input
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveTitle(ch.id);
                            if (e.key === "Escape") cancelEditTitle();
                          }}
                          autoFocus
                          style={{
                            height: 30,
                            borderRadius: 6,
                            border: "1px solid var(--bg-border)",
                            background: "var(--bg-input)",
                            color: "var(--text-primary)",
                            padding: "0 8px",
                            fontSize: 13,
                            flex: 1,
                            minWidth: 140,
                          }}
                        />
                        <button
                          onClick={() => saveTitle(ch.id)}
                          disabled={savingTitleId === ch.id}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            background: "var(--bg-card)",
                            color: "var(--text-primary)",
                            padding: "3px 6px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          title="保存章节标题"
                        >
                          {savingTitleId === ch.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        </button>
                        <button
                          onClick={cancelEditTitle}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            background: "var(--bg-card)",
                            color: "var(--text-secondary)",
                            padding: "3px 6px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          title="取消编辑"
                        >
                          <X size={12} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span>{mergedTitle}</span>
                        <button
                          onClick={() => startEditTitle(ch)}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            background: "var(--bg-card)",
                            color: "var(--text-secondary)",
                            padding: "2px 6px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          title="编辑章节标题"
                        >
                          <Edit2 size={11} />
                        </button>
                        <button
                          onClick={() => void deleteChapter(ch)}
                          disabled={deletingChapterId === ch.id}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            background: "var(--bg-card)",
                            color: "var(--status-inactive)",
                            padding: "2px 6px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: deletingChapterId === ch.id ? "not-allowed" : "pointer",
                            opacity: deletingChapterId === ch.id ? 0.7 : 1,
                          }}
                          title="删除章节"
                        >
                          {deletingChapterId === ch.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        </button>
                        {ch.phase && (
                          <span style={{
                            padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                            background: phaseColor + "22", color: phaseColor,
                          }}>
                            {ch.phase}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                    margin: 0,
                  }}>
                    {editingSynopsisChapterId === ch.id ? (
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <textarea
                          value={editingSynopsis}
                          onChange={(e) => setEditingSynopsis(e.target.value)}
                          onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                              e.preventDefault();
                              void saveSynopsis(ch.id);
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              cancelEditSynopsis();
                            }
                          }}
                          autoFocus
                          rows={3}
                          placeholder="输入章节梗概（可留空）"
                          style={{
                            flex: 1,
                            minWidth: 220,
                            resize: "vertical",
                            borderRadius: 6,
                            border: "1px solid var(--bg-border)",
                            background: "var(--bg-input)",
                            color: "var(--text-primary)",
                            padding: "6px 8px",
                            fontSize: 12,
                            lineHeight: 1.45,
                          }}
                        />
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <button
                            onClick={() => void saveSynopsis(ch.id)}
                            disabled={savingSynopsisId === ch.id}
                            style={{
                              border: "1px solid var(--bg-border)",
                              borderRadius: 6,
                              background: "var(--bg-card)",
                              color: "var(--text-primary)",
                              padding: "4px 7px",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                            title="保存章节梗概（Ctrl/Cmd+Enter）"
                          >
                            {savingSynopsisId === ch.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          </button>
                          <button
                            onClick={cancelEditSynopsis}
                            style={{
                              border: "1px solid var(--bg-border)",
                              borderRadius: 6,
                              background: "var(--bg-card)",
                              color: "var(--text-secondary)",
                              padding: "4px 7px",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                            title="取消编辑"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {synopsisText}
                        </span>
                        <button
                          onClick={() => startEditSynopsis(ch)}
                          style={{
                            border: "1px solid var(--bg-border)",
                            borderRadius: 6,
                            background: "var(--bg-card)",
                            color: "var(--text-secondary)",
                            padding: "2px 6px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                          title="编辑章节梗概"
                        >
                          <Edit2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {ch.word_count > 0 ? ch.word_count.toLocaleString() + " 字" : "-"}
                  </div>
                  <span style={{
                    padding: "2px 10px", borderRadius: 4,
                    background: st.color + "22", color: st.color, fontSize: 11,
                  }}>
                    {st.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
