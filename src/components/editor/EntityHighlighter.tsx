import React, { useState } from "react";
import type { NEREntity } from "../../types";

export function EntityHighlighter({ content, entities }: { content: string, entities: NEREntity[] }) {
    const [hoveredEntity, setHoveredEntity] = useState<NEREntity | null>(null);

    // Function to escape regex special characters
    const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Find all unique names from entities to highlight
    // Sort them by length descending so longer names are matched first
    const names = Array.from(new Set(entities.map(e => e.name))).sort((a, b) => b.length - a.length);

    let elements: React.ReactNode[] = [content];

    if (names.length > 0) {
        const regex = new RegExp(`(${names.map(escapeRegExp).join('|')})`, 'g');

        // Split text by the matched names but keep the names in the array
        const parts = content.split(regex);

        elements = parts.map((part, index) => {
            // Check if this part is an entity name
            const ent = entities.find(e => e.name === part);
            if (ent) {
                return (
                    <span
                        key={index}
                        onMouseEnter={() => setHoveredEntity(ent)}
                        onMouseLeave={() => setHoveredEntity(null)}
                        style={{
                            textDecoration: "underline",
                            textDecorationStyle: "dashed",
                            textDecorationColor: ent.is_known ? "var(--accent-gold)" : "var(--status-active)",
                            color: ent.is_known ? "var(--accent-gold)" : "var(--status-active)",
                            cursor: "help",
                            position: "relative"
                        }}
                    >
                        {part}
                        {/* Tooltip rendering */}
                        {hoveredEntity === ent && (
                            <span style={{
                                position: "absolute",
                                bottom: "100%",
                                left: "50%",
                                transform: "translateX(-50%)",
                                marginBottom: 8,
                                padding: "8px 12px",
                                backgroundColor: "var(--bg-card)",
                                border: "1px solid var(--accent-gold-dim)",
                                borderRadius: 8,
                                color: "var(--text-primary)",
                                fontSize: 12,
                                whiteSpace: "pre-wrap",
                                width: "max-content",
                                maxWidth: 250,
                                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                                zIndex: 50,
                                textAlign: "left"
                            }}>
                                <div style={{ fontWeight: 600, color: ent.is_known ? "var(--accent-gold)" : "var(--status-active)", marginBottom: 4 }}>
                                    {ent.name} <span style={{ fontSize: 10, opacity: 0.6 }}>[{ent.category}] {ent.is_known ? '(已有设定)' : '(潜在新设定)'}</span>
                                </div>
                                <div style={{ lineHeight: 1.4 }}>{ent.description || "无描述"}</div>
                            </span>
                        )}
                    </span>
                );
            }
            return <span key={index}>{part}</span>;
        });
    }

    return (
        <div style={{
            color: "var(--text-primary)",
            fontSize: 15,
            lineHeight: 2,
            fontFamily: "inherit",
            whiteSpace: "pre-wrap"
        }}>
            {elements}
        </div>
    );
}
