import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, RefreshCw, Move, ZoomIn, RotateCcw } from "lucide-react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useProject } from "../context/ProjectContext";

interface GraphEvidence {
  chapter_id: string;
  chapter_num: number;
  chapter_title: string;
  snippet: string;
}

interface GraphNode {
  id: string;
  label: string;
  category: string;
  gender?: string;
  age?: string;
  identity?: string;
  personality?: string;
  degree: number;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  raw_type?: string;
  description: string;
  source_label: string;
  target_label: string;
  direction?: "directed" | "bidirectional";
  relation_source?: "explicit" | "identity_inferred" | "content_inferred";
  chapter_nums?: number[];
  first_chapter_num?: number;
  first_chapter_title?: string;
  last_chapter_num?: number;
  last_chapter_title?: string;
  change_chapter_nums?: number[];
  evidence: GraphEvidence[];
}

interface GraphViewMeta {
  mode: "global" | "chapter";
  chapter_id: string;
  chapter_num: number;
  chapter_title: string;
}

interface GraphPayload {
  project_id: string;
  project_name: string;
  view?: GraphViewMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    isolated_count: number;
  };
}

interface ChapterSummary {
  id: string;
  chapter_num: number;
  title: string;
}

type SimNode = GraphNode & SimulationNodeDatum & { pinned?: boolean };
type SimEdge = GraphEdge & SimulationLinkDatum<SimNode>;

const getEndpointId = (endpoint: string | SimNode): string => (
  typeof endpoint === "string" ? endpoint : String(endpoint?.id || "")
);

const getEndpointNode = (endpoint: string | SimNode, map: Map<string, SimNode>): SimNode | undefined => {
  if (typeof endpoint === "string") return map.get(endpoint);
  if (endpoint && typeof endpoint === "object") {
    if (endpoint.id && map.has(endpoint.id)) return map.get(endpoint.id);
    return endpoint;
  }
  return undefined;
};

const colorKey = (category: string) => {
  const text = String(category || "");
  if (text.includes("主角")) return "main";
  if (text.includes("反派")) return "antagonist";
  if (text.includes("配角")) return "support";
  return "other";
};

const baseNodeRadius = (node: Pick<GraphNode, "degree">) =>
  Math.max(16, Math.min(24, 14 + Number(node.degree || 0) * 1.4));

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export default function RelationGraph() {
  const { currentProject, api } = useProject();
  const pid = currentProject?.id;

  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"global" | "chapter">("global");
  const [selectedChapterId, setSelectedChapterId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [graphWidth, setGraphWidth] = useState(900);
  const [graphHeight, setGraphHeight] = useState(540);
  const [tick, setTick] = useState(0);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [layoutSpread, setLayoutSpread] = useState(1.2);

  const graphWrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simulationRef = useRef<Simulation<SimNode, SimEdge> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const pinnedNodesRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const draggingNodeRef = useRef<{
    pointerId: number;
    nodeId: string;
    moved: boolean;
    startX: number;
    startY: number;
    wasPinned: boolean;
  } | null>(null);
  const panningRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const suppressNodeClickRef = useRef("");

  const loadGraph = useCallback(async () => {
    if (!pid) return;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        project_id: pid,
        include_evidence: "1",
        view_mode: viewMode,
      });
      if (viewMode === "chapter" && selectedChapterId) {
        query.set("chapter_id", selectedChapterId);
      }
      const data = await api<GraphPayload>(`/api/graph/relations?${query.toString()}`);
      setGraph(data);
      setSelectedNodeId((prev) => {
        if (data.nodes.some((n) => n.id === prev)) return prev;
        return data.nodes[0]?.id || "";
      });
      setSelectedEdgeId((prev) => (data.edges.some((e) => e.id === prev) ? prev : ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "关系图谱加载失败");
      setGraph(null);
    } finally {
      setLoading(false);
    }
  }, [api, pid, selectedChapterId, viewMode]);

  const loadChapters = useCallback(async () => {
    if (!pid) {
      setChapters([]);
      return;
    }
    try {
      const rows = await api<ChapterSummary[]>(`/api/chapters/?project_id=${pid}`);
      const normalized = [...(rows || [])].sort((a, b) => Number(a.chapter_num || 0) - Number(b.chapter_num || 0));
      setChapters(normalized);
      setSelectedChapterId((prev) => {
        if (prev && normalized.some((c) => c.id === prev)) return prev;
        return normalized[0]?.id || "";
      });
    } catch {
      setChapters([]);
      setSelectedChapterId("");
    }
  }, [api, pid]);

  useEffect(() => {
    setSearch("");
    setViewMode("global");
    setSelectedChapterId("");
    setChapters([]);
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setGraph(null);
    setTransform({ k: 1, x: 0, y: 0 });
    if (!pid) return;
    void loadChapters();
  }, [pid, loadChapters]);

  useEffect(() => {
    if (!pid) return;
    if (viewMode === "chapter" && chapters.length > 0 && !selectedChapterId) return;
    void loadGraph();
  }, [pid, viewMode, selectedChapterId, chapters.length, loadGraph]);

  useEffect(() => {
    if (viewMode !== "chapter") return;
    if (selectedChapterId) return;
    if (chapters.length <= 0) return;
    setSelectedChapterId(chapters[0].id);
  }, [viewMode, selectedChapterId, chapters]);

  useEffect(() => {
    const wrap = graphWrapRef.current;
    if (!wrap) return;
    const updateSize = () => {
      const rect = wrap.getBoundingClientRect();
      setGraphWidth(Math.max(420, Math.floor(rect.width)));
      setGraphHeight(Math.max(360, Math.floor(rect.height)));
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const visibleNodes = useMemo(() => {
    if (!graph) return [];
    const q = search.trim().toLowerCase();
    if (!q) return graph.nodes;
    return graph.nodes.filter((node) => {
      const hitLabel = String(node.label || "").toLowerCase().includes(q);
      const hitCategory = String(node.category || "").toLowerCase().includes(q);
      return hitLabel || hitCategory;
    });
  }, [graph, search]);

  const visibleNodeSet = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter((edge) => visibleNodeSet.has(edge.source) && visibleNodeSet.has(edge.target));
  }, [graph, visibleNodeSet]);

  const selectedRelatedNodeSet = useMemo(() => {
    const set = new Set<string>();
    if (!selectedNodeId) return set;
    set.add(selectedNodeId);
    visibleEdges.forEach((edge) => {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        set.add(edge.source);
        set.add(edge.target);
      }
    });
    return set;
  }, [visibleEdges, selectedNodeId]);

  useEffect(() => {
    simulationRef.current?.stop();
    if (visibleNodes.length === 0) {
      nodesRef.current = [];
      edgesRef.current = [];
      setTick((v) => v + 1);
      return;
    }

    const cx = graphWidth / 2;
    const cy = graphHeight / 2;
    const spread = clamp(layoutSpread, 0.8, 2.2);
    const radius = Math.max(110, Math.min(360, (95 + visibleNodes.length * 8) * spread));

    const nodes: SimNode[] = visibleNodes.map((node, idx) => {
      const angle = (Math.PI * 2 * idx) / Math.max(1, visibleNodes.length);
      const pinned = pinnedNodesRef.current.get(node.id);
      const initX = pinned?.x ?? (cx + Math.cos(angle) * radius + (idx % 3) * 4);
      const initY = pinned?.y ?? (cy + Math.sin(angle) * radius * 0.72 + ((idx + 1) % 3) * 3);
      return {
        ...node,
        x: initX,
        y: initY,
        fx: pinned?.x,
        fy: pinned?.y,
        pinned: !!pinned,
      };
    });

    const edges: SimEdge[] = visibleEdges.map((edge) => ({
      ...edge,
      source: edge.source,
      target: edge.target,
    }));

    nodesRef.current = nodes;
    edgesRef.current = edges;

    const simulation = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(110 * spread)
          .strength(0.42),
      )
      .force("charge", forceManyBody<SimNode>().strength(-320 * spread))
      .force("center", forceCenter<SimNode>(cx, cy))
      .force(
        "collision",
        forceCollide<SimNode>().radius((n) => baseNodeRadius(n) + 8 + 8 * spread).strength(0.9),
      )
      .alpha(1)
      .alphaDecay(0.032);

    simulation.on("tick", () => {
      setTick((v) => (v + 1) % 1000000);
    });

    simulationRef.current = simulation;
    setTick((v) => v + 1);
    return () => {
      simulation.stop();
    };
  }, [visibleNodes, visibleEdges, graphWidth, graphHeight, layoutSpread]);

  useEffect(() => {
    const simulation = simulationRef.current;
    if (!simulation) return;
    simulation.force("center", forceCenter<SimNode>(graphWidth / 2, graphHeight / 2));
    simulation.alpha(0.4).restart();
  }, [graphWidth, graphHeight]);

  const nodesForRender = useMemo(() => {
    const items = [...nodesRef.current];
    items.sort((a, b) => {
      const ay = Number(a.y || 0);
      const by = Number(b.y || 0);
      return ay - by;
    });
    return items;
  }, [tick]);

  const nodeById = useMemo(() => {
    const map = new Map<string, SimNode>();
    nodesRef.current.forEach((n) => map.set(n.id, n));
    return map;
  }, [tick]);

  const edgesForRender = useMemo(() => {
    const items = [...edgesRef.current];
    items.sort((a, b) => {
      const af = getEndpointNode(a.source as string | SimNode, nodeById);
      const at = getEndpointNode(a.target as string | SimNode, nodeById);
      const bf = getEndpointNode(b.source as string | SimNode, nodeById);
      const bt = getEndpointNode(b.target as string | SimNode, nodeById);
      const ay = ((Number(af?.y || 0) + Number(at?.y || 0)) / 2);
      const by = ((Number(bf?.y || 0) + Number(bt?.y || 0)) / 2);
      return ay - by;
    });
    return items;
  }, [tick, nodeById]);

  const pinnedCount = useMemo(
    () => nodesRef.current.filter((n) => n.fx != null && n.fy != null).length,
    [tick],
  );

  const selectedNode = graph?.nodes.find((n) => n.id === selectedNodeId) || null;
  const selectedEdge = graph?.edges.find((e) => e.id === selectedEdgeId) || null;

  const relatedEdges = useMemo(() => {
    if (!graph || !selectedNodeId) return [];
    return graph.edges.filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId);
  }, [graph, selectedNodeId]);

  const toGraphPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - transform.x) / transform.k,
      y: (clientY - rect.top - transform.y) / transform.k,
    };
  };

  const restartLayout = () => {
    pinnedNodesRef.current.clear();
    nodesRef.current.forEach((node) => {
      node.fx = null;
      node.fy = null;
      node.pinned = false;
    });
    simulationRef.current?.alpha(1).restart();
  };

  const resetView = () => {
    setTransform({ k: 1, x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const scale = e.deltaY < 0 ? 1.12 : 0.89;
    setTransform((prev) => {
      const nk = clamp(prev.k * scale, 0.35, 4);
      const nx = px - ((px - prev.x) / prev.k) * nk;
      const ny = py - ((py - prev.y) / prev.k) * nk;
      return { k: nk, x: nx, y: ny };
    });
  };

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (draggingNodeRef.current) return;
    panningRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: transform.x,
      baseY: transform.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleNodePointerDown = (e: React.PointerEvent<SVGGElement>, nodeId: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const node = nodeById.get(nodeId);
    if (!node) return;
    const p = toGraphPoint(e.clientX, e.clientY);
    node.fx = p.x;
    node.fy = p.y;
    draggingNodeRef.current = {
      pointerId: e.pointerId,
      nodeId,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      wasPinned: node.fx != null && node.fy != null,
    };
    simulationRef.current?.alphaTarget(0.36).restart();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const dragging = draggingNodeRef.current;
    if (dragging && dragging.pointerId === e.pointerId) {
      const node = nodeById.get(dragging.nodeId);
      if (node) {
        const p = toGraphPoint(e.clientX, e.clientY);
        node.fx = p.x;
        node.fy = p.y;
        if (!dragging.moved) {
          const dx = e.clientX - dragging.startX;
          const dy = e.clientY - dragging.startY;
          if (Math.hypot(dx, dy) > 3) {
            dragging.moved = true;
          }
        }
      }
      return;
    }
    const panning = panningRef.current;
    if (panning && panning.pointerId === e.pointerId) {
      setTransform((prev) => ({
        ...prev,
        x: panning.baseX + (e.clientX - panning.startX),
        y: panning.baseY + (e.clientY - panning.startY),
      }));
    }
  };

  const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const dragging = draggingNodeRef.current;
    if (dragging && dragging.pointerId === e.pointerId) {
      const node = nodeById.get(dragging.nodeId);
      if (node) {
        if (dragging.moved || dragging.wasPinned) {
          const x = Number(node.fx ?? node.x ?? 0);
          const y = Number(node.fy ?? node.y ?? 0);
          node.fx = x;
          node.fy = y;
          node.pinned = true;
          pinnedNodesRef.current.set(node.id, { x, y });
        } else {
          node.fx = null;
          node.fy = null;
          node.pinned = false;
        }
      }
      simulationRef.current?.alphaTarget(0);
      if (dragging.moved) {
        suppressNodeClickRef.current = dragging.nodeId;
      }
      draggingNodeRef.current = null;
    }
    const panning = panningRef.current;
    if (panning && panning.pointerId === e.pointerId) {
      panningRef.current = null;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  if (!pid) {
    return (
      <div style={{ padding: 32, color: "var(--text-secondary)", textAlign: "center", marginTop: 80 }}>
        请先选择一个项目
      </div>
    );
  }

  return (
    <div style={{ padding: 28, display: "flex", flexDirection: "column", gap: 14, height: "100vh", overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>关系图谱</h1>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
            2D 力导图：拖动节点后会固定，双击节点可解除固定；滚轮缩放，按住空白平移。
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
            方向说明：→ 单向关系，↔ 双向关系。
          </div>
          {graph?.view?.mode === "chapter" && graph.view.chapter_num > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
              当前章节视图：第{graph.view.chapter_num}章《{graph.view.chapter_title || "未命名"}》
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 2, border: "1px solid var(--bg-border)", borderRadius: 8, padding: 2, background: "var(--bg-card)" }}>
            <button
              onClick={() => setViewMode("global")}
              style={{
                height: 30,
                borderRadius: 6,
                border: "none",
                background: viewMode === "global" ? "var(--accent-dim)" : "transparent",
                color: "var(--text-primary)",
                fontSize: 12,
                padding: "0 10px",
                cursor: "pointer",
              }}
            >
              全局关系
            </button>
            <button
              onClick={() => setViewMode("chapter")}
              style={{
                height: 30,
                borderRadius: 6,
                border: "none",
                background: viewMode === "chapter" ? "var(--accent-dim)" : "transparent",
                color: "var(--text-primary)",
                fontSize: 12,
                padding: "0 10px",
                cursor: "pointer",
              }}
            >
              按章节
            </button>
          </div>
          {viewMode === "chapter" && (
            <select
              value={selectedChapterId}
              onChange={(e) => setSelectedChapterId(e.target.value)}
              style={{
                height: 34,
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                fontSize: 12,
                padding: "0 8px",
                minWidth: 180,
              }}
            >
              {chapters.length === 0 ? (
                <option value="">暂无章节</option>
              ) : (
                chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    第{ch.chapter_num}章 · {ch.title || "未命名"}
                  </option>
                ))
              )}
            </select>
          )}
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: "var(--text-secondary)" }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索角色 / 分类"
              style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-input)", color: "var(--text-primary)", fontSize: 13, padding: "0 10px 0 30px", minWidth: 220 }}
            />
          </div>
          <div
            style={{
              height: 34,
              borderRadius: 8,
              border: "1px solid var(--bg-border)",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: 12,
              padding: "0 10px",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
            title="向右拉开可增大节点间距"
          >
            <span style={{ color: "var(--text-secondary)" }}>布局拉开</span>
            <input
              type="range"
              min={0.8}
              max={2.2}
              step={0.05}
              value={layoutSpread}
              onChange={(e) => setLayoutSpread(Number(e.target.value) || 1)}
              style={{ width: 110 }}
            />
            <span style={{ minWidth: 34, textAlign: "right" }}>{layoutSpread.toFixed(2)}x</span>
          </div>
          <button
            onClick={resetView}
            style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", fontSize: 13, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <ZoomIn size={14} /> 重置缩放
          </button>
          <button
            onClick={restartLayout}
            style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", fontSize: 13, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <RotateCcw size={14} /> 释放固定并重排
          </button>
          <button
            onClick={() => void loadGraph()}
            disabled={loading}
            style={{ height: 34, borderRadius: 8, border: "1px solid var(--bg-border)", background: "var(--bg-card)", color: "var(--text-primary)", fontSize: 13, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, cursor: loading ? "wait" : "pointer" }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </div>

      {error && (
        <div style={{ border: "1px solid rgba(244,67,54,0.3)", background: "rgba(244,67,54,0.08)", color: "#c62828", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12, minHeight: 560 }}>
        <div ref={graphWrapRef} style={{ border: "1px solid var(--bg-border)", borderRadius: 12, background: "var(--bg-card)", padding: 8, minHeight: 560 }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 540, color: "var(--text-secondary)", fontSize: 13 }}>
              正在加载关系图谱...
            </div>
          ) : !graph || nodesForRender.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 540, color: "var(--text-secondary)", fontSize: 13 }}>
              暂无可展示关系（请先在角色管理中补充关系数据）
            </div>
          ) : (
            <svg
              ref={svgRef}
              width={graphWidth}
              height={graphHeight}
              onWheel={handleWheel}
              onPointerDown={handleSvgPointerDown}
              onPointerMove={handleSvgPointerMove}
              onPointerUp={handleSvgPointerUp}
              style={{ width: "100%", height: graphHeight, borderRadius: 10, background: "linear-gradient(180deg, rgba(255,255,255,0.52) 0%, rgba(245,248,255,0.9) 100%)", touchAction: "none", cursor: panningRef.current ? "grabbing" : "grab" }}
            >
              <defs>
                <filter id="node-shadow" x="-40%" y="-40%" width="180%" height="180%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" />
                </filter>
                <marker id="arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(94,126,168,0.82)" />
                </marker>
                <marker id="arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 10 0 L 0 5 L 10 10 z" fill="rgba(94,126,168,0.82)" />
                </marker>
                <radialGradient id="grad-main" cx="35%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#d8ffe5" />
                  <stop offset="100%" stopColor="#56C271" />
                </radialGradient>
                <radialGradient id="grad-antagonist" cx="35%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#ffe4e4" />
                  <stop offset="100%" stopColor="#FF6B6B" />
                </radialGradient>
                <radialGradient id="grad-support" cx="35%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#e7f3ff" />
                  <stop offset="100%" stopColor="#4FA8FF" />
                </radialGradient>
                <radialGradient id="grad-other" cx="35%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#f2e8ff" />
                  <stop offset="100%" stopColor="#BB86FC" />
                </radialGradient>
              </defs>

              <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
                {edgesForRender.map((edge) => {
                  const from = getEndpointNode(edge.source as string | SimNode, nodeById);
                  const to = getEndpointNode(edge.target as string | SimNode, nodeById);
                  if (!from || !to) return null;
                  const sourceId = getEndpointId(edge.source as string | SimNode);
                  const targetId = getEndpointId(edge.target as string | SimNode);
                  const bidirectional = String(edge.direction || "").toLowerCase() === "bidirectional";
                  const isSelectedEdge = selectedEdgeId === edge.id;
                  const isRelated = selectedNodeId && (sourceId === selectedNodeId || targetId === selectedNodeId);
                  const fromX = Number(from.x || 0);
                  const fromY = Number(from.y || 0);
                  const toX = Number(to.x || 0);
                  const toY = Number(to.y || 0);
                  const dx = toX - fromX;
                  const dy = toY - fromY;
                  const length = Math.max(1, Math.hypot(dx, dy));
                  const depth = clamp(((fromY + toY) / 2) / Math.max(1, graphHeight), 0, 1);
                  const baseOpacity = 0.16 + depth * 0.34;
                  const rgb = bidirectional ? "121,111,196" : "94,126,168";
                  const baseStroke = `rgba(${rgb},${baseOpacity.toFixed(3)})`;
                  const mx = (fromX + toX) / 2;
                  const my = (fromY + toY) / 2;
                  const nx = -dy / length;
                  const ny = dx / length;
                  const lx = mx + nx * 10;
                  const ly = my + ny * 10;
                  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                  if (angle > 90 || angle < -90) angle += 180;
                  const labelText = `${bidirectional ? "↔" : "→"} ${edge.type || "关系"}`;
                  const labelWidth = Math.max(42, Math.min(210, labelText.length * 7.2 + 8));
                  const showEdgeLabel = selectedNodeId
                    ? Boolean(isRelated || isSelectedEdge)
                    : Boolean(isSelectedEdge || transform.k >= 1.15);
                  return (
                    <g key={edge.id}>
                      <line
                        x1={fromX}
                        y1={fromY}
                        x2={toX}
                        y2={toY}
                        stroke={isSelectedEdge ? "#ff9800" : isRelated ? "#6aaeff" : baseStroke}
                        strokeWidth={isSelectedEdge ? 2.6 : isRelated ? 2.0 : (0.7 + depth * 1.05)}
                        markerEnd="url(#arrow-end)"
                        markerStart={bidirectional ? "url(#arrow-start)" : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                        }}
                        style={{ cursor: "pointer" }}
                      />
                      <line
                        x1={fromX}
                        y1={fromY}
                        x2={toX}
                        y2={toY}
                        stroke="transparent"
                        strokeWidth={10}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                        }}
                        style={{ cursor: "pointer" }}
                      />
                      {showEdgeLabel && (
                        <g transform={`translate(${lx},${ly}) rotate(${angle})`} style={{ pointerEvents: "none", userSelect: "none" }}>
                          <rect
                            x={-labelWidth / 2}
                            y={-8}
                            width={labelWidth}
                            height={14}
                            rx={4}
                            ry={4}
                            fill={isSelectedEdge ? "rgba(255,227,181,0.96)" : "rgba(248,251,255,0.94)"}
                            stroke={isSelectedEdge ? "rgba(217,119,6,0.58)" : "rgba(125,145,172,0.45)"}
                            strokeWidth={0.8}
                          />
                          <text
                            x={0}
                            y={2}
                            textAnchor="middle"
                            fill={isSelectedEdge ? "#b45309" : "var(--text-secondary)"}
                            fontSize={10}
                          >
                            {labelText}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {nodesForRender.map((node) => {
                  const x = Number(node.x || graphWidth / 2);
                  const y = Number(node.y || graphHeight / 2);
                  const scale = clamp(0.78 + (y / Math.max(1, graphHeight)) * 0.32, 0.68, 1.16);
                  const radius = baseNodeRadius(node) * scale * (selectedNodeId === node.id ? 1.08 : 1);
                  const dimmed = selectedNodeId && !selectedRelatedNodeSet.has(node.id);
                  const opacity = dimmed ? 0.3 : 1;
                  const cKey = colorKey(node.category);
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${x}, ${y})`}
                      onPointerDown={(e) => handleNodePointerDown(e, node.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const target = nodeById.get(node.id);
                        if (!target) return;
                        target.fx = null;
                        target.fy = null;
                        target.pinned = false;
                        pinnedNodesRef.current.delete(node.id);
                        simulationRef.current?.alpha(0.55).restart();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressNodeClickRef.current === node.id) {
                          suppressNodeClickRef.current = "";
                          return;
                        }
                        setSelectedNodeId(node.id);
                        setSelectedEdgeId("");
                      }}
                      style={{ cursor: "pointer", opacity }}
                    >
                      <ellipse cx={2.5} cy={radius * 0.9} rx={radius * 0.95} ry={Math.max(3, radius * 0.35)} fill="rgba(60,70,90,0.25)" filter="url(#node-shadow)" />
                      <circle r={radius} fill={`url(#grad-${cKey})`} stroke={selectedNodeId === node.id ? "#ffd88a" : "rgba(255,255,255,0.86)"} strokeWidth={selectedNodeId === node.id ? 2.6 : 1.6} />
                      <circle cx={-radius * 0.28} cy={-radius * 0.34} r={radius * 0.23} fill="rgba(255,255,255,0.42)" />
                      <text x={0} y={4} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={700}>
                        {node.label.slice(0, 2)}
                      </text>
                      <text x={0} y={radius + 16} textAnchor="middle" fill="var(--text-primary)" fontSize={11}>
                        {node.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {graph && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span>节点 {graph.stats.node_count}</span>
              <span>关系 {graph.stats.edge_count}</span>
              <span>孤立角色 {graph.stats.isolated_count}</span>
              <span>已固定 {pinnedCount}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Move size={12} /> 拖拽节点固定位置</span>
              <span>双击节点解除固定</span>
            </div>
          )}
        </div>

        <div style={{ border: "1px solid var(--bg-border)", borderRadius: 12, background: "var(--bg-card)", padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 560 }}>
          {!selectedNode ? (
            <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>点击图中的角色节点查看详情。</div>
          ) : (
            <>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{selectedNode.label}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 8px" }}>
                <span>分类</span><span>{selectedNode.category || "未标注"}</span>
                <span>性别</span><span>{selectedNode.gender || "未标注"}</span>
                <span>年龄</span><span>{selectedNode.age || "未标注"}</span>
                <span>关系数</span><span>{selectedNode.degree}</span>
              </div>
              {selectedNode.identity && (
                <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                  身份：{selectedNode.identity}
                </div>
              )}

              <div style={{ borderTop: "1px solid var(--bg-border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 8, minHeight: 0, overflowY: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>关联关系</div>
                {relatedEdges.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>暂无关系</div>
                ) : (
                  relatedEdges.map((edge) => {
                    const isFrom = edge.source === selectedNode.id;
                    const peer = isFrom ? edge.target_label : edge.source_label;
                    const isSelectedEdge = selectedEdge?.id === edge.id;
                    const relationArrow = edge.direction === "bidirectional" ? "↔" : isFrom ? "→" : "←";
                    return (
                      <div
                        key={edge.id}
                        onClick={() => setSelectedEdgeId(edge.id)}
                        style={{
                          border: "1px solid var(--bg-border)",
                          borderRadius: 8,
                          padding: "8px 9px",
                          background: isSelectedEdge ? "var(--accent-dim)" : "var(--bg-input)",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          gap: 5,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
                          {selectedNode.label} {relationArrow} {peer}（{edge.type}）
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                          {edge.description || "暂无描述"}
                        </div>
                        {(Number(edge.first_chapter_num || 0) > 0 || Number(edge.last_chapter_num || 0) > 0 || (edge.change_chapter_nums || []).length > 0) && (
                          <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 2 }}>
                            {Number(edge.first_chapter_num || 0) > 0 && (
                              <span>首次出现：第{edge.first_chapter_num}章{edge.first_chapter_title ? `《${edge.first_chapter_title}》` : ""}</span>
                            )}
                            {Number(edge.last_chapter_num || 0) > 0 && (
                              <span>最近出现：第{edge.last_chapter_num}章{edge.last_chapter_title ? `《${edge.last_chapter_title}》` : ""}</span>
                            )}
                            {(edge.change_chapter_nums || []).length > 0 && (
                              <span>关系变化章：{(edge.change_chapter_nums || []).map((num) => `第${num}章`).join("、")}</span>
                            )}
                          </div>
                        )}
                        {edge.raw_type && edge.raw_type !== edge.type && (
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            原始标注：{edge.raw_type}
                          </div>
                        )}
                        {edge.relation_source === "identity_inferred" && (
                          <div style={{ fontSize: 11, color: "#6d4c41" }}>
                            来源：身份推断（建议在角色关系里确认后落库）
                          </div>
                        )}
                        {edge.relation_source === "content_inferred" && (
                          <div style={{ fontSize: 11, color: "#5d4037" }}>
                            来源：正文推断（可直接用于关系图，无需手动录入）
                          </div>
                        )}
                        {isSelectedEdge && edge.evidence.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {edge.evidence.map((ev, idx) => (
                              <div key={`${edge.id}-${idx}`} style={{ fontSize: 11, color: "var(--text-secondary)", border: "1px dashed var(--bg-border)", borderRadius: 6, padding: "5px 6px", lineHeight: 1.45 }}>
                                证据 · 第{ev.chapter_num}章《{ev.chapter_title}》：{ev.snippet}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
