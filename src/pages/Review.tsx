import { useEffect, useMemo, useState } from "react";
import { History, Play } from "lucide-react";
import { useProject } from "../context/ProjectContext";

type ReviewScope = "project" | "chapter";
type ReviewSeverity = "高" | "中" | "低";
type ReviewDimension = "consistency" | "character" | "pacing" | "logic";

interface ChapterItem {
  id: string;
  chapter_num: number;
  title: string;
}

interface ReviewIssue {
  text: string;
  severity: ReviewSeverity;
  dimension: ReviewDimension;
}

interface NormalizedReview {
  id: string;
  project_id: string;
  chapter_id: string | null;
  scope: ReviewScope;
  scores: Record<ReviewDimension, number>;
  issues: ReviewIssue[];
  summary: string;
  created_at: string;
}

const defaultDimensions: Array<{ key: ReviewDimension; label: string; color: string }> = [
  { key: "consistency", label: "内容一致性", color: "#4CAF50" },
  { key: "character", label: "人物塑造", color: "#2196F3" },
  { key: "pacing", label: "叙事节奏", color: "#FF9800" },
  { key: "logic", label: "角色逻辑", color: "#8BC34A" },
];

const severityColor: Record<ReviewSeverity, string> = {
  高: "#F44336",
  中: "#FF9800",
  低: "#9E9E9E",
};

const dimensionLabel: Record<ReviewDimension, string> = {
  consistency: "一致性",
  character: "人物",
  pacing: "节奏",
  logic: "逻辑",
};

const clampScore = (raw: unknown) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const extractScoreFromText = (raw: string, aliases: string[]) => {
  const text = String(raw || "");
  for (const alias of aliases) {
    const re = new RegExp(`${escapeRegExp(alias)}\\s*[：:]\\s*(\\d{1,3})(?:\\s*\\/\\s*100)?`, "i");
    const m = text.match(re);
    if (!m) continue;
    const parsed = Number(m[1]);
    if (Number.isFinite(parsed)) return clampScore(parsed);
  }
  return null;
};

const normalizeDimension = (raw: unknown): ReviewDimension => {
  const text = String(raw || "").toLowerCase();
  if (text.includes("consistency") || text.includes("一致") || text.includes("连贯")) return "consistency";
  if (text.includes("character") || text.includes("人物") || text.includes("角色")) return "character";
  if (text.includes("pacing") || text.includes("节奏") || text.includes("推进")) return "pacing";
  return "logic";
};

const normalizeSeverity = (raw: unknown): ReviewSeverity => {
  const text = String(raw || "").toLowerCase();
  if (text.includes("高") || text.includes("high") || text.includes("严重") || text.includes("fatal")) return "高";
  if (text.includes("低") || text.includes("low") || text.includes("轻微")) return "低";
  return "中";
};

const parseJsonMaybe = (raw: unknown) => {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
};

const normalizeScores = (raw: unknown, issues: ReviewIssue[], rawSummary?: string): Record<ReviewDimension, number> => {
  const parsed = parseJsonMaybe(raw);
  const result: Record<ReviewDimension, number> = {
    consistency: 0,
    character: 0,
    pacing: 0,
    logic: 0,
  };

  if (parsed && typeof parsed === "object") {
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      const dim = normalizeDimension(key);
      result[dim] = clampScore(value);
    });
  }

  const aliasMap: Record<ReviewDimension, string[]> = {
    consistency: ["内容一致性", "一致性", "主线一致性", "世界链", "世界观链", "consistency"],
    character: ["人物塑造", "角色塑造", "人设链", "人设", "character"],
    pacing: ["叙事节奏", "推进节奏", "节奏链", "节奏", "pacing"],
    logic: ["角色逻辑", "因果逻辑", "逻辑链", "逻辑", "logic"],
  };
  (Object.keys(result) as ReviewDimension[]).forEach((key) => {
    if (result[key] > 0) return;
    const parsedScore = extractScoreFromText(String(rawSummary || ""), aliasMap[key]);
    if (parsedScore != null) result[key] = parsedScore;
  });

  const high = issues.filter((i) => i.severity === "高").length;
  const medium = issues.filter((i) => i.severity === "中").length;
  const low = issues.filter((i) => i.severity === "低").length;
  const fallback = Math.max(22, Math.min(94, 84 - high * 16 - medium * 8 - low * 4));
  (Object.keys(result) as ReviewDimension[]).forEach((key) => {
    if (result[key] > 0) return;
    // 没有结构化评分且也无法从摘要提取时：
    // - 有问题清单：给出可解释的启发式分
    // - 无问题清单：保持 0，避免“所有维度默认 84”造成误导
    result[key] = issues.length > 0 ? fallback : 0;
  });
  return result;
};

const normalizeIssues = (raw: unknown): ReviewIssue[] => {
  const parsed = parseJsonMaybe(raw);
  if (!Array.isArray(parsed)) return [];

  const issues: ReviewIssue[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) continue;
      const issue: ReviewIssue = {
        text,
        severity: normalizeSeverity(text),
        dimension: normalizeDimension(text),
      };
      const key = `${issue.dimension}:${issue.severity}:${issue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = String(row.text || row.detail || row.description || row.issue || "").trim();
    if (!text) continue;
    const issue: ReviewIssue = {
      text,
      severity: normalizeSeverity(row.severity || row.level || row.priority),
      dimension: normalizeDimension(row.dimension || row.type || text),
    };
    const key = `${issue.dimension}:${issue.severity}:${issue.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues.slice(0, 20);
};

const normalizeReviewRow = (row: any, fallbackScope: ReviewScope): NormalizedReview => {
  const issues = normalizeIssues(row?.issues || []);
  const scores = normalizeScores(row?.scores || {}, issues, row?.summary || "");
  const summary = String(row?.summary || "").replace(/\r\n/g, "\n").trim();
  const chapterIdRaw = String(row?.chapter_id || "").trim();
  return {
    id: String(row?.id || `${Date.now()}-${Math.random()}`),
    project_id: String(row?.project_id || ""),
    chapter_id: chapterIdRaw || null,
    scope: chapterIdRaw ? "chapter" : fallbackScope,
    scores,
    issues,
    summary,
    created_at: String(row?.created_at || ""),
  };
};

export default function Review() {
  const { currentProject, api } = useProject();
  const pid = currentProject?.id;

  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [scope, setScope] = useState<ReviewScope>("project");
  const [chapterId, setChapterId] = useState("");
  const [review, setReview] = useState<NormalizedReview | null>(null);
  const [history, setHistory] = useState<NormalizedReview[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);

  useEffect(() => {
    if (!pid) return;
    api<ChapterItem[]>(`/api/chapters/?project_id=${pid}`)
      .then((list) => {
        const sorted = Array.isArray(list)
          ? list.slice().sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0))
          : [];
        setChapters(sorted);
        if (!chapterId && sorted.length > 0) {
          setChapterId(sorted[0].id);
        }
      })
      .catch(() => setChapters([]));
  }, [pid, api]);

  const latestQuery = useMemo(() => {
    if (!pid) return "";
    const params = new URLSearchParams();
    params.set("project_id", pid);
    params.set("scope", scope);
    if (scope === "chapter" && chapterId) {
      params.set("chapter_id", chapterId);
    }
    return `/api/content/reviews/latest?${params.toString()}`;
  }, [pid, scope, chapterId]);

  useEffect(() => {
    if (!pid) return;
    if (scope === "chapter" && !chapterId) {
      setReview(null);
      return;
    }
    setLoadingLatest(true);
    api<any | null>(latestQuery)
      .then((row) => setReview(row ? normalizeReviewRow(row, scope) : null))
      .catch(() => setReview(null))
      .finally(() => setLoadingLatest(false));
  }, [pid, api, latestQuery, scope, chapterId]);

  const runReview = async () => {
    if (!pid || running) return;
    if (scope === "chapter" && !chapterId) return;

    setRunning(true);
    try {
      const res = await api<NormalizedReview>("/api/content/reviews/run", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          scope,
          chapter_id: scope === "chapter" ? chapterId : undefined,
        }),
      });
      setReview({
        ...res,
        scope,
        chapter_id: res.chapter_id || null,
        scores: normalizeScores(res.scores, normalizeIssues(res.issues), res.summary || ""),
        issues: normalizeIssues(res.issues),
        summary: String(res.summary || "").replace(/\r\n/g, "\n"),
      });
      setShowHistory(false);
    } catch (e) {
      console.error("审阅失败:", e);
    } finally {
      setRunning(false);
    }
  };

  const loadHistory = async () => {
    if (!pid) return;
    const params = new URLSearchParams();
    params.set("project_id", pid);
    params.set("scope", scope);
    if (scope === "chapter" && chapterId) params.set("chapter_id", chapterId);
    const list = await api<any[]>(`/api/content/reviews?${params.toString()}`);
    setHistory((list || []).map((row) => normalizeReviewRow(row, scope)));
    setShowHistory(true);
  };

  if (!pid) {
    return (
      <div style={{ padding: 32, color: "var(--text-secondary)", textAlign: "center", marginTop: 80 }}>
        请先选择一个项目
      </div>
    );
  }

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>审核中心</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as ReviewScope)}
            style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13, padding: "0 10px" }}
          >
            <option value="project">整本审阅</option>
            <option value="chapter">按章节审阅</option>
          </select>
          {scope === "chapter" && (
            <select
              value={chapterId}
              onChange={(e) => setChapterId(e.target.value)}
              style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13, padding: "0 10px", minWidth: 180 }}
            >
              {chapters.length === 0 ? (
                <option value="">暂无章节</option>
              ) : (
                chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    第{ch.chapter_num}章 · {ch.title}
                  </option>
                ))
              )}
            </select>
          )}
          <button
            onClick={runReview}
            disabled={running || loadingLatest || (scope === "chapter" && !chapterId)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontSize: 13, cursor: running ? "wait" : "pointer", opacity: running ? 0.6 : 1 }}
          >
            <Play size={14} />{running ? "审阅中..." : "发起审阅"}
          </button>
          <button
            onClick={loadHistory}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" }}
          >
            <History size={14} />历史记录
          </button>
        </div>
      </div>

      {!review && !running && (
        <div style={{ textAlign: "center", color: "var(--text-secondary)", padding: 60 }}>
          暂无审阅记录，点击「发起审阅」开始 AI 审核
        </div>
      )}

      {review && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 16 }}>
            {defaultDimensions.map((d) => {
              const score = review.scores[d.key] ?? 0;
              return (
                <div key={d.key} style={{ textAlign: "center", padding: 18, borderRadius: 10, border: "1px solid var(--bg-border)", background: "var(--bg-card)" }}>
                  <div style={{ fontSize: 34, fontWeight: 700, color: d.color }}>{score}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{d.label}</div>
                  <div style={{ height: 4, borderRadius: 2, background: "var(--bg-border)", marginTop: 12 }}>
                    <div style={{ height: "100%", borderRadius: 2, background: d.color, width: `${score}%` }} />
                  </div>
                </div>
              );
            })}
          </div>

          {review.summary && (
            <div
              style={{
                padding: 16,
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
                fontSize: 13,
                lineHeight: 1.75,
                color: "var(--text-secondary)",
                whiteSpace: "pre-wrap",
              }}
            >
              {review.summary}
            </div>
          )}

          {review.issues.length > 0 && (
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>审核问题清单</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {review.issues.map((issue, i) => (
                  <div key={`${issue.text}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: severityColor[issue.severity], flexShrink: 0, marginTop: 6 }} />
                    <span style={{ flex: 1, fontSize: 13, lineHeight: 1.65 }}>{issue.text}</span>
                    <span style={{ padding: "2px 8px", borderRadius: 4, background: severityColor[issue.severity] + "22", color: severityColor[issue.severity], fontSize: 11 }}>
                      {issue.severity}
                    </span>
                    <span style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--bg-border)", color: "var(--text-secondary)", fontSize: 11 }}>
                      {dimensionLabel[issue.dimension]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showHistory && history.length > 0 && (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>历史审阅</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {history.map((h) => (
              <div
                key={h.id}
                onClick={() => {
                  setReview(h);
                  setShowHistory(false);
                }}
                style={{ padding: "12px 16px", borderRadius: 8, border: "1px solid var(--bg-border)", cursor: "pointer", fontSize: 13, background: "var(--bg-card)" }}
              >
                <span style={{ color: "var(--text-secondary)" }}>{h.created_at?.slice(0, 16)}</span>
                <span style={{ marginLeft: 12 }}>
                  {(h.summary || "审阅记录").slice(0, 80)}
                  {(h.summary || "").length > 80 ? "..." : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
