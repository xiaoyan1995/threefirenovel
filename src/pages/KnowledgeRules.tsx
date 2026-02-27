import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileBarChart2, Loader2, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useToast } from "../components/ui/ToastProvider";

interface KnowledgeCollection {
  id: string;
  name: string;
}

interface KnowledgeSource {
  id: string;
  collection_id: string | null;
}

interface KnowledgeProfile {
  id: string;
  name: string;
  genre: string;
  version: number;
  collection_id: string | null;
  text_summary?: string;
  source_ids?: string | string[];
  created_at?: string;
}

interface ActiveProfile {
  project_id: string;
  profile_id: string | null;
  enabled: number | boolean;
  updated_at?: string;
  name?: string;
  genre?: string;
  version?: number;
}

type ProfileMode = "rules_only" | "rules_plus_examples";

const panelStyle: CSSProperties = {
  border: "1px solid var(--bg-border)",
  borderRadius: 12,
  background: "var(--bg-card)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const btnStyle: CSSProperties = {
  border: "1px solid var(--bg-border)",
  borderRadius: 8,
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
};

const inputStyle: CSSProperties = {
  width: "100%",
  height: 36,
  borderRadius: 8,
  border: "1px solid var(--bg-border)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: 13,
  padding: "0 10px",
};

function parseSourceIds(v?: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function asEnabled(v: number | boolean | undefined): boolean {
  return v === true || v === 1;
}

function fmtTime(v?: string): string {
  if (!v) return "--";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString();
}

export default function KnowledgeRules() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentProject, api } = useProject();
  const { addToast } = useToast();
  const pid = currentProject?.id;

  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [bindingId, setBindingId] = useState("");

  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [profiles, setProfiles] = useState<KnowledgeProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<ActiveProfile | null>(null);

  const [name, setName] = useState("通用规则包");
  const [genre, setGenre] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [mode, setMode] = useState<ProfileMode>("rules_only");
  const refreshReqId = useRef(0);

  const refreshData = useCallback(async () => {
    if (!pid) return;
    const id = refreshReqId.current + 1;
    refreshReqId.current = id;
    setLoading(true);
    try {
      const [nextCollections, nextSources, nextProfiles, nextActive] = await Promise.all([
        api<KnowledgeCollection[]>(`/api/knowledge/collections?project_id=${pid}`),
        api<KnowledgeSource[]>(`/api/knowledge/sources?project_id=${pid}`),
        api<KnowledgeProfile[]>(`/api/knowledge/profiles?project_id=${pid}`),
        api<ActiveProfile | null>(`/api/knowledge/profile/active?project_id=${pid}`),
      ]);
      if (refreshReqId.current !== id) return;
      setCollections(nextCollections || []);
      setSources(nextSources || []);
      setProfiles(nextProfiles || []);
      setActiveProfile(nextActive);
    } catch {
      if (refreshReqId.current !== id) return;
      addToast("error", "规则包页面数据加载失败");
    } finally {
      if (refreshReqId.current === id) setLoading(false);
    }
  }, [pid, api, addToast]);

  useEffect(() => {
    if (!pid) {
      setCollections([]);
      setSources([]);
      setProfiles([]);
      setActiveProfile(null);
      return;
    }
    setGenre(currentProject?.genre || "");
    refreshData();
  }, [pid, currentProject?.genre, refreshData]);

  useEffect(() => {
    const fromQuery = searchParams.get("collection_id");
    if (!fromQuery) return;
    if (collections.some((c) => c.id === fromQuery)) {
      setCollectionId(fromQuery);
    }
  }, [searchParams, collections]);

  const collectionSourceCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const src of sources) {
      if (!src.collection_id) continue;
      map.set(src.collection_id, (map.get(src.collection_id) || 0) + 1);
    }
    return map;
  }, [sources]);

  const extractProfile = async () => {
    if (!pid) return;
    if (!name.trim()) {
      addToast("warning", "请填写规则包名称");
      return;
    }
    setExtracting(true);
    try {
      await api<KnowledgeProfile>("/api/knowledge/profile/extract", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          name: name.trim(),
          genre: genre.trim(),
          collection_id: collectionId || null,
          mode,
        }),
      });
      addToast("success", "规则包提炼完成");
      refreshData();
    } catch {
      addToast("error", "规则包提炼失败，请检查 API 设置");
    } finally {
      setExtracting(false);
    }
  };

  const bindProfile = async (profileId: string, enabled: boolean) => {
    if (!pid) return;
    setBindingId(profileId);
    try {
      await api("/api/knowledge/profile/bind", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          profile_id: profileId,
          enabled,
        }),
      });
      addToast("success", enabled ? "规则包已启用" : "规则包已停用");
      refreshData();
    } catch {
      addToast("error", enabled ? "启用失败" : "停用失败");
    } finally {
      setBindingId("");
    }
  };

  const disableAllProfiles = async () => {
    if (!pid) return;
    setBindingId("disable-all");
    try {
      await api("/api/knowledge/profile/bind", {
        method: "POST",
        body: JSON.stringify({
          project_id: pid,
          profile_id: null,
          enabled: false,
        }),
      });
      addToast("success", "已关闭当前项目规则包");
      refreshData();
    } catch {
      addToast("error", "停用规则包失败");
    } finally {
      setBindingId("");
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!pid) return;
    const target = profiles.find((x) => x.id === profileId);
    if (!target) return;
    if (!window.confirm(`确认删除规则包「${target.name} v${target.version}」？`)) return;
    try {
      await api(`/api/knowledge/profiles/${profileId}?project_id=${pid}`, { method: "DELETE" });
      addToast("success", "规则包已删除");
      refreshData();
    } catch {
      addToast("error", "删除规则包失败");
    }
  };

  if (!pid) return <div style={{ padding: 40, color: "var(--text-secondary)" }}>请先选择一个项目</div>;

  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, color: "#27456d" }}>规则包中心</h1>
          <p style={{ margin: "2px 0 0", color: "var(--text-secondary)", fontSize: 12 }}>基于资料集提炼规则包，并绑定到当前项目写作流程。</p>
        </div>
        <button onClick={refreshData} style={btnStyle} disabled={loading}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: 10 }}>
        <aside style={{ ...panelStyle, minHeight: 730 }}>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-assets")}>
            个人知识库
          </button>
          <button
            style={{ ...btnStyle, justifyContent: "flex-start", background: "var(--accent-gold-dim)", color: "var(--accent-gold)", fontWeight: 700 }}
            onClick={() => navigate("/knowledge-rules")}
          >
            规则包中心
          </button>
          <button style={{ ...btnStyle, justifyContent: "flex-start" }} onClick={() => navigate("/knowledge-templates")}>
            全局模板库
          </button>

          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>选择一个资料集后，点击右侧“开始提炼”。</div>
          <button
            onClick={() => setCollectionId("")}
            style={{
              ...btnStyle,
              justifyContent: "flex-start",
              background: collectionId === "" ? "var(--accent-gold-dim)" : "var(--bg-card)",
              color: collectionId === "" ? "var(--accent-gold)" : "var(--text-primary)",
            }}
          >
            全部资料
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
            {collections.map((c) => (
              <button
                key={c.id}
                onClick={() => setCollectionId(c.id)}
                style={{
                  ...btnStyle,
                  justifyContent: "space-between",
                  background: collectionId === c.id ? "var(--accent-gold-dim)" : "var(--bg-card)",
                  color: collectionId === c.id ? "var(--accent-gold)" : "var(--text-primary)",
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{collectionSourceCount.get(c.id) || 0}</span>
              </button>
            ))}
          </div>
        </aside>

        <section style={{ ...panelStyle, minHeight: 730, gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={14} /> 提炼新规则包
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="规则包名称" />
            <input style={inputStyle} value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="题材（可选）" />
            <select style={inputStyle} value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              <option value="">从全部资料中提炼</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{collectionSourceCount.get(c.id) || 0}）
                </option>
              ))}
            </select>
            <select style={inputStyle} value={mode} onChange={(e) => setMode(e.target.value as ProfileMode)}>
              <option value="rules_only">仅规则</option>
              <option value="rules_plus_examples">规则 + 示例</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={extractProfile}
              disabled={extracting}
              style={{ ...btnStyle, background: "var(--accent-gold)", color: "#000", border: "none" }}
            >
              {extracting ? <Loader2 size={13} className="animate-spin" /> : <WandSparkles size={13} />}
              {extracting ? "提炼中..." : "开始提炼"}
            </button>
            <button onClick={disableAllProfiles} style={btnStyle} disabled={bindingId === "disable-all"}>
              关闭项目规则包
            </button>
          </div>

          <div style={{ border: "1px solid var(--bg-border)", borderRadius: 10, padding: 10, background: "var(--bg-input)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: "inline-flex", alignItems: "center", gap: 5 }}>
              <FileBarChart2 size={13} /> 当前绑定
            </div>
            {!activeProfile || !activeProfile.profile_id ? (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>未启用规则包</div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {activeProfile.name || "未命名"} v{activeProfile.version || 1} · {asEnabled(activeProfile.enabled) ? "启用中" : "已停用"} · {fmtTime(activeProfile.updated_at)}
              </div>
            )}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700 }}>已有规则包（{profiles.length}）</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", maxHeight: 360 }}>
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfile?.profile_id && asEnabled(activeProfile?.enabled);
              const sourceCount = parseSourceIds(profile.source_ids).length;
              return (
                <div
                  key={profile.id}
                  style={{
                    border: "1px solid var(--bg-border)",
                    borderRadius: 10,
                    background: "var(--bg-input)",
                    padding: 10,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 220, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {profile.name} v{profile.version}
                      {isActive && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--accent-gold)" }}>当前启用</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      题材：{profile.genre || "未指定"} · 文件：{sourceCount} · 创建：{fmtTime(profile.created_at)}
                    </div>
                    {profile.text_summary && <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-secondary)" }}>{profile.text_summary}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => bindProfile(profile.id, true)} style={btnStyle} disabled={bindingId === profile.id}>
                      启用
                    </button>
                    <button onClick={() => bindProfile(profile.id, false)} style={btnStyle} disabled={bindingId === profile.id}>
                      停用
                    </button>
                    <button onClick={() => deleteProfile(profile.id)} style={btnStyle}>
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
            {profiles.length === 0 && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>还没有规则包，先在上面提炼一个。</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
