import { useTheme, parseColorToHex } from "../context/ThemeContext";

const themeNames: Record<string, string> = {
    "apple-minimal": "果味极简 (Apple Minimal)",
    "glass": "高级毛玻璃 (Glassmorphism)",
    "anime": "二次元手游 (Gacha UI)",
    "brutalism": "新粗野主义 (Brutalism)",
    "claymorphism": "微缩黏土风 (Claymorphism)",
    "e-ink": "护眼电纸书 (E-Ink)",
    "terminal": "黑客终端机 (Terminal)",
    "sci-fi": "科幻深空域 (Sci-Fi Void)"
};

const themeDesc: Record<string, string> = {
    "apple-minimal": "极简无边框设计，大圆角与极淡的高斯弥散阴影，仿佛置身于原生系统应用。",
    "glass": "深度环境光遮蔽与高斯模糊，容器层充满晶莹剔透的角度折射感。",
    "anime": "绝对高还原度的硬核科幻二游面板！硬朗的机甲斜切角 (Mech Cut)、玻璃高光扫描斜纹背景，再搭配带有荧光色呼吸发光线的穿透式悬浮晶莹面板。",
    "brutalism": "极度硬派的 2.5px 粗旷黑框，零圆角与高对比度，呈现街头海报般的冲击力。",
    "claymorphism": "多层柔软的浅色内发光搭配超大圆角，宛如黏土捏出的物理界面。",
    "e-ink": "绝对剥离不必要色彩的米灰色纸张基底，全局强制衬线字体，最适合纯粹的长文本打字。",
    "terminal": "纯黑底色与细绿边框，全局覆盖等宽黑客字体(Monospace)，带你回到 1999。",
    "sci-fi": "极其内敛的深邃暗蓝星空，依靠微弱的全息投影光构建冷静的前沿沉浸感。"
};

export default function Appearance() {
    const { theme, setTheme, config, updateConfig, resetTheme } = useTheme();

    return (
        <div style={{ padding: "40px 60px", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 32 }}>
            <div>
                <h1 style={{ fontSize: 28, fontWeight: "bold", marginBottom: 8, color: "var(--text-primary)" }}>外观与个性化配置</h1>
                <p style={{ color: "var(--text-secondary)", fontSize: 15 }}>
                    由于不同的长篇写作场景需要截然不同的视觉情绪，本系统提供 8 套不同物理交互手感（不仅是颜色，也包含边界厚度、阴影甚至字体）的视觉引擎。
                </p>
            </div>

            {/* 主题选择引擎 */}
            <section className="mc-panel" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
                <h2 style={{ fontSize: 16, fontWeight: "bold", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>✨</span> 核心视觉范式引擎
                </h2>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    {(Object.keys(themeNames) as Array<keyof typeof themeNames>).map((t) => {
                        const active = theme === t;
                        return (
                            <div
                                key={t}
                                onClick={() => setTheme(t as any)}
                                style={{
                                    padding: "16px", cursor: "pointer",
                                    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8,
                                    textAlign: "left", borderRadius: "var(--radius-md)",
                                    background: active ? "var(--bg-card)" : "transparent",
                                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                                    border: active ? "2px solid var(--theme-accent)" : "2px solid transparent",
                                    boxShadow: active ? "var(--shadow-md)" : "none",
                                    transition: "all 0.3s ease"
                                }}
                                role="button"
                                tabIndex={0}
                            >
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                                    <span style={{ fontSize: 15, fontWeight: "600", color: active ? "var(--theme-accent)" : "inherit" }}>
                                        {themeNames[t]}
                                    </span>
                                    {active && <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--theme-accent)", boxShadow: "0 0 6px var(--accent-dim)" }} />}
                                </div>
                                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                                    {themeDesc[t]}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            {/* 色彩参数级定制 */}
            <section className="mc-panel" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ fontSize: 16, fontWeight: "bold", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 18 }}>🎨</span> 参数级色彩熔炉
                    </h2>
                    <button
                        onClick={resetTheme}
                        style={{
                            padding: "6px 14px", fontSize: 12, background: "transparent",
                            color: "var(--text-secondary)", border: "1px dashed var(--bg-border)",
                            borderRadius: 6, cursor: "pointer", boxShadow: "none"
                        }}>
                        ↺ 还原当前范式至默认值
                    </button>
                </div>

                <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    你可以自由覆盖当前引擎 <b>{themeNames[theme]}</b> 的底层色调。算法会自动混合继承对应范式的 Alpha 透明滤镜。
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, border: "1px solid var(--bg-border)", padding: 16, borderRadius: "var(--radius-sm)" }}>
                        <div style={{ fontWeight: "600", fontSize: 14 }}>强调色 (Accent Color)</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>影响按钮高亮、选中框、焦点面板的光影追踪。</div>
                        <input
                            type="color"
                            value={parseColorToHex(config.accentColor)}
                            onChange={(e) => updateConfig('accentColor', e.target.value)}
                            style={{ width: "100%", height: 36, padding: 0, border: "none", cursor: "pointer", background: "transparent" }}
                        />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12, border: "1px solid var(--bg-border)", padding: 16, borderRadius: "var(--radius-sm)" }}>
                        <div style={{ fontWeight: "600", fontSize: 14 }}>全景底色 (Base Color)</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>网页全景幕布的底层纸张色彩。二游风自带发光高亮网格背景，配合蓝底极其惊艳。</div>
                        <input
                            type="color"
                            value={parseColorToHex(config.bgBase)}
                            onChange={(e) => updateConfig('bgBase', e.target.value)}
                            style={{ width: "100%", height: 36, padding: 0, border: "none", cursor: "pointer", background: "transparent" }}
                        />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12, border: "1px solid var(--bg-border)", padding: 16, borderRadius: "var(--radius-sm)" }}>
                        <div style={{ fontWeight: "600", fontSize: 14 }}>容器面板色 (Card Color)</div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>浮动于全景底板上方的内容卡片层。毛玻璃下带有高级折射。</div>
                        <input
                            type="color"
                            value={parseColorToHex(config.bgCard)}
                            onChange={(e) => updateConfig('bgCard', e.target.value)}
                            style={{ width: "100%", height: 36, padding: 0, border: "none", cursor: "pointer", background: "transparent" }}
                        />
                    </div>
                </div>
            </section>

        </div>
    );
}
