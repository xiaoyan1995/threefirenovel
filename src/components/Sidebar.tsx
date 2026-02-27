import { useLocation, useNavigate } from "react-router-dom";
import {
  PenTool, BookOpen, Users, Eye, CheckCircle,
  Globe, List, Settings, Key,
  ArrowLeft, FolderOpen, GitMerge, Palette, Sparkles, WandSparkles, Database, MessageSquareText,
  PanelLeftClose, Orbit
} from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { useTheme } from "../context/ThemeContext";
import { useEffect, useState } from "react";

const projectNavItems = [
  { path: "/settings", label: "项目设置", icon: Settings },
  { path: "/prompt-settings", label: "提示词设置", icon: MessageSquareText },
  { path: "/planning-studio", label: "AI立项工作台", icon: WandSparkles },
  { path: "/knowledge-assets", label: "知识资产库", icon: Database },
  { path: "/worldbuilding", label: "世界观", icon: Globe },
  { path: "/characters", label: "角色管理", icon: Users },
  { path: "/outline", label: "故事大纲", icon: BookOpen },
  { path: "/chapters", label: "章节管理", icon: List },
  { path: "/workshop", label: "写作工坊", icon: PenTool },
  { path: "/butterfly", label: "蝴蝶效应推演", icon: GitMerge },
  { path: "/relation-graph", label: "关系图谱", icon: Orbit },
  { path: "/foreshadowing", label: "伏笔追踪", icon: Eye },
  { path: "/review", label: "审核中心", icon: CheckCircle },
];

const globalNavItems = [
  { path: "/projects", label: "项目列表", icon: FolderOpen },
  { path: "/appearance", label: "外观设置", icon: Palette },
  { path: "/api-settings", label: "API 设置", icon: Key },
];

const globalPaths = ["/projects", "/api-settings", "/appearance"];

const themeNames: Record<string, string> = {
  "apple-minimal": "果味极简",
  "glass": "毛玻璃",
  "anime": "二次元手游",
  "brutalism": "新粗野主义",
  "claymorphism": "黏土风",
  "e-ink": "电纸书",
  "terminal": "黑客终端",
  "sci-fi": "科幻深空"
};

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentProject } = useProject();
  const { theme } = useTheme();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sidebar.collapsed") === "1";
  });

  const isGlobal = globalPaths.includes(location.pathname);
  const navItems = isGlobal ? globalNavItems : projectNavItems;
  const sidebarWidth = collapsed ? 88 : 260;

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("sidebar.collapsed", collapsed ? "1" : "0");
    }
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    }
  }, [collapsed, sidebarWidth]);

  return (
    <aside className="game-sidebar" style={{
      width: sidebarWidth, height: "100vh", display: "flex", flexDirection: "column",
      justifyContent: "space-between", padding: collapsed ? "20px 12px" : "24px 20px",
      background: "var(--bg-card)", borderRight: "var(--border-width) var(--border-style) var(--bg-border)",
      transition: "background 0.5s ease-out, border 0.5s ease-out"
    }}>
      <div className="game-sidebar__top" style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {/* Logo */}
        <div className="game-sidebar__brand" style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px", justifyContent: collapsed ? "center" : "space-between" }}>
          {collapsed ? (
            <button
              className="game-sidebar__brand-icon"
              onClick={() => setCollapsed(false)}
              title="展开导航栏"
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                background: "var(--accent-gold)",
                boxShadow: "0 2px 10px var(--accent-gold-dim)",
                border: "1px solid var(--bg-border)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Sparkles size={14} />
            </button>
          ) : (
            <span className="game-sidebar__brand-icon" style={{
              width: 28, height: 28, borderRadius: "50%", display: "inline-flex",
              alignItems: "center", justifyContent: "center", color: "#fff",
              background: "var(--accent-gold)", boxShadow: "0 2px 10px var(--accent-gold-dim)"
            }}>
              <Sparkles size={14} />
            </span>
          )}
          {!collapsed && (
            <span className="game-sidebar__brand-text" style={{
              display: "flex", flexDirection: "column", gap: 0, lineHeight: 1.1, flex: 1,
            }}>
              <span style={{
                fontFamily: "var(--font-base)", fontWeight: 700, fontSize: 18,
                color: "var(--text-primary)"
              }}>焱书</span>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: 0.6 }}>
                YANDRAFT
              </span>
            </span>
          )}
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-card)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              title="收缩导航栏"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
        </div>

        {/* 项目内模式：返回按钮 */}
        {!isGlobal && (
          <button className="game-back-button" onClick={() => navigate("/projects")} style={{
            display: "flex", alignItems: "center", gap: 8, justifyContent: collapsed ? "center" : "flex-start",
            padding: "8px 12px", borderRadius: 8, border: "1px solid var(--bg-border)",
            cursor: "pointer", background: "transparent",
            fontSize: 13, color: "var(--text-secondary)", width: "100%", textAlign: "left",
          }} title="返回项目列表">
            <ArrowLeft size={14} />
            {!collapsed && <span>返回项目列表</span>}
          </button>
        )}

        {/* 导航列表 */}
        <nav className="game-sidebar__nav" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = location.pathname === path;
            return (
              <button key={path} className={`game-nav-button ${active ? "is-active" : ""}`} onClick={() => navigate(path)} style={{
                display: "flex", alignItems: "center", gap: collapsed ? 0 : 12, justifyContent: collapsed ? "center" : "flex-start",
                padding: collapsed ? "10px 0" : "10px 12px", borderRadius: 8, border: "none",
                cursor: "pointer", width: "100%", textAlign: "left",
                fontFamily: "var(--font-base)", fontSize: 14, fontWeight: active ? 600 : 400,
                background: active ? "var(--accent-dim)" : "transparent",
                color: active ? "var(--accent-gold)" : "var(--text-secondary)",
                boxShadow: "none"
              }} title={label}>
                <Icon size={18} />
                {!collapsed && label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* 底部区域 */}
      <div className="game-sidebar__bottom" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* 项目内模式：显示当前项目名 */}
        {!isGlobal && (
          <div className="mc-panel game-project-chip" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
            {!collapsed ? (
              <>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>当前项目</div>
                <div style={{ fontSize: 13, fontWeight: "bold" }}>{currentProject?.name || "未选择项目"}</div>
              </>
            ) : (
              <div title={currentProject?.name || "未选择项目"} style={{ fontSize: 12, fontWeight: "bold", textAlign: "center" }}>
                {(currentProject?.name || "未").slice(0, 2)}
              </div>
            )}
          </div>
        )}

        {/* 简易主题入口 (点击跳转外观页) */}
        {isGlobal && (
          <button
            onClick={() => navigate("/appearance")}
            className="mc-panel game-theme-pill"
            style={{
              padding: collapsed ? "10px 8px" : "12px 16px", display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "space-between",
              cursor: "pointer", border: "var(--border-width) var(--border-style) var(--bg-border)", background: "var(--bg-card)",
              color: "var(--text-primary)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-sm)"
            }}
            title={`当前交互范式：${themeNames[theme]}`}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Palette size={16} color="var(--accent-gold)" />
              {!collapsed && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>当前交互范式</span>
                  <span style={{ fontSize: 13, fontWeight: "bold" }}>{themeNames[theme]}</span>
                </div>
              )}
            </div>
            {!collapsed && (
              <div
                style={{
                  width: 14, height: 14, borderRadius: "50%", background: "var(--accent-gold)",
                  boxShadow: "0 0 8px var(--accent-dim)"
                }}
              />
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
