import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

type Theme = "apple-minimal" | "glass" | "anime" | "brutalism" | "claymorphism" | "e-ink" | "terminal" | "sci-fi";

export interface ThemeConfig {
  accentColor: string;
  bgBase: string;
  bgCard: string;
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (t: Theme) => void;
  config: ThemeConfig;
  updateConfig: (key: keyof ThemeConfig, newHex: string) => void;
  resetTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// 提取的 8 款主题核心色预设 (保留了透明度特征)
export const defaultThemeConfigs: Record<Theme, ThemeConfig> = {
  "apple-minimal": { accentColor: "#0066CC", bgBase: "#F5F5F7", bgCard: "#FFFFFF" },
  "glass": { accentColor: "#0EA5E9", bgBase: "#F0F4F8", bgCard: "rgba(255, 255, 255, 0.45)" },
  "anime": { accentColor: "#FF5F8E", bgBase: "#DFEBFB", bgCard: "rgba(255, 255, 255, 0.84)" },
  "brutalism": { accentColor: "#FF5A5F", bgBase: "#FDF9E3", bgCard: "#FFFFFF" },
  "claymorphism": { accentColor: "#FF9B8A", bgBase: "#F3F1EC", bgCard: "#FDFBFA" },
  "e-ink": { accentColor: "#5F5B54", bgBase: "#E8E5DF", bgCard: "#F4F1EC" },
  "terminal": { accentColor: "#33FF33", bgBase: "#000000", bgCard: "#050505" },
  "sci-fi": { accentColor: "#4F46E5", bgBase: "#03040B", bgCard: "rgba(10, 12, 21, 0.7)" }
};

export function parseColorToHex(colorStr: string): string {
  if (colorStr.startsWith('#')) return colorStr.substring(0, 7);
  if (colorStr.startsWith('rgba')) {
    const parts = colorStr.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return "#000000";
    const r = parseInt(parts[0]).toString(16).padStart(2, '0');
    const g = parseInt(parts[1]).toString(16).padStart(2, '0');
    const b = parseInt(parts[2]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  if (colorStr.startsWith('rgb')) {
    const parts = colorStr.match(/\d+/g);
    if (!parts || parts.length < 3) return "#000000";
    const r = parseInt(parts[0]).toString(16).padStart(2, '0');
    const g = parseInt(parts[1]).toString(16).padStart(2, '0');
    const b = parseInt(parts[2]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return "#000000";
}

function updateColorKeepAlpha(newHex: string, oldColorStr: string): string {
  if (oldColorStr.startsWith('rgba')) {
    const parts = oldColorStr.match(/[\d.]+/g);
    const alpha = (parts && parts.length >= 4) ? parts[3] : '1';
    const rgb = hexToRgb(newHex);
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  }
  return newHex;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("sanhuoai-theme") as Theme) || "anime";
  });

  const loadThemeConfig = (t: Theme): ThemeConfig => {
    const saved = localStorage.getItem(`sanhuoai-theme-config-${t}`);
    if (saved) {
      try {
        return { ...defaultThemeConfigs[t], ...JSON.parse(saved) };
      } catch (e) { }
    }
    return defaultThemeConfigs[t];
  };

  const [config, setConfigState] = useState<ThemeConfig>(() => loadThemeConfig(theme));

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("sanhuoai-theme", t);
    setConfigState(loadThemeConfig(t));
  };

  const updateConfig = (key: keyof ThemeConfig, newHex: string) => {
    setConfigState(prev => {
      // 保留原有透明度（如果之前是 rgba）
      const oldValue = prev[key];
      const finalVal = updateColorKeepAlpha(newHex, oldValue);

      const newConf = { ...prev, [key]: finalVal };



      localStorage.setItem(`sanhuoai-theme-config-${theme}`, JSON.stringify(newConf));
      return newConf;
    });
  };

  const resetTheme = () => {
    const def = defaultThemeConfigs[theme];
    setConfigState(def);
    localStorage.removeItem(`sanhuoai-theme-config-${theme}`);
  };

  // 1. 设置根 html 数据属性 (用于应用通用边框、阴影模板)
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 2. 将当前颜色的注入到 CSS 变量
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--theme-accent", config.accentColor);
    root.style.setProperty("--bg-base", config.bgBase);
    root.style.setProperty("--bg-card", config.bgCard);



    const rgb = hexToRgb(parseColorToHex(config.accentColor));
    if (rgb) {
      root.style.setProperty("--accent-dim", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    } else {
      root.style.setProperty("--accent-dim", "rgba(201, 168, 76, 0.15)");
    }
  }, [config, theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, config, updateConfig, resetTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
