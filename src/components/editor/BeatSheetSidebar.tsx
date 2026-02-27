import { useState, useEffect } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Edit2, Check, X, Loader2, Wand2 } from "lucide-react";
import { useProject } from "../../context/ProjectContext";
import { useToast } from "../ui/ToastProvider";
import type { ChapterBeat } from "../../types";
import { BEATS_UPDATED_EVENT, emitBeatsUpdated } from "../../utils/beatEvents";

export function BeatSheetSidebar({ chapterId }: { chapterId: string }) {
    const { api, currentProject } = useProject();
    const { addToast } = useToast();
    const [beats, setBeats] = useState<ChapterBeat[]>([]);
    const [loading, setLoading] = useState(false);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deletingBeatId, setDeletingBeatId] = useState<string | null>(null);
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [crossChapterHint, setCrossChapterHint] = useState("");

    // Create state
    const [isAdding, setIsAdding] = useState(false);
    const [newContent, setNewContent] = useState("");

    // Edit state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState("");

    const fetchBeatsOnce = async () => {
        if (!chapterId) return [] as ChapterBeat[];
        const list = await api<ChapterBeat[]>(
            `/api/beats/?chapter_id=${encodeURIComponent(chapterId)}&t=${Date.now()}`,
            { cache: "no-store" },
        );
        return Array.isArray(list) ? list : [];
    };

    const loadBeats = async (opts?: { showLoading?: boolean; silent?: boolean }) => {
        const showLoading = opts?.showLoading ?? true;
        const silent = opts?.silent ?? false;
        if (!chapterId) return [] as ChapterBeat[];
        if (showLoading) setLoading(true);
        try {
            const list = await fetchBeatsOnce();
            setBeats(list);
            return list;
        } catch {
            if (!silent) addToast("error", "无法加载节拍表");
            return [] as ChapterBeat[];
        } finally {
            if (showLoading) setLoading(false);
        }
    };

    useEffect(() => {
        setCrossChapterHint("");
        void loadBeats();
    }, [chapterId, api]);

    useEffect(() => {
        if (!chapterId) return;
        const onBeatUpdated = (evt: Event) => {
            const detail = (evt as CustomEvent<{ chapterId?: string }>).detail || {};
            const changedChapterId = String(detail.chapterId || "").trim();
            if (changedChapterId && changedChapterId !== String(chapterId)) return;
            void (async () => {
                try {
                    const latest = await fetchBeatsOnce();
                    setBeats(latest);
                } catch {
                    // ignore silent sync errors
                }
            })();
        };
        window.addEventListener(BEATS_UPDATED_EVENT, onBeatUpdated as EventListener);
        return () => window.removeEventListener(BEATS_UPDATED_EVENT, onBeatUpdated as EventListener);
    }, [chapterId, api]);

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
            if (line.length < 6) continue;
            if (line.length > 120) continue;
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

    const buildFallbackBeatLines = (chapterTitle: string, chapterSynopsis: string, chapterPhase: string) => {
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
        const templates = [
            `围绕${titleHint}${phaseHint}抛出本章首个实质冲突`,
            "关键阻力升级，迫使主角调整行动策略",
            "人物关系或利益对撞，触发新的情节拐点",
            "以明确后果或悬念收束，为下一段承接",
        ];
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

    const buildBeatHealthHints = (beatLines: string[], isFirstChapter: boolean) => {
        const lines = beatLines.map((line) => String(line || "").trim()).filter(Boolean);
        if (lines.length === 0) return [];
        const firstChunk = lines.slice(0, Math.min(2, lines.length)).join(" ");
        const lastLine = lines[lines.length - 1] || "";
        const allText = lines.join(" ");

        const hasTrigger = /异常|冲突|意外|危机|失踪|警报|追捕|爆炸|悬念|疑点|反常|突发|命案|事故/.test(firstChunk);
        const hasAction = /决定|尝试|追|查|冲|谈判|阻止|反击|逃离|潜入|揭开|对峙|寻找|进入|离开|实施|执行|回应/.test(allText);
        const hasChangeOrCost = /代价|损失|受伤|失败|牺牲|风险|升级|恶化|后果|暴露|反转|破裂|崩塌|误判|扭转/.test(allText);
        const hasEndingPull = /未解|悬念|线索|伏笔|问题|下一步|必须|将要|行动|转向|去做|去查|去追/.test(lastLine);

        const hints: string[] = [];
        if (!hasTrigger) hints.push("开头两条可补一个更明确的“触发点/异常”");
        if (!hasAction) hints.push("节拍里可增加更具体的行动动词，减少解释性表述");
        if (!hasChangeOrCost) hints.push("中段可加入“变化或代价”，让局势更有张力");
        if (!hasEndingPull) hints.push("最后一条可加“未解问题/行动动机/悬念钩子”");
        if (isFirstChapter && lines.length < 4) hints.push("首章建议至少 4 条节拍，开篇推进更稳");
        return hints;
    };

    const handleBeatHealthCheck = async () => {
        const lines = beats
            .slice()
            .sort((a, b) => a.order_index - b.order_index)
            .map((beat) => String(beat.content || "").trim())
            .filter(Boolean);
        if (lines.length === 0) {
            addToast("info", "当前还没有节拍可体检。");
            return;
        }
        let isFirstChapter = false;
        try {
            const chapter = await api<any>(`/api/chapters/${chapterId}`);
            isFirstChapter = Number(chapter?.chapter_num || 0) === 1;
        } catch {
            // ignore chapter check error
        }
        const hints = buildBeatHealthHints(lines, isFirstChapter);
        if (hints.length === 0) {
            addToast("success", "节拍体检通过：结构完整。");
        } else {
            addToast("warning", `节拍体检提示：${hints.slice(0, 4).join("；")}`);
        }
    };

    const handleCreate = async () => {
        if (!newContent.trim()) return;
        try {
            const maxOrder = beats.length > 0 ? Math.max(...beats.map(b => b.order_index)) : 0;
            const created = await api<ChapterBeat>("/api/beats/", {
                method: "POST",
                body: JSON.stringify({
                    chapter_id: chapterId,
                    order_index: maxOrder + 1,
                    content: newContent.trim()
                })
            });
            setIsAdding(false);
            setNewContent("");
            if (created && created.id) {
                setBeats((prev) => [...prev, created].sort((a, b) => a.order_index - b.order_index));
            } else {
                void loadBeats({ showLoading: false, silent: true });
            }
            emitBeatsUpdated(chapterId, "create");
            addToast("success", "添加节拍成功");
        } catch {
            addToast("error", "添加节拍失败");
        }
    };

    const handleUpdate = async (id: string, content: string) => {
        if (!content.trim()) return;
        try {
            const updated = await api<ChapterBeat>(`/api/beats/${id}`, {
                method: "PUT",
                body: JSON.stringify({ content: content.trim() })
            });
            setEditingId(null);
            if (updated && updated.id) {
                setBeats((prev) =>
                    prev
                        .map((beat) => (beat.id === updated.id ? updated : beat))
                        .sort((a, b) => a.order_index - b.order_index),
                );
            } else {
                void loadBeats({ showLoading: false, silent: true });
            }
            emitBeatsUpdated(chapterId, "update");
        } catch {
            addToast("error", "修改节拍失败");
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("确定要删除这个节拍吗？")) return;
        if (deleteBusy) return;
        const previousBeats = beats;
        setDeleteBusy(true);
        setDeletingBeatId(id);
        setBeats((prev) => prev.filter((b) => String(b.id) !== String(id)));
        try {
            await api(`/api/beats/${id}`, { method: "DELETE" });
            emitBeatsUpdated(chapterId, "delete");
            addToast("success", "删除成功");
            void loadBeats({ showLoading: false, silent: true });
        } catch {
            // 有些情况下删除已生效但请求返回异常（如响应体解析失败/连接抖动），兜底核验一次。
            try {
                const latest = await fetchBeatsOnce();
                setBeats(latest);
                const alreadyDeleted = !latest.some((b) => String(b.id) === String(id));
                if (alreadyDeleted) {
                    emitBeatsUpdated(chapterId, "delete");
                    addToast("success", "删除成功");
                    return;
                }
            } catch {
                // ignore
            }
            setBeats(previousBeats);
            addToast("error", "删除失败，请重试");
        } finally {
            setDeleteBusy(false);
            setDeletingBeatId(null);
        }
    };

    const moveBeat = async (index: number, direction: 'up' | 'down') => {
        if (direction === 'up' && index === 0) return;
        if (direction === 'down' && index === beats.length - 1) return;

        const beat1 = beats[index];
        const beat2 = direction === 'up' ? beats[index - 1] : beats[index + 1];

        // Swap order_index directly in the objects to immediately update UI, then call API
        const newBeats = [...beats];
        const order1 = beat1.order_index;
        const order2 = beat2.order_index;

        newBeats[index].order_index = order2;
        newBeats[direction === 'up' ? index - 1 : index + 1].order_index = order1;

        // sort based on new order index
        newBeats.sort((a, b) => a.order_index - b.order_index);
        setBeats(newBeats);

        try {
            await Promise.all([
                api(`/api/beats/${beat1.id}`, {
                    method: "PUT",
                    body: JSON.stringify({ order_index: order2 })
                }),
                api(`/api/beats/${beat2.id}`, {
                    method: "PUT",
                    body: JSON.stringify({ order_index: order1 })
                }),
            ]);
            emitBeatsUpdated(chapterId, "reorder");
        } catch {
            addToast("error", "移动失败，请刷新重试");
            await loadBeats({ showLoading: false, silent: true }); // fallback on error
        }
    };

    const handleAiGenerate = async () => {
        if (!chapterId || !currentProject?.id) return;
        setIsAiGenerating(true);
        setCrossChapterHint("");
        addToast("info", "🧠 AI 正在为您构思本章的剧情节拍...");
        try {
            const [chapter, chaptersRes, bibleRes, outlinesRes, charsRes, worldRes] = await Promise.all([
                api<any>(`/api/chapters/${chapterId}`),
                api<any[]>(`/api/chapters/?project_id=${currentProject.id}`).catch(() => []),
                api<any | null>(`/api/pipeline/bible/latest?project_id=${currentProject.id}`).catch(() => null),
                api<any[]>(`/api/content/outlines?project_id=${currentProject.id}`).catch(() => []),
                api<any[]>(`/api/characters/?project_id=${currentProject.id}`).catch(() => []),
                api<any[]>(`/api/content/worldbuilding?project_id=${currentProject.id}`).catch(() => []),
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
            const normalizeLite = (text: string) =>
                String(text || "")
                    .toLowerCase()
                    .replace(/\s+/g, "")
                    .replace(/[，。！？、,.!?;；:：'"“”‘’（）()\[\]【】\-—_]/g, "");

            const calcBigramSimilarityLite = (a: string, b: string) => {
                const textA = normalizeLite(a);
                const textB = normalizeLite(b);
                if (!textA && !textB) return 1;
                if (!textA || !textB) return 0;
                if (textA.length < 2 || textB.length < 2) return textA === textB ? 1 : 0;
                const toBigrams = (input: string) => {
                    const map = new Map<string, number>();
                    for (let i = 0; i < input.length - 1; i += 1) {
                        const gram = input.slice(i, i + 2);
                        map.set(gram, (map.get(gram) || 0) + 1);
                    }
                    return map;
                };
                const gramsA = toBigrams(textA);
                const gramsB = toBigrams(textB);
                let overlap = 0;
                let totalA = 0;
                let totalB = 0;
                gramsA.forEach((count, gram) => {
                    totalA += count;
                    overlap += Math.min(count, gramsB.get(gram) || 0);
                });
                gramsB.forEach((count) => { totalB += count; });
                if (totalA + totalB === 0) return 0;
                return (2 * overlap) / (totalA + totalB);
            };

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
                const stop = new Set(["然后", "于是", "最后", "开始", "进行", "继续", "出现", "发生", "他们", "她们", "我们", "你们", "一个", "一些", "这个", "那个", "这里", "那里", "已经", "需要", "必须", "可以", "通过"]);
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
                    const maxSimilarity = nextClauses.reduce((max, nextClause) => Math.max(max, calcBigramSimilarityLite(clause, nextClause)), 0);
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

            const existingBeatRows = beats.slice().sort((a, b) => a.order_index - b.order_index);
            let shouldReplaceExistingBeats = false;
            if (existingBeatRows.length > 0) {
                shouldReplaceExistingBeats = window.confirm(
                    "检测到本章已有节拍。\n确定：清空旧节拍并按最新梗概重生成（推荐）\n取消：保留旧节拍并在末尾追加。",
                );
            }
            const existingBeats = shouldReplaceExistingBeats
                ? ""
                : existingBeatRows.map((b) => `- ${b.content}`).join("\n");

            if (nextChapter && !nextChapterSynopsis) {
                const ok = window.confirm(
                    `检测到第${nextChapterNum}章《${nextChapterTitle}》梗概为空。\n继续将不做“下一章对比”约束，是否继续生成节拍？`
                );
                if (!ok) {
                    addToast("info", "已取消生成，请先补充下一章梗概。");
                    return;
                }
            }

            const hasCoreData = Boolean(
                chapterSynopsisForPlanning || bibleText || outlines.length > 0 || characters.length > 0 || worldbuilding.length > 0
            );
            if (!hasCoreData) {
                addToast("warning", "缺少可用资料（圣经/大纲/角色/世界观/章节梗概），请先补充任一项后再生成节拍。");
                return;
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
            }
            if (existingBeats) {
                planningPrompt.push("", "【已存在节拍（避免重复）】", existingBeats);
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
                        project_id: currentProject.id,
                        agent_type: "outline_writer",
                        chapter_id: chapterId,
                        message
                    })
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
                    const clauseSimilarity = clauses.reduce((max, clause) => Math.max(max, calcBigramSimilarityLite(text, clause)), 0);
                    const synopsisSimilarity = calcBigramSimilarityLite(text, nextChapterSynopsis);
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
                    if (violating.length === 0) return { ok: true, lines: current, violating: [] as number[] };
                    const rewritten = await rewriteViolatingBeats(current, violating);
                    const changed = rewritten.length === current.length && rewritten.some((line, idx) => line !== current[idx]);
                    current = rewritten;
                    if (!changed) return { ok: false, lines: current, violating };
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

            let newBeatsTexts = await runPlanner(planningPrompt.join("\n"));
            if (newBeatsTexts.length === 0) {
                const retryPrompt = [
                    planningPrompt.join("\n"),
                    "",
                    "你上一次输出包含无效内容（追问/说明/格式不符）。",
                    "现在请只输出 4-5 条“可直接写作”的动作节拍，不要出现任何问句和“请提供信息”语句。"
                ].join("\n");
                newBeatsTexts = await runPlanner(retryPrompt);
            }
            if (newBeatsTexts.length === 0) {
                newBeatsTexts = buildFallbackBeatLines(chapterTitle, chapterSynopsisForPlanning, chapterPhase);
            }
            if (newBeatsTexts.length > 0 && nextChapterSynopsis) {
                const guarded = await enforceNextChapterGuard(newBeatsTexts);
                if (!guarded.ok) {
                    const bad = guarded.violating.length > 0 ? guarded.violating.join("、") : "未知";
                    addToast("warning", `节拍可能触及下一章核心内容（序号：${bad}）。已保留生成结果，请手动调整。`);
                    setCrossChapterHint(`跨章提示：第 ${bad} 条可能提前触及下一章核心内容。`);
                } else {
                    setCrossChapterHint("");
                }
                if (guarded.lines.length === newBeatsTexts.length) {
                    newBeatsTexts = guarded.lines;
                }
                const changed = guarded.lines.length === newBeatsTexts.length && guarded.lines.some((line, idx) => line !== newBeatsTexts[idx]);
                if (changed) addToast("info", "已执行跨章硬校验并自动修订冲突节拍。");
            }

            if (newBeatsTexts.length === 0) {
                addToast("warning", "AI 未能生成有效节拍。请补充章节梗概后重试。");
                return;
            }

            if (shouldReplaceExistingBeats && existingBeatRows.length > 0) {
                await Promise.allSettled(
                    existingBeatRows.map((beat) => api(`/api/beats/${beat.id}`, { method: "DELETE" })),
                );
            }

            let currentOrder = 0;
            if (!shouldReplaceExistingBeats) {
                currentOrder = existingBeatRows.length > 0 ? Math.max(...existingBeatRows.map((b) => b.order_index)) : 0;
            }
            for (const text of newBeatsTexts) {
                currentOrder++;
                await api("/api/beats/", {
                    method: "POST",
                    body: JSON.stringify({
                        chapter_id: chapterId,
                        order_index: currentOrder,
                        content: text
                    })
                });
            }
            emitBeatsUpdated(chapterId, "ai-generate");

            const expectedMin = shouldReplaceExistingBeats
                ? newBeatsTexts.length
                : (existingBeatRows.length + newBeatsTexts.length);
            let latest = await loadBeats();
            for (let attempt = 0; attempt < 2 && latest.length < expectedMin; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 350));
                try {
                    latest = await fetchBeatsOnce();
                    setBeats(latest);
                } catch {
                    break;
                }
            }
            addToast("success", `AI 已成功生成 ${newBeatsTexts.length} 个节拍！`);
        } catch {
            addToast("error", "AI 生成节拍失败，请检查网络或配置");
        } finally {
            setIsAiGenerating(false);
        }
    };

    if (!chapterId) {
        return <div style={{ fontSize: 13, color: "var(--text-secondary)", textAlign: "center", padding: 20 }}>请先选择章节</div>;
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", alignItems: "center", gap: 8 }}>
                <button
                    onClick={handleBeatHealthCheck}
                    style={{
                        background: "var(--bg-card)",
                        border: "1px solid var(--bg-border)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 4,
                        fontSize: 11,
                        padding: "0 8px",
                        height: 30,
                        borderRadius: 8,
                        whiteSpace: "nowrap",
                        lineHeight: 1,
                        minWidth: 0,
                        width: "100%",
                    }}
                    title="仅提示，不会修改节拍"
                >
                    <Check size={12} /> 体检
                </button>
                <button onClick={handleAiGenerate} disabled={isAiGenerating} style={{
                    background: "rgba(33, 150, 243, 0.14)",
                    border: "1px solid rgba(33, 150, 243, 0.38)",
                    color: "#1b6fae",
                    cursor: isAiGenerating ? "not-allowed" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    fontSize: 11,
                    padding: "0 8px",
                    height: 30,
                    borderRadius: 8,
                    opacity: isAiGenerating ? 0.6 : 1,
                    whiteSpace: "nowrap",
                    lineHeight: 1,
                    minWidth: 0,
                    width: "100%",
                }} title="让 AI 为本章自动规划剧情节拍">
                    {isAiGenerating ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    {isAiGenerating ? "构思中" : "AI扩写"}
                </button>
                <button onClick={() => setIsAdding(!isAdding)} style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--bg-border)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    fontSize: 11,
                    padding: "0 8px",
                    height: 30,
                    borderRadius: 8,
                    whiteSpace: "nowrap",
                    lineHeight: 1,
                    minWidth: 0,
                    width: "100%",
                }}>
                    <Plus size={14} /> 新增
                </button>
            </div>
            {crossChapterHint && (
                <div
                    style={{
                        border: "1px solid rgba(255, 152, 0, 0.55)",
                        background: "rgba(255, 152, 0, 0.12)",
                        color: "#9a6200",
                        borderRadius: 8,
                        fontSize: 11,
                        lineHeight: 1.4,
                        padding: "6px 8px",
                    }}
                    title="仅提示，不阻止保存"
                >
                    {crossChapterHint}
                </div>
            )}

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingBottom: 20 }}>
                {loading ? (
                    <div style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)" }}><Loader2 className="animate-spin" size={20} style={{ margin: "0 auto" }} /></div>
                ) : beats.length === 0 && !isAdding ? (
                    <div style={{ padding: 20, textAlign: "center", color: "var(--text-secondary)", fontSize: 12 }}>暂无节拍，请添加手动节拍或使用 AI 扩写。</div>
                ) : (
                    beats.map((beat, index) => (
                        <div key={beat.id} style={{
                            background: "var(--bg-input)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8,
                            border: beat.status === 'done' ? "1px solid var(--accent-gold-dim)" : "1px solid transparent"
                        }}>
                            {editingId === beat.id ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <textarea
                                        value={editContent}
                                        onChange={e => setEditContent(e.target.value)}
                                        style={{
                                            width: "100%", minHeight: 60, background: "var(--bg)", border: "1px solid var(--bg-border)",
                                            borderRadius: 6, color: "inherit", padding: 8, fontSize: 12, resize: "vertical", outline: "none"
                                        }}
                                        autoFocus
                                    />
                                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                        <button onClick={() => setEditingId(null)} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}><X size={14} /> 取消</button>
                                        <button onClick={() => handleUpdate(beat.id, editContent)} style={{ background: "none", border: "none", color: "var(--accent-gold)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}><Check size={14} /> 保存</button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>
                                        <span style={{ color: "var(--accent-gold)", marginRight: 6, fontWeight: 700 }}>{index + 1}.</span>
                                        {beat.content}
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                                        <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8 }}>
                                            <span style={{
                                                color: beat.status === 'done' ? '#4CAF50' : (beat.status === 'writing' ? 'var(--accent-gold)' : 'var(--text-secondary)')
                                            }}>
                                                {beat.status === 'done' ? '✅ 已写完' : (beat.status === 'writing' ? '✍️ 写作中' : '⏳ 待写')}
                                            </span>
                                        </div>
                                        <div style={{ display: "flex", gap: 6 }}>
                                            <button onClick={() => moveBeat(index, 'up')} disabled={index === 0} style={{ background: "none", border: "none", color: index === 0 ? "var(--bg-border)" : "var(--text-secondary)", cursor: index === 0 ? "not-allowed" : "pointer", padding: 0 }} title="上移"><ArrowUp size={14} /></button>
                                            <button onClick={() => moveBeat(index, 'down')} disabled={index === beats.length - 1} style={{ background: "none", border: "none", color: index === beats.length - 1 ? "var(--bg-border)" : "var(--text-secondary)", cursor: index === beats.length - 1 ? "not-allowed" : "pointer", padding: 0 }} title="下移"><ArrowDown size={14} /></button>
                                            <button onClick={() => { setEditingId(beat.id); setEditContent(beat.content); }} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", padding: 0 }} title="编辑"><Edit2 size={14} /></button>
                                            <button
                                                onClick={() => handleDelete(beat.id)}
                                                disabled={deleteBusy}
                                                style={{
                                                    background: "none",
                                                    border: "none",
                                                    color: deleteBusy ? "var(--bg-border)" : "var(--status-inactive)",
                                                    cursor: deleteBusy ? "not-allowed" : "pointer",
                                                    padding: 0,
                                                }}
                                                title={deleteBusy ? "删除处理中..." : "删除"}
                                            >
                                                {deleteBusy && deletingBeatId === beat.id ? (
                                                    <Loader2 size={14} className="animate-spin" />
                                                ) : (
                                                    <Trash2 size={14} />
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    ))
                )}

                {isAdding && (
                    <div style={{ background: "var(--bg-input)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                        <textarea
                            value={newContent}
                            onChange={e => setNewContent(e.target.value)}
                            placeholder="输入节拍内容（如：主角进入客栈，遭遇隐刀门刺客...）"
                            style={{
                                width: "100%", minHeight: 60, background: "var(--bg)", border: "1px solid var(--accent-gold-dim)",
                                borderRadius: 6, color: "inherit", padding: 8, fontSize: 12, resize: "vertical", outline: "none"
                            }}
                            autoFocus
                        />
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <button onClick={() => setIsAdding(false)} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}><X size={14} /> 取消</button>
                            <button onClick={handleCreate} disabled={!newContent.trim()} style={{ background: "none", border: "none", color: newContent.trim() ? "var(--accent-gold)" : "var(--text-secondary)", cursor: newContent.trim() ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}><Check size={14} /> 添加</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
