import { useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useProject } from "./context/ProjectContext";
import { useTheme } from "./context/ThemeContext";
import Sidebar from "./components/Sidebar";
import Projects from "./pages/Projects";
import Workshop from "./pages/Workshop";
import Outline from "./pages/Outline";
import Characters from "./pages/Characters";
import Foreshadowing from "./pages/Foreshadowing";
import Review from "./pages/Review";
import Worldbuilding from "./pages/Worldbuilding";
import Chapters from "./pages/Chapters";
import Settings from "./pages/Settings";
import PromptSettings from "./pages/PromptSettings";
import ApiSettings from "./pages/ApiSettings";
import Appearance from "./pages/Appearance";
import PlanningStudio from "./pages/PlanningStudio";
import KnowledgeAssets from "./pages/KnowledgeAssets";
import KnowledgeRules from "./pages/KnowledgeRules";
import KnowledgeTemplates from "./pages/KnowledgeTemplates";

import ButterflyBoard from "./pages/ButterflyBoard";
import { ToastProvider } from "./components/ui/ToastProvider";

const RelationGraph = lazy(() => import("./pages/RelationGraph"));

type AnimePageKey =
  | "projects"
  | "workshop"
  | "outline"
  | "characters"
  | "foreshadowing"
  | "review"
  | "worldbuilding"
  | "chapters"
  | "settings"
  | "prompt-settings"
  | "planning-studio"
  | "knowledge-assets"
  | "knowledge-rules"
  | "knowledge-templates"
  | "relation-graph"
  | "api-settings"
  | "appearance"
  | "butterfly";

interface AnimePagePalette {
  accent: string;
  support: string;
  bgStart: string;
  bgEnd: string;
  border: string;
}

const animePagePalettes: Record<AnimePageKey, AnimePagePalette> = {
  "projects": { accent: "#8CCF57", support: "#54BDF0", bgStart: "#DFEBFB", bgEnd: "#C8DCF3", border: "#9AC3EA" },
  "workshop": { accent: "#FF5F8E", support: "#5DC2FF", bgStart: "#DEEAF8", bgEnd: "#C6D8EE", border: "#9DBCE0" },
  "outline": { accent: "#8F8CFF", support: "#66C5F4", bgStart: "#E2ECFB", bgEnd: "#CCDDF2", border: "#9FBDE4" },
  "characters": { accent: "#52C4F5", support: "#9BA4FF", bgStart: "#E1EEFC", bgEnd: "#C9DBF2", border: "#9CC2E8" },
  "foreshadowing": { accent: "#F8946D", support: "#73B9FF", bgStart: "#E4EEFB", bgEnd: "#CEDDF2", border: "#A3BFE0" },
  "review": { accent: "#7AD77E", support: "#71C6F7", bgStart: "#E0ECFA", bgEnd: "#CADCF2", border: "#99BFE6" },
  "worldbuilding": { accent: "#61A0FF", support: "#58D0C8", bgStart: "#DFEBFA", bgEnd: "#C8DBF2", border: "#98BCE4" },
  "chapters": { accent: "#53D3B8", support: "#79B8FF", bgStart: "#DFEDFA", bgEnd: "#C9DCF2", border: "#9BBDE4" },
  "settings": { accent: "#7DA0FF", support: "#7AD792", bgStart: "#E0ECFA", bgEnd: "#CADCF1", border: "#9FBEE5" },
  "prompt-settings": { accent: "#6EA6FF", support: "#70D1A4", bgStart: "#E0ECFA", bgEnd: "#CADCF1", border: "#9FBEE5" },
  "planning-studio": { accent: "#62B8FF", support: "#89D77A", bgStart: "#E1EDFA", bgEnd: "#CBDDF2", border: "#9DBFE4" },
  "knowledge-assets": { accent: "#62D0B7", support: "#79AFFF", bgStart: "#DFEDFA", bgEnd: "#CADCF2", border: "#9DBFE5" },
  "knowledge-rules": { accent: "#5FBAD6", support: "#8AB3FF", bgStart: "#DFEDFA", bgEnd: "#CADCF2", border: "#9DBFE5" },
  "knowledge-templates": { accent: "#69C6A2", support: "#74B8FF", bgStart: "#DFEDFA", bgEnd: "#CADCF2", border: "#9DBFE5" },
  "relation-graph": { accent: "#5EC0D1", support: "#7CB4FF", bgStart: "#E0ECFA", bgEnd: "#CADCF2", border: "#9FBEE5" },
  "api-settings": { accent: "#5DB5FF", support: "#8AD26E", bgStart: "#E1EDFB", bgEnd: "#CBDEF3", border: "#9DBEE6" },
  "appearance": { accent: "#88CF54", support: "#66B9FF", bgStart: "#DFECFB", bgEnd: "#C8DCF3", border: "#99BFE8" },
  "butterfly": { accent: "#A979FF", support: "#61D8A1", bgStart: "#E2ECFA", bgEnd: "#CBDCF2", border: "#A2BEE3" },
};

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    return `rgba(125, 176, 238, ${alpha})`;
  }

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveAnimePage(pathname: string): AnimePageKey {
  if (pathname.startsWith("/workshop")) return "workshop";
  if (pathname.startsWith("/outline")) return "outline";
  if (pathname.startsWith("/characters")) return "characters";
  if (pathname.startsWith("/foreshadowing")) return "foreshadowing";
  if (pathname.startsWith("/review")) return "review";
  if (pathname.startsWith("/worldbuilding")) return "worldbuilding";
  if (pathname.startsWith("/chapters")) return "chapters";
  if (pathname.startsWith("/prompt-settings")) return "prompt-settings";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/planning-studio")) return "planning-studio";
  if (pathname.startsWith("/knowledge-assets")) return "knowledge-assets";
  if (pathname.startsWith("/knowledge-rules")) return "knowledge-rules";
  if (pathname.startsWith("/knowledge-templates")) return "knowledge-templates";
  if (pathname.startsWith("/relation-graph")) return "relation-graph";
  if (pathname.startsWith("/api-settings")) return "api-settings";
  if (pathname.startsWith("/appearance")) return "appearance";
  if (pathname.startsWith("/butterfly")) return "butterfly";
  return "projects";
}

function AgentLoading() {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "var(--bg, #0f0f0f)", color: "var(--text, #e0e0e0)", zIndex: 9999,
    }}>
      <div style={{ fontSize: 32, marginBottom: 16 }}>焱书</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="agent-spinner" />
        <span>正在启动 Agent 服务...</span>
      </div>
      <style>{`
        .agent-spinner {
          width: 18px; height: 18px; border: 2px solid #555;
          border-top-color: #f59e0b; border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const { theme, config } = useTheme();
  const { agentReady } = useProject();

  useEffect(() => {
    const page = resolveAnimePage(location.pathname);
    document.body.dataset.page = page;

    const root = document.documentElement;

    if (theme !== "anime") {
      root.style.setProperty("--accent-gold", config.accentColor);
      root.style.setProperty("--accent-gold-dim", "var(--accent-dim)");
      root.style.setProperty("--accent", config.accentColor);
      root.style.setProperty("--status-active", config.accentColor);
      root.style.setProperty("--status-active-dim", "var(--accent-dim)");
      root.style.setProperty("--bg-active", "var(--accent-dim)");
      // Anime 页面会注入输入面板相关变量；离开 anime 时必须清理，避免覆盖其它主题。
      root.style.removeProperty("--bg-input");
      root.style.removeProperty("--bg-border");
      root.style.removeProperty("--anime-bg-start");
      root.style.removeProperty("--anime-bg-end");
      root.style.removeProperty("--anime-border");
      return;
    }

    const palette = animePagePalettes[page];
    root.style.setProperty("--accent-gold", palette.accent);
    root.style.setProperty("--accent-gold-dim", hexToRgba(palette.accent, 0.2));
    root.style.setProperty("--accent", palette.accent);
    root.style.setProperty("--status-active", palette.support);
    root.style.setProperty("--status-active-dim", hexToRgba(palette.support, 0.2));
    root.style.setProperty("--bg-active", hexToRgba(palette.accent, 0.14));
    root.style.setProperty("--theme-accent", palette.accent);
    root.style.setProperty("--accent-dim", hexToRgba(palette.accent, 0.18));
    root.style.setProperty("--anime-bg-start", palette.bgStart);
    root.style.setProperty("--anime-bg-end", palette.bgEnd);
    root.style.setProperty("--anime-border", hexToRgba(palette.border, 0.6));
    root.style.setProperty("--bg-base", palette.bgStart);
    root.style.setProperty("--bg-card", "rgba(255, 255, 255, 0.84)");
    root.style.setProperty("--bg-input", "rgba(255, 255, 255, 0.95)");
    root.style.setProperty("--bg-border", hexToRgba(palette.border, 0.52));
  }, [location.pathname, theme, config.accentColor]);

  if (!agentReady) return <AgentLoading />;

  return (
    <ToastProvider>
      <div className="game-shell" style={{ display: "flex", height: "100vh" }}>
        <Sidebar />
        <main className="game-main" style={{ flex: 1, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Navigate to="/projects" replace />} />
            {/* 全局页面 */}
            <Route path="/projects" element={<Projects />} />
            <Route path="/api-settings" element={<ApiSettings />} />
            <Route path="/appearance" element={<Appearance />} />
            {/* 项目级页面 */}
            <Route path="/workshop" element={<Workshop />} />
            <Route path="/outline" element={<Outline />} />
            <Route path="/characters" element={<Characters />} />
            <Route path="/foreshadowing" element={<Foreshadowing />} />
            <Route path="/review" element={<Review />} />
            <Route path="/worldbuilding" element={<Worldbuilding />} />
            <Route path="/chapters" element={<Chapters />} />
            <Route path="/planning-studio" element={<PlanningStudio />} />
            <Route path="/knowledge-assets" element={<KnowledgeAssets />} />
            <Route path="/knowledge-rules" element={<KnowledgeRules />} />
            <Route path="/knowledge-templates" element={<KnowledgeTemplates />} />
            <Route
              path="/relation-graph"
              element={(
                <Suspense fallback={<div style={{ padding: 24, color: "var(--text-secondary)" }}>关系图谱加载中...</div>}>
                  <RelationGraph />
                </Suspense>
              )}
            />

            <Route path="/butterfly" element={<ButterflyBoard />} />
            <Route path="/prompt-settings" element={<PromptSettings />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}
