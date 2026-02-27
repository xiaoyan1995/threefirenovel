import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

export type ChapterEditorHighlightKind = "ai_trace" | "conflict" | "overlap";

export interface ChapterEditorHighlightRange {
  start: number;
  end: number;
  kind: ChapterEditorHighlightKind;
  tooltip?: string;
}

export interface ChapterRichEditorSelection {
  start: number;
  end: number;
  text: string;
}

export interface ChapterRichEditorRef {
  focus: () => void;
  setSelection: (start: number, end: number, options?: { scrollIntoView?: boolean }) => void;
  getSelection: () => ChapterRichEditorSelection;
}

interface ChapterRichEditorProps {
  value: string;
  onChange: (nextValue: string) => void;
  onSelectionChange?: (selection: ChapterRichEditorSelection) => void;
  placeholderText?: string;
  highlights?: ChapterEditorHighlightRange[];
  readOnly?: boolean;
}

const setHighlightsEffect = StateEffect.define<ChapterEditorHighlightRange[]>();

const createDecorationForKind = (kind: ChapterEditorHighlightKind, tooltip?: string) => {
  const attributes = tooltip ? { title: tooltip } : undefined;
  if (kind === "conflict") return Decoration.mark({ class: "cm-conflict-hit", attributes });
  if (kind === "overlap") return Decoration.mark({ class: "cm-overlap-hit", attributes });
  return Decoration.mark({ class: "cm-ai-trace-hit", attributes });
};

const buildHighlightDecorations = (
  docLength: number,
  ranges: ChapterEditorHighlightRange[],
): DecorationSet => {
  if (!ranges || ranges.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const raw of ranges) {
    const start = Math.max(0, Math.min(Number(raw.start) || 0, docLength));
    const end = Math.max(start, Math.min(Number(raw.end) || 0, docLength));
    if (end <= start) continue;
    builder.add(start, end, createDecorationForKind(raw.kind, raw.tooltip));
  }
  return builder.finish();
};

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(highlights, tr) {
    let next = highlights.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlightsEffect)) {
        next = buildHighlightDecorations(tr.state.doc.length, effect.value);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      background: "transparent",
      color: "var(--text-primary)",
      fontFamily: "inherit",
      fontSize: "15px",
      lineHeight: "2",
    },
    ".cm-scroller": {
      overflowY: "auto",
      overflowX: "hidden",
      fontFamily: "inherit",
      lineHeight: "2",
      padding: 0,
      scrollbarWidth: "none",
      scrollbarColor: "transparent transparent",
    },
    ".cm-content": {
      padding: "0 8px",
      minHeight: "100%",
      caretColor: "var(--text-primary)",
    },
    ".cm-line": {
      padding: 0,
    },
    ".cm-gutters": {
      display: "none",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-selectionBackground": {
      backgroundColor: "var(--accent-gold-dim) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--accent-gold-dim) !important",
    },
    "::selection": {
      backgroundColor: "var(--accent-gold-dim)",
    },
  },
  { dark: false },
);

const highlightTheme = EditorView.baseTheme({
  ".cm-ai-trace-hit": {
    backgroundColor: "rgba(255, 193, 7, 0.24)",
    borderRadius: "3px",
  },
  ".cm-conflict-hit": {
    backgroundColor: "rgba(244, 67, 54, 0.22)",
    borderRadius: "3px",
  },
  ".cm-overlap-hit": {
    backgroundColor: "rgba(156, 39, 176, 0.24)",
    borderRadius: "3px",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "0px",
    height: "0px",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    backgroundColor: "transparent",
    borderRadius: "999px",
    border: "2px solid transparent",
    backgroundClip: "content-box",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    backgroundColor: "transparent",
  },
});

export const ChapterRichEditor = forwardRef<ChapterRichEditorRef, ChapterRichEditorProps>(
  function ChapterRichEditor(
    {
      value,
      onChange,
      onSelectionChange,
      placeholderText = "开始创作...",
      highlights = [],
      readOnly = false,
    },
    ref,
  ) {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const editableCompartmentRef = useRef(new Compartment());
    const placeholderCompartmentRef = useRef(new Compartment());
    const normalizedHighlights = useMemo(
      () => (Array.isArray(highlights) ? highlights : []),
      [highlights],
    );

    onChangeRef.current = onChange;
    onSelectionChangeRef.current = onSelectionChange;

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          viewRef.current?.focus();
        },
        setSelection(start, end, options) {
          const view = viewRef.current;
          if (!view) return;
          const from = Math.max(0, Math.min(start, view.state.doc.length));
          const to = Math.max(from, Math.min(end, view.state.doc.length));
          const effects = options?.scrollIntoView
            ? [EditorView.scrollIntoView(from, { y: "center" })]
            : [];
          view.dispatch({
            selection: { anchor: from, head: to },
            effects,
          });
          view.focus();
        },
        getSelection() {
          const view = viewRef.current;
          if (!view) return { start: 0, end: 0, text: "" };
          const sel = view.state.selection.main;
          const start = Math.max(0, Math.min(sel.from, view.state.doc.length));
          const end = Math.max(start, Math.min(sel.to, view.state.doc.length));
          return {
            start,
            end,
            text: view.state.sliceDoc(start, end),
          };
        },
      }),
      [],
    );

    useEffect(() => {
      if (!mountRef.current || viewRef.current) return;

      const state = EditorState.create({
        doc: value || "",
        extensions: [
          history(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editableCompartmentRef.current.of(EditorView.editable.of(!readOnly)),
          placeholderCompartmentRef.current.of(placeholder(placeholderText)),
          highlightField,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const sel = update.state.selection.main;
              onSelectionChangeRef.current?.({
                start: sel.from,
                end: sel.to,
                text: update.state.sliceDoc(sel.from, sel.to),
              });
            }
          }),
          EditorView.domEventHandlers({
            dragstart(event, view) {
              const sel = view.state.selection.main;
              const selected = view.state.sliceDoc(sel.from, sel.to);
              const text = String(selected || "").trim();
              if (!text) {
                event.preventDefault();
                return false;
              }
              event.dataTransfer?.setData("text/plain", text);
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "copy";
              }
              return false;
            },
          }),
          editorTheme,
          highlightTheme,
        ],
      });

      const view = new EditorView({
        state,
        parent: mountRef.current,
      });
      viewRef.current = view;
      view.dispatch({ effects: setHighlightsEffect.of(normalizedHighlights) });

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (value === current) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value || "" },
      });
    }, [value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: setHighlightsEffect.of(normalizedHighlights),
      });
    }, [normalizedHighlights]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!readOnly)),
      });
    }, [readOnly]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: placeholderCompartmentRef.current.reconfigure(placeholder(placeholderText)),
      });
    }, [placeholderText]);

    return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
  },
);
