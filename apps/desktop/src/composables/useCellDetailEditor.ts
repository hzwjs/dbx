import { shallowRef, onBeforeUnmount, type ShallowRef, createApp } from "vue";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  highlightActiveLine,
} from "@codemirror/view";
import { vscodeSelectionLayer } from "@/lib/codemirrorVscodeSelectionLayer";
import { json } from "@codemirror/lang-json";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { loadEditorTheme, editorFontTheme } from "@/lib/editorThemes";
import { shortcutToCodeMirrorKey } from "@/lib/shortcutRegistry";
import { useSettingsStore } from "@/stores/settingsStore";
import { isJsonColumnType } from "@/lib/cellDetailPresentation";
import i18n from "@/i18n";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import type { EditorTheme } from "@/stores/settingsStore";
import type { AppThemeAppearance } from "@/lib/appTheme";

export interface UseCellDetailEditorOptions {
  onChange?: (value: string) => void;
  onEscape?: () => void;
  onBlur?: () => void;
  readOnly?: boolean;
  editorTheme: () => EditorTheme;
  appAppearance: () => AppThemeAppearance;
  fontSize: () => number;
  fontFamily: () => string;
}

export interface UseCellDetailEditorReturn {
  create: (parent: HTMLElement, initialValue: string, columnType?: string) => Promise<void>;
  setValue: (value: string, columnType?: string) => void;
  getValue: () => string;
  openSearch: () => boolean;
  openReplace: () => boolean;
  destroy: () => void;
  view: Readonly<ShallowRef<EditorView | null>>;
}

function looksLikeJsonString(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function shouldUseJsonMode(columnType?: string, value?: string): boolean {
  if (isJsonColumnType(columnType)) return true;
  if (value && looksLikeJsonString(value)) return true;
  return false;
}

export function useCellDetailEditor(options: UseCellDetailEditorOptions): UseCellDetailEditorReturn {
  const view = shallowRef<EditorView | null>(null) as ShallowRef<EditorView | null>;
  const languageComp = new Compartment();
  const themeComp = new Compartment();
  const fontThemeComp = new Compartment();

  let destroyed = false;
  let currentIsJson = false;
  let searchApp: ReturnType<typeof createApp> | null = null;
  let searchInstance: InstanceType<typeof EditorSearchPanel> | null = null;
  let wrapperEl: HTMLDivElement | null = null;

  async function create(parent: HTMLElement, initialValue: string, columnType?: string): Promise<void> {
    if (destroyed) return;

    const doc = initialValue ?? "";
    currentIsJson = shouldUseJsonMode(columnType, doc);

    const theme = await loadEditorTheme(options.editorTheme(), options.appAppearance());
    const fontTheme = editorFontTheme(EditorView, options.fontSize(), options.fontFamily(), { scrollable: false });
    const shortcuts = useSettingsStore().editorSettings.shortcuts;

    const state = EditorState.create({
      doc,
      extensions: [
        // Minimal setup without line numbers
        highlightSpecialChars(),
        history(),
        drawSelection(),
        vscodeSelectionLayer(),
        dropCursor(),
        highlightActiveLine(),
        EditorView.theme({
          ".cm-activeLine": {
            backgroundColor: "color-mix(in oklch, var(--foreground) 4%, transparent)",
          },
        }),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: shortcutToCodeMirrorKey(shortcuts.find),
            preventDefault: true,
            run: () => openSearch(),
          },
          {
            key: shortcutToCodeMirrorKey(shortcuts.replace),
            preventDefault: true,
            run: () => openReplace(),
          },
        ]),
        EditorView.lineWrapping,
        languageComp.of(currentIsJson ? json() : []),
        themeComp.of(theme),
        fontThemeComp.of(fontTheme),
        keymap.of([
          {
            key: "Escape",
            run: () => {
              if (searchInstance && (searchInstance as any).closeSearch()) return true;
              options.onEscape?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            options.onChange?.(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            options.onBlur?.();
          },
        }),
        EditorState.readOnly.of(!!options.readOnly),
        EditorView.editable.of(!options.readOnly),
      ],
    });

    wrapperEl = document.createElement("div");
    wrapperEl.style.cssText = "position: relative; width: 100%; height: 100%;";
    parent.appendChild(wrapperEl);

    view.value = new EditorView({ state, parent: wrapperEl });

    // Mount search panel component
    const searchMount = document.createElement("div");
    wrapperEl.appendChild(searchMount);
    searchApp = createApp(EditorSearchPanel, { view: view.value });
    searchApp.use(i18n);
    searchInstance = searchApp.mount(searchMount) as any;
  }

  function setValue(value: string, columnType?: string) {
    const editor = view.value;
    if (!editor || destroyed) return;

    const text = value ?? "";
    const newIsJson = shouldUseJsonMode(columnType, text);
    const effects: ReturnType<typeof Compartment.prototype.reconfigure>[] = [];

    if (newIsJson !== currentIsJson) {
      effects.push(languageComp.reconfigure(newIsJson ? json() : []));
      currentIsJson = newIsJson;
    }

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      effects,
    });
  }

  function getValue(): string {
    return view.value?.state.doc.toString() ?? "";
  }

  function openSearch(): boolean {
    return (searchInstance as any)?.openSearch?.() ?? false;
  }

  function openReplace(): boolean {
    return (searchInstance as any)?.openReplace?.() ?? false;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    searchApp?.unmount();
    searchApp = null;
    searchInstance = null;
    view.value?.destroy();
    view.value = null;
    if (wrapperEl?.parentNode) {
      wrapperEl.parentNode.removeChild(wrapperEl);
    }
    wrapperEl = null;
  }

  onBeforeUnmount(() => {
    destroy();
  });

  return { create, setValue, getValue, openSearch, openReplace, destroy, view };
}
