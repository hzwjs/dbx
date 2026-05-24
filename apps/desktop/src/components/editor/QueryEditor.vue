<script setup lang="ts">
import { ref, nextTick, onMounted, onBeforeUnmount, watch, shallowRef, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  search as cmSearch,
} from "@codemirror/search";
import { ChevronUp, ChevronDown, ChevronRight, X } from "lucide-vue-next";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import {
  buildSqlCompletionItemsFromContext,
  getSqlFunctionSignatureHelp,
  getSqlCompletionContext,
  getSqlCompletionResultValidFor,
  shouldAutoOpenSqlCompletion,
  extractCteDefinitions,
} from "@/lib/sqlCompletion";
import { extractIdentifierAt, isSqlKeyword, matchTable } from "@/lib/sqlNavigation";
import { lineColumnToOffset, parseSqlErrorLocation } from "@/lib/sqlDiagnostics";
import {
  EDITOR_FONT_FAMILY_CSS_VAR,
  EDITOR_FONT_SIZE_CSS_VAR,
  loadEditorTheme,
  editorFontTheme,
  sqlCompletionTheme,
} from "@/lib/editorThemes";
import {
  clampEditorFontSize,
  createEditorZoomCommitScheduler,
  fontSizeFromGestureScale,
  fontSizeFromWheelDelta,
} from "@/lib/editorZoom";
import { shortcutToCodeMirrorKey } from "@/lib/shortcutRegistry";
import * as api from "@/lib/api";
import {
  areSqlSemanticDiagnosticsEqual,
  buildSqlParserErrorDiagnostic,
  buildSqlSemanticDiagnostics,
  shouldRunSqlSemanticDiagnostics,
  type SqlSemanticDiagnostic,
} from "@/lib/sqlSemanticDiagnostics";
import type { SqlCompletionColumn } from "@/lib/sqlCompletion";
import type { SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  database?: string;
  dialect?: "mysql" | "postgres" | "sqlserver";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  executionError?: string;
  readOnly?: boolean;
  forceWordWrap?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  formatError: [message: string];
  execute: [sql: string];
  save: [];
  clickTable: [tableName: string];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const { isDark } = useTheme();
const { t } = useI18n();

const SQL_FUNCTION_NAMES = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
  "STRING_AGG",
  "CONCAT",
  "CONCAT_WS",
  "SUBSTRING",
  "REPLACE",
  "TRIM",
  "UPPER",
  "LOWER",
  "LENGTH",
  "REGEXP_REPLACE",
  "DATE_FORMAT",
  "DATEDIFF",
  "DATE_ADD",
  "DATE_SUB",
  "EXTRACT",
  "NOW",
  "ROUND",
  "FLOOR",
  "CEIL",
  "ABS",
  "MOD",
  "COALESCE",
  "IFNULL",
  "NULLIF",
  "CAST",
  "JSON_EXTRACT",
  "JSON_VALUE",
  "JSON_OBJECT",
  "JSON_ARRAY",
] as const;

const completionTranslations = computed(() => ({
  nullValue: t("editor.completion.nullValue"),
  isNull: t("editor.completion.isNull"),
  isNotNull: t("editor.completion.isNotNull"),
  stringLiteral: t("editor.completion.stringLiteral"),
  numericLiteral: t("editor.completion.numericLiteral"),
  booleanValue: t("editor.completion.booleanValue"),
  starExpansionColumns: t("editor.completion.starExpansionColumns"),
  functionDescriptions: Object.fromEntries(
    SQL_FUNCTION_NAMES.map((name) => [name, t(`editor.completion.functionDescriptions.${name}`)]),
  ) as Record<string, string>,
}));
const MAX_COMPLETION_TABLES = 200;
const liveFontSize = ref(settingsStore.editorSettings.fontSize);
const gestureStartFontSize = ref(settingsStore.editorSettings.fontSize);
const isGestureZooming = ref(false);

const searchVisible = ref(false);
const searchText = ref("");
const replaceText = ref("");
const showReplace = ref(false);
const caseSensitive = ref(false);
const useRegex = ref(false);
const matchCount = ref(0);
const currentMatchIndex = ref(0);
const searchInputRef = ref<HTMLInputElement>();

interface EditorGestureEvent extends Event {
  scale?: number;
}

let editorViewModule: typeof import("@codemirror/view") | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;
let runKeymapComp: import("@codemirror/state").Compartment | null = null;
let diagnosticComp: import("@codemirror/state").Compartment | null = null;
let buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlSignatureExtension: (() => import("@codemirror/state").Extension) | null = null;
let codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
let codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null = null;
let setSqlDiagnosticsEffect: import("@codemirror/state").StateEffectType<SqlSemanticDiagnostic[]> | null = null;
let semanticDiagnostics: SqlSemanticDiagnostic[] = [];
let semanticDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
let semanticDiagnosticRunId = 0;

function editorThemeAppearance() {
  return isDark.value ? "dark" : "light";
}

// Completion cache
let cachedTables: Array<{ name: string; schema?: string; type?: "table" | "view" }> = [];
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();

const zoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
  if (settingsStore.editorSettings.fontSize === fontSize) return;
  settingsStore.updateEditorSettings({ fontSize });
});

function syncEditorFontCssVars(fontSize = liveFontSize.value, fontFamily = settingsStore.editorSettings.fontFamily) {
  if (!editorRef.value) return;
  editorRef.value.style.setProperty(EDITOR_FONT_SIZE_CSS_VAR, `${clampEditorFontSize(fontSize)}px`);
  editorRef.value.style.setProperty(EDITOR_FONT_FAMILY_CSS_VAR, fontFamily);
  const cm = editorRef.value.querySelector(".cm-editor") as HTMLElement | null;
  if (cm) cm.style.lineHeight = "1.6";
}

let pendingFontReconfig: { size: number; family: string } | null = null;
let fontReconfigScheduled = false;

function reconfigureFontTheme(size: number, family: string) {
  if (!fontThemeComp || !editorViewModule || !view.value) return;
  view.value.dispatch({
    effects: fontThemeComp.reconfigure(
      editorFontTheme(editorViewModule.EditorView, size, family, {
        fixedHeight: true,
        scrollable: true,
      }),
    ),
  });
}

function scheduleFontThemeReconfig(size: number, family: string) {
  pendingFontReconfig = { size, family };
  if (fontReconfigScheduled) return;
  fontReconfigScheduled = true;
  requestAnimationFrame(() => {
    fontReconfigScheduled = false;
    const p = pendingFontReconfig;
    if (p) {
      pendingFontReconfig = null;
      reconfigureFontTheme(p.size, p.family);
    }
  });
}

function applyLiveFontSize(size: number) {
  const next = clampEditorFontSize(size);
  if (liveFontSize.value === next) return;
  liveFontSize.value = next;
  syncEditorFontCssVars(next);
  // Throttle compartment reconfiguration to at most once per animation
  // frame so that CSS variable changes remain smooth on every wheel tick,
  // while the CodeMirror measure → syncGutters path keeps gutters aligned.
  scheduleFontThemeReconfig(next, settingsStore.editorSettings.fontFamily);
}

function commitFontSize(size: number) {
  const next = clampEditorFontSize(size);
  applyLiveFontSize(next);
  if (settingsStore.editorSettings.fontSize === next) return;
  settingsStore.updateEditorSettings({ fontSize: next });
}

function scheduleFontSizeCommit(size: number) {
  zoomCommitScheduler.schedule(size);
}

function zoomIn() {
  commitFontSize(liveFontSize.value + 1);
}

function zoomOut() {
  commitFontSize(liveFontSize.value - 1);
}

function resetZoom() {
  commitFontSize(13);
}

function onEditorGestureStart(event: EditorGestureEvent) {
  event.preventDefault();
  isGestureZooming.value = true;
  gestureStartFontSize.value = liveFontSize.value;
}

function onEditorGestureChange(event: EditorGestureEvent) {
  if (typeof event.scale !== "number") return;
  event.preventDefault();
  applyLiveFontSize(fontSizeFromGestureScale(gestureStartFontSize.value, event.scale));
}

function onEditorGestureEnd(event: Event) {
  event.preventDefault();
  isGestureZooming.value = false;
  zoomCommitScheduler.flush(liveFontSize.value);
}

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = settingsStore.editorSettings.shortcuts;
  return codeMirrorKeymap.of([
    {
      key: "Mod-=",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod-+",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod--",
      run: () => {
        zoomOut();
        return true;
      },
    },
    {
      key: "Mod-0",
      run: () => {
        resetZoom();
        return true;
      },
    },
    {
      key: shortcutToCodeMirrorKey(shortcuts.executeSql),
      preventDefault: true,
      run: () => {
        if (view.value) emit("execute", executableSqlFromView(view.value));
        return true;
      },
    },
    {
      key: shortcutToCodeMirrorKey(shortcuts.saveSql),
      preventDefault: true,
      run: () => {
        emit("save");
        return true;
      },
    },
  ]);
}

function wordWrapExtension() {
  if (!editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? editorViewModule.EditorView.lineWrapping : [];
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function executableSqlFromView(currentView: EditorViewType): string {
  return resolveExecutableSql(currentView.state.doc.toString(), selectedSqlFromView(currentView));
}

function identifierRangeAt(sql: string, pos: number): { from: number; to: number; text: string } | null {
  const isIdentifierChar = (ch: string | undefined) => !!ch && /[\w$.]/.test(ch);
  if (!isIdentifierChar(sql[pos]) && !isIdentifierChar(sql[pos - 1])) return null;

  let from = pos;
  while (from > 0 && isIdentifierChar(sql[from - 1])) from--;
  let to = pos;
  while (to < sql.length && isIdentifierChar(sql[to])) to++;

  const text = sql.slice(from, to).replace(/^\.+|\.+$/g, "");
  if (!text || isSqlKeyword(text)) return null;
  return { from, to, text };
}

function completionCacheKey(table: { name: string; schema?: string | null }) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

async function ensureColumnsForTable(table: { name: string; schema?: string | null }) {
  const cacheKey = completionCacheKey(table);
  if (cachedColumnsByTable.has(cacheKey) || !props.connectionId || !props.database) return;
  const columns = await connectionStore.listCompletionColumns(
    props.connectionId,
    props.database,
    table.name,
    table.schema ?? undefined,
  );
  cachedColumnsByTable.set(cacheKey, columns);
}

function createHoverDom(title: string, detail: string, rows: string[] = []) {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";

  const heading = document.createElement("div");
  heading.className = "font-medium";
  heading.textContent = title;
  dom.appendChild(heading);

  const detailNode = document.createElement("div");
  detailNode.className = "mt-1 text-muted-foreground";
  detailNode.textContent = detail;
  dom.appendChild(detailNode);

  for (const row of rows) {
    const rowNode = document.createElement("div");
    rowNode.className = "mt-1 font-mono text-muted-foreground";
    rowNode.textContent = row;
    dom.appendChild(rowNode);
  }

  return dom;
}

function createSignatureDom(signature: ReturnType<typeof getSqlFunctionSignatureHelp>) {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";
  if (!signature) return dom;

  const signatureNode = document.createElement("div");
  signatureNode.className = "font-mono";

  const nameNode = document.createElement("span");
  nameNode.className = "text-muted-foreground";
  nameNode.textContent = `${signature.name}(`;
  signatureNode.appendChild(nameNode);

  signature.parameters.forEach((parameter, index) => {
    if (index > 0) {
      const comma = document.createElement("span");
      comma.className = "text-muted-foreground";
      comma.textContent = ", ";
      signatureNode.appendChild(comma);
    }
    const parameterNode = document.createElement("span");
    parameterNode.className =
      index === signature.activeParameter ? "font-semibold text-foreground" : "text-muted-foreground";
    parameterNode.textContent = parameter;
    signatureNode.appendChild(parameterNode);
  });

  const closeNode = document.createElement("span");
  closeNode.className = "text-muted-foreground";
  closeNode.textContent = ")";
  signatureNode.appendChild(closeNode);
  dom.appendChild(signatureNode);

  return dom;
}

async function resolveSqlHoverTooltip(currentView: EditorViewType, pos: number) {
  if (!props.connectionId || !props.database) return null;

  const sql = currentView.state.doc.toString();
  const range = identifierRangeAt(sql, pos);
  if (!range) return null;

  const identifier = range.text;
  const parts = identifier.split(".");
  const name = parts[parts.length - 1] ?? identifier;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;

  try {
    if (cachedTables.length === 0) {
      cachedTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        name,
        MAX_COMPLETION_TABLES,
      );
    }

    let table = matchTable(identifier, cachedTables) ?? matchTable(name, cachedTables);
    if (!table) {
      const hoverTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        name,
        MAX_COMPLETION_TABLES,
      );
      cachedTables = [...cachedTables, ...hoverTables];
      table = matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    }
    if (table && (!qualifier || table.schema?.toLowerCase() === qualifier.toLowerCase() || table.name === name)) {
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(table.name, table.schema ? `table in ${table.schema}` : "table"),
        }),
      };
    }

    const context = getSqlCompletionContext(sql, pos);
    const candidates = qualifier
      ? context.referencedTables.filter(
          (rt) =>
            rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase(),
        )
      : context.referencedTables;

    for (const refTable of candidates) {
      await ensureColumnsForTable(refTable);
      const columns = cachedColumnsByTable.get(completionCacheKey(refTable)) ?? [];
      const column = columns.find((col) => col.name.toLowerCase() === name.toLowerCase());
      if (!column) continue;
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(column.name, column.dataType || "column", [
            column.schema ? `${column.schema}.${column.table}` : column.table,
          ]),
        }),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function sqlErrorDecorationRange(currentState: import("@codemirror/state").EditorState) {
  if (!props.executionError) return [];
  const location = parseSqlErrorLocation(props.executionError);
  if (!location) return [];
  const offset = lineColumnToOffset(currentState.doc.toString(), location);
  if (offset == null) return [];
  return [
    {
      from: offset,
      to: Math.min(offset + 1, currentState.doc.length),
      message: props.executionError,
    },
  ];
}

function sqlTextSpanToRange(sql: string, span: SqlTextSpan): { from: number; to: number } | null {
  if (!span.start_line || !span.start_column) return null;
  const from = lineColumnToOffset(sql, { line: span.start_line - 1, column: span.start_column - 1 });
  const to = lineColumnToOffset(sql, {
    line: Math.max(span.end_line - 1, span.start_line - 1),
    column: Math.max(span.end_column, span.start_column),
  });
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function sqlSemanticDecorationRanges(currentState: import("@codemirror/state").EditorState) {
  const sql = currentState.doc.toString();
  return semanticDiagnostics
    .map((diagnostic) => {
      const range = sqlTextSpanToRange(sql, diagnostic.span);
      return range ? { ...range, message: diagnostic.message, severity: diagnostic.severity } : null;
    })
    .filter((range): range is { from: number; to: number; message: string; severity: "error" | "warning" } => !!range);
}

function reconfigureDiagnostics() {
  if (!view.value) return;
  if (setSqlDiagnosticsEffect) {
    view.value.dispatch({
      effects: setSqlDiagnosticsEffect.of(semanticDiagnostics),
    });
    return;
  }
  if (!diagnosticComp || !buildSqlDiagnosticExtension) return;
  view.value.dispatch({
    effects: diagnosticComp.reconfigure(buildSqlDiagnosticExtension()),
  });
}

function setSemanticDiagnostics(next: SqlSemanticDiagnostic[]) {
  if (areSqlSemanticDiagnosticsEqual(semanticDiagnostics, next)) return;
  semanticDiagnostics = next;
  reconfigureDiagnostics();
}

async function enrichSemanticDiagnosticTables(tables: SqlTableReference[]) {
  if (!props.connectionId || !props.database) return tables;

  const enriched: SqlTableReference[] = [];
  for (const table of tables) {
    if (table.schema) {
      enriched.push(table);
      continue;
    }
    const cached = cachedTables.find((item) => item.name.toLowerCase() === table.name.toLowerCase());
    if (cached?.schema) {
      enriched.push({ ...table, schema: cached.schema });
      continue;
    }
    try {
      const matches = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        table.name,
        MAX_COMPLETION_TABLES,
      );
      cachedTables = [...cachedTables, ...matches];
      const match = matches.find((item) => item.name.toLowerCase() === table.name.toLowerCase());
      enriched.push(match?.schema ? { ...table, schema: match.schema } : table);
    } catch {
      enriched.push(table);
    }
  }
  return enriched;
}

async function refreshSemanticDiagnostics() {
  const currentView = view.value;
  const runId = ++semanticDiagnosticRunId;
  if (!currentView || !props.connectionId || !props.database) {
    setSemanticDiagnostics([]);
    return;
  }

  const sql = currentView.state.doc.toString();
  if (!sql.trim()) {
    setSemanticDiagnostics([]);
    return;
  }
  if (!shouldRunSqlSemanticDiagnostics(sql, currentView.state.selection.main.head)) {
    scheduleSemanticDiagnostics(1200);
    return;
  }
  if (codeMirrorCompletionStatus?.(currentView.state)) {
    scheduleSemanticDiagnostics(900);
    return;
  }

  try {
    const analysis = await api.analyzeSqlReferences(sql, props.formatDialect ?? props.dialect ?? "generic");
    if (runId !== semanticDiagnosticRunId) return;

    const tables = await enrichSemanticDiagnosticTables(analysis.tables);
    await Promise.all(tables.map((table) => ensureColumnsForTable(table)));
    if (runId !== semanticDiagnosticRunId) return;

    const enrichedAnalysis: SqlReferenceAnalysis = { ...analysis, tables };
    setSemanticDiagnostics(
      buildSqlSemanticDiagnostics(enrichedAnalysis, {
        tables: cachedTables,
        columnsByTable: cachedColumnsByTable,
      }),
    );
  } catch (error) {
    if (runId === semanticDiagnosticRunId) {
      const diagnostic = buildSqlParserErrorDiagnostic(error, sql);
      setSemanticDiagnostics(diagnostic ? [diagnostic] : []);
    }
  }
}

function scheduleSemanticDiagnostics(delay = 500) {
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  semanticDiagnosticTimer = setTimeout(() => {
    semanticDiagnosticTimer = null;
    void refreshSemanticDiagnostics();
  }, delay);
}

async function formatCurrentSql() {
  const currentView = view.value;
  if (!currentView) return;

  const selection = currentView.state.selection.main;
  const formatsSelection = !selection.empty;
  const from = formatsSelection ? selection.from : 0;
  const to = formatsSelection ? selection.to : currentView.state.doc.length;
  const source = currentView.state.sliceDoc(from, to);
  if (!source.trim()) return;

  try {
    const formatted = await formatSqlText(source, props.formatDialect ?? props.dialect ?? "generic");
    if (formatted === source) return;
    currentView.dispatch({
      changes: { from, to, insert: formatted },
      selection: formatsSelection
        ? { anchor: from, head: from + formatted.length }
        : { anchor: from + formatted.length },
    });
  } catch (e: any) {
    emit("formatError", String(e?.message || e));
  }
}

let completionEpoch = 0;

async function provideSqlCompletions(
  currentState: import("@codemirror/state").EditorState,
  position: number,
  explicit: boolean,
) {
  if (!props.connectionId || !props.database) return null;

  const epoch = ++completionEpoch;

  try {
    const fullDoc = currentState.doc.toString();
    if (!explicit && !shouldAutoOpenSqlCompletion(fullDoc, position)) return null;

    const completionContext = getSqlCompletionContext(fullDoc, position);

    // Handle INSERT column list: fetch columns for the target table
    let insertColumnsByTable = new Map<string, SqlCompletionColumn[]>();
    if (completionContext.insertTable) {
      try {
        const insertCols = await connectionStore.listCompletionColumns(
          props.connectionId,
          props.database,
          completionContext.insertTable,
          completionContext.insertSchema,
        );
        if (epoch !== completionEpoch) return null;
        const insertKey = completionContext.insertSchema
          ? `${completionContext.insertSchema}.${completionContext.insertTable}`
          : completionContext.insertTable;
        insertColumnsByTable.set(insertKey, insertCols);
      } catch {
        // ignore
      }
    }

    const shouldLoadTables = completionContext.suggestTables || !!completionContext.qualifier;
    let tables = shouldLoadTables
      ? await connectionStore.listCompletionTables(
          props.connectionId,
          props.database,
          completionContext.qualifier || completionContext.prefix,
          MAX_COMPLETION_TABLES,
        )
      : cachedTables;
    if (epoch !== completionEpoch) return null;

    // Fetch schemas for schema completion (only in table-suggesting context without qualifier)
    let schemaNames: string[] = [];
    if (completionContext.suggestTables && !completionContext.qualifier && !completionContext.insertTable) {
      try {
        schemaNames = await api.listSchemas(props.connectionId, props.database);
        if (epoch !== completionEpoch) return null;
      } catch {
        // ignore
      }
    }

    // If qualifier didn't match any table names, try it as a schema name
    let qualifierIsSchema = false;
    if (
      completionContext.qualifier &&
      tables.length === 0 &&
      (completionContext.suggestTables || completionContext.exclusiveColumnSuggestions)
    ) {
      const schemaTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        completionContext.prefix,
        MAX_COMPLETION_TABLES,
        completionContext.qualifier,
      );
      if (schemaTables.length > 0) {
        tables = schemaTables;
        qualifierIsSchema = true;
      }
      if (epoch !== completionEpoch) return null;
    }

    // Collect referenced tables — enrich with schema from filtered table lookup
    let refs = completionContext.referencedTables.map((rt) => {
      if (!rt.schema) {
        const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
        if (cached && cached.schema) {
          return { ...rt, schema: cached.schema };
        }
      }
      return rt;
    });
    const unresolvedRefs = refs.filter((rt) => !rt.schema && !rt.columns);
    if (unresolvedRefs.length > 0) {
      const lookupGroups = await Promise.all(
        unresolvedRefs.map((rt) =>
          connectionStore.listCompletionTables(props.connectionId!, props.database!, rt.name, 20),
        ),
      );
      if (epoch !== completionEpoch) return null;
      const lookupTables = lookupGroups.flat();
      refs = refs.map((rt) => {
        if (rt.schema || rt.columns) return rt;
        const matched = lookupTables.find((table) => table.name.toLowerCase() === rt.name.toLowerCase());
        return matched?.schema ? { ...rt, schema: matched.schema } : rt;
      });
    }

    // If no referenced tables but qualifier exists, infer table from tables list
    if (refs.length === 0 && completionContext.qualifier) {
      const q = completionContext.qualifier.toLowerCase();
      const matched = tables.filter((t) => t.name.toLowerCase() === q || t.name.toLowerCase().endsWith("." + q));
      refs = matched.map((t) => ({ name: t.name, schema: t.schema }));
    }

    // Populate CTE columns from parsed definitions (no backend call needed)
    const cteDefs = extractCteDefinitions(fullDoc);
    for (const refTable of refs) {
      if (refTable.columns) continue; // Already has columns from CTE parsing
      const cteDef = cteDefs.find((c) => c.name.toLowerCase() === refTable.name.toLowerCase());
      if (cteDef) {
        refTable.columns = cteDef.columns;
      }
    }

    await Promise.all(
      refs.map(async (refTable) => {
        // Skip backend fetch if columns already provided by CTE parsing
        if (refTable.columns && refTable.columns.length > 0) return;
        const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
        if (cachedColumnsByTable.has(cacheKey)) {
          return;
        }
        try {
          const columns = await connectionStore.listCompletionColumns(
            props.connectionId!,
            props.database!,
            refTable.name,
            refTable.schema,
          );
          if (epoch !== completionEpoch) return;
          cachedColumnsByTable.set(cacheKey, columns);
        } catch (e) {
          console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
        }
      }),
    );
    if (epoch !== completionEpoch) return null;

    // Build columnsByTable — from cache or CTE definitions
    const columnsByTable = new Map<string, SqlCompletionColumn[]>();
    if (insertColumnsByTable.size > 0) {
      for (const [key, cols] of insertColumnsByTable.entries()) {
        columnsByTable.set(key, cols);
      }
    } else {
      for (const refTable of refs) {
        // Use CTE columns if available
        if (refTable.columns && refTable.columns.length > 0) {
          const key = refTable.name;
          columnsByTable.set(
            key,
            refTable.columns.map((name) => ({
              name,
              table: refTable.name,
              dataType: undefined,
            })),
          );
          continue;
        }
        const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
        const cached = cachedColumnsByTable.get(cacheKey);
        if (cached) {
          columnsByTable.set(cacheKey, cached);
        }
      }
    }

    const effectiveContext = qualifierIsSchema
      ? {
          ...completionContext,
          qualifier: undefined,
          suggestTables: true,
          suggestColumns: false,
          exclusiveColumnSuggestions: false,
        }
      : completionContext;

    const items = buildSqlCompletionItemsFromContext(effectiveContext, {
      tables,
      columnsByTable,
      schemas: schemaNames,
      translations: completionTranslations.value,
    });

    if (items.length === 0) return null;

    return {
      from: position - completionContext.prefix.length,
      options: items.map((item) =>
        item.type === "snippet" && item.apply
          ? codeMirrorSnippetCompletion(item.apply, {
              label: item.label,
              type: item.type,
              detail: item.detail,
              boost: item.boost,
            })
          : {
              label: item.label,
              type: item.type,
              detail: item.detail,
              boost: item.boost,
            },
      ),
      validFor: getSqlCompletionResultValidFor(fullDoc, position),
    };
  } catch {
    return null;
  }
}

async function refreshCompletionCache() {
  cachedTables = [];
  cachedColumnsByTable.clear();
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap, rectangularSelection, hoverTooltip, showTooltip, Decoration, tooltips },
    { EditorState, Compartment, Prec, StateEffect, StateField },
    { sql, MSSQL, MySQL, PostgreSQL, SQLDialect },
    { basicSetup },
    { autocompletion, startCompletion, closeBrackets, closeBracketsKeymap, snippetCompletion, completionStatus },
    { indentWithTab },
    { bracketMatching },
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-sql"),
    import("codemirror"),
    import("@codemirror/autocomplete"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
  ]);
  editorViewModule = { EditorView, keymap, rectangularSelection } as typeof import("@codemirror/view");
  codeMirrorSnippetCompletion = snippetCompletion;
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  readOnlyComp = new Compartment();
  runKeymapComp = new Compartment();
  diagnosticComp = new Compartment();
  setSqlDiagnosticsEffect = StateEffect.define<SqlSemanticDiagnostic[]>();
  codeMirrorCompletionStatus = completionStatus;

  const diagnosticTheme = EditorView.baseTheme({
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
    ".cm-sql-semantic-warning": {
      textDecoration: "underline wavy hsl(var(--warning, 38 92% 50%))",
      textUnderlineOffset: "3px",
    },
  });

  buildSqlDiagnosticExtension = () => {
    const diagnosticEffect = setSqlDiagnosticsEffect;
    const buildDecorations = (state: import("@codemirror/state").EditorState) => {
      const errorDecorations = sqlErrorDecorationRange(state).map((range) =>
        Decoration.mark({
          class: "cm-sql-error",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      const semanticDecorations = sqlSemanticDecorationRanges(state).map((range) =>
        Decoration.mark({
          class: range.severity === "error" ? "cm-sql-error" : "cm-sql-semantic-warning",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      return Decoration.set([...errorDecorations, ...semanticDecorations], true);
    };

    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        const diagnosticsChanged =
          !!diagnosticEffect && transaction.effects.some((effect) => effect.is(diagnosticEffect));
        return transaction.docChanged || diagnosticsChanged ? buildDecorations(transaction.state) : value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  buildSqlSignatureExtension = () =>
    showTooltip.compute(["doc", "selection"], (currentState) => {
      const signature = getSqlFunctionSignatureHelp(currentState.doc.toString(), currentState.selection.main.head);
      if (!signature) return null;
      return {
        pos: currentState.selection.main.head,
        above: false,
        clip: false,
        create: () => ({ dom: createSignatureDom(signature) }),
      };
    });

  const ss = settingsStore.editorSettings;

  const baseDialect = props.dialect === "postgres" ? PostgreSQL : props.dialect === "sqlserver" ? MSSQL : MySQL;
  const extraKeywords =
    "PIVOT UNPIVOT EXCLUDE REPLACE QUALIFY ASOF POSITIONAL ANTI SEMI SAMPLE TABLESAMPLE STRUCT MAP LIST ARRAY LAMBDA UNNEST LATERAL FILTER RECURSIVE SUMMARIZE PRAGMA READ_CSV READ_PARQUET READ_JSON DESCRIBE SHOW COPY EXPORT IMPORT";
  const dialect = SQLDialect.define({
    ...baseDialect.spec,
    keywords: (baseDialect.spec.keywords || "") + " " + extraKeywords,
  });

  const theme = await loadEditorTheme(ss.theme, editorThemeAppearance());

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      basicSetup,
      sql({ dialect }),
      tooltips({ parent: document.body }),
      autocompletion({
        activateOnTyping: true,
        override: [
          async (context: CompletionContext) => provideSqlCompletions(context.state, context.pos, context.explicit),
        ],
      }),
      sqlCompletionTheme(EditorView),
      codeMirrorTheme.of(theme),
      closeBrackets(),
      bracketMatching(),
      hoverTooltip((currentView, pos) => resolveSqlHoverTooltip(currentView, pos)),
      buildSqlSignatureExtension(),
      diagnosticComp.of(buildSqlDiagnosticExtension()),
      Prec.highest(keymap.of([...closeBracketsKeymap, indentWithTab])),
      runKeymapComp.of(runKeymapExtension(keymap)),
      wordWrapComp.of(props.forceWordWrap || ss.wordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
      rectangularSelection({ eventFilter: (e: MouseEvent) => e.altKey || e.button === 1 }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
          scheduleSemanticDiagnostics();
          let insertedText = "";
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            insertedText += inserted.toString();
          });
          if (insertedText.endsWith(".")) {
            startCompletion(update.view);
          }
        }
        if (update.selectionSet || update.docChanged) {
          emit("selectionChange", selectedSqlFromView(update.view));
          emit("cursorChange", update.state.selection.main.head);
          if (searchVisible.value) updateMatchInfo();
        }
      }),
      fontThemeComp.of(
        editorFontTheme(EditorView, liveFontSize.value, ss.fontFamily, {
          fixedHeight: true,
          scrollable: true,
        }),
      ),
      EditorView.domEventHandlers({
        wheel(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
          event.preventDefault();
          const next = fontSizeFromWheelDelta(liveFontSize.value, event.deltaY);
          applyLiveFontSize(next);
          scheduleFontSizeCommit(next);
          return true;
        },
        mousedown: (event: MouseEvent) => {
          // Click without modifier -> close column panel
          if (!event.metaKey && !event.ctrlKey) {
            if (event.button === 0) {
              emit("closeColumnPanel");
            }
            return false;
          }
          // Only handle Ctrl/Cmd + left click
          if (event.button !== 0) return false;

          const currentView = view.value;
          if (!currentView || !props.connectionId || !props.database) {
            return false;
          }

          // Use posAtCoords for accurate click position
          const coords = { x: event.clientX, y: event.clientY };
          const pos = currentView.posAtCoords(coords);
          if (pos == null) {
            return false;
          }

          const doc = currentView.state.doc.toString();
          const identifier = extractIdentifierAt(doc, pos);
          if (!identifier) {
            return false;
          }
          if (isSqlKeyword(identifier)) {
            return false;
          }

          // Prevent default, resolve async
          event.preventDefault();
          setTimeout(async () => {
            try {
              // Ensure table cache is populated
              if (cachedTables.length === 0) {
                cachedTables = await connectionStore.listCompletionTables(
                  props.connectionId!,
                  props.database!,
                  identifier,
                  MAX_COMPLETION_TABLES,
                );
              }

              // 1. Check if it's a table name
              const matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit(
                  "clickTable",
                  matchedTable.schema ? `${matchedTable.schema}.${matchedTable.name}` : matchedTable.name,
                );
                return;
              }

              // 2. Parse SQL at click position to get referenced tables
              const context = getSqlCompletionContext(doc, pos);
              let referencedTables = context.referencedTables;
              // Enrich referenced tables with schema from cachedTables
              referencedTables = referencedTables.map((rt) => {
                const cached = cachedTables.find((ct) => ct.name.toLowerCase() === rt.name.toLowerCase());
                if (cached && cached.schema && !rt.schema) {
                  return { ...rt, schema: cached.schema };
                }
                return rt;
              });

              // Check if identifier has a qualifier (e.g., c.card_name)
              const qualifierMatch = /^(.+)\.(.+)$/.exec(identifier);
              const qualifier = qualifierMatch ? qualifierMatch[1] : null;
              const colName = qualifierMatch ? qualifierMatch[2] : identifier;
              const colLower = colName.toLowerCase();

              if (referencedTables.length === 0) {
                return;
              }
              // 3. Fetch columns — if qualifier, only check matching table; otherwise check all
              const tablesToCheck = qualifier
                ? referencedTables.filter(
                    (rt) =>
                      rt.alias?.toLowerCase() === qualifier.toLowerCase() ||
                      rt.name.toLowerCase() === qualifier.toLowerCase(),
                  )
                : referencedTables;

              if (tablesToCheck.length === 0 && qualifier) {
                return;
              }

              const matchedCols: Array<{ name: string; table: string; schema?: string }> = [];

              for (const refTable of tablesToCheck) {
                const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;

                // Use persistent column cache; fetch only if missing
                let cols = cachedColumnsByTable.get(cacheKey);
                if (!cols) {
                  try {
                    cols = await connectionStore.listCompletionColumns(
                      props.connectionId!,
                      props.database!,
                      refTable.name,
                      refTable.schema,
                    );
                    cachedColumnsByTable.set(cacheKey, cols);
                  } catch {
                    continue;
                  }
                }
                for (const col of cols) {
                  if (col.name.toLowerCase() === colLower) {
                    matchedCols.push({
                      name: col.name,
                      table: refTable.name,
                      schema: col.schema || refTable.schema,
                    });
                  }
                }
              }

              if (matchedCols.length > 0) {
                emit("clickColumn", matchedCols);
              }
            } catch (e) {
              console.error("[DBX] Ctrl+click error:", e);
            }
          }, 0);
          return true;
        },
      }),
    ],
  });

  view.value = new EditorView({ state, parent: editorRef.value });
  syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);

  cachedTables = [];
  scheduleSemanticDiagnostics();
});

watch(
  () => props.modelValue,
  (val) => {
    if (view.value && val !== view.value.state.doc.toString()) {
      view.value.dispatch({
        changes: { from: 0, to: view.value.state.doc.length, insert: val },
      });
    }
  },
);

watch(
  () => props.formatRequestId,
  (val, oldVal) => {
    if (val && val !== oldVal) formatCurrentSql();
  },
);

watch(
  () => props.executionError,
  () => {
    reconfigureDiagnostics();
  },
);

watch(
  () => props.connectionId,
  () => {
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch(
  () => props.database,
  () => {
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch(
  () => props.forceWordWrap,
  () => {
    if (!view.value || !wordWrapComp) return;
    view.value.dispatch({
      effects: wordWrapComp.reconfigure(wordWrapExtension()),
    });
  },
);

// Reactively apply editor settings changes
watch(
  [() => settingsStore.editorSettings, () => isDark.value],
  async ([ss]) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    if (!isGestureZooming.value && !zoomCommitScheduler.hasPendingCommit() && liveFontSize.value !== ss.fontSize) {
      liveFontSize.value = ss.fontSize;
    }
    syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);
    const themeExt = await loadEditorTheme(ss.theme, editorThemeAppearance());
    view.value.dispatch({
      effects: [
        codeMirrorTheme.reconfigure(themeExt),
        wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []),
        runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap)),
      ],
    });
  },
  { deep: true },
);

onBeforeUnmount(() => {
  zoomCommitScheduler.dispose();
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  view.value?.destroy();
});

function dispatchSearchQuery() {
  const v = view.value;
  if (!v) return;
  const q = new SearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    regexp: useRegex.value,
    replace: replaceText.value,
  });
  v.dispatch({ effects: setSearchQuery.of(q) });
  updateMatchInfo();
}

function updateMatchInfo() {
  const v = view.value;
  if (!v || !searchText.value) {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
    return;
  }
  try {
    const q = new SearchQuery({
      search: searchText.value,
      caseSensitive: caseSensitive.value,
      regexp: useRegex.value,
    });
    if (!q.valid) {
      matchCount.value = 0;
      currentMatchIndex.value = 0;
      return;
    }
    const iter = q.getCursor(v.state);
    let count = 0;
    let curIdx = 0;
    const selFrom = v.state.selection.main.from;
    const selTo = v.state.selection.main.to;
    let r = iter.next();
    while (!r.done) {
      count++;
      if (r.value.from === selFrom && r.value.to === selTo) curIdx = count;
      r = iter.next();
    }
    matchCount.value = count;
    currentMatchIndex.value = curIdx || (count > 0 ? 1 : 0);
  } catch {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
  }
}

function openSearch(): boolean {
  searchVisible.value = true;
  const v = view.value;
  if (v) {
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    if (sel && !sel.includes("\n")) searchText.value = sel;
  }
  nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
  if (searchText.value) dispatchSearchQuery();
  return true;
}

function closeSearch() {
  searchVisible.value = false;
  showReplace.value = false;
  const v = view.value;
  if (v) {
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    v.focus();
  }
  matchCount.value = 0;
  currentMatchIndex.value = 0;
}

function nextMatch() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmFindNext(v);
  updateMatchInfo();
}

function prevMatch() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmFindPrevious(v);
  updateMatchInfo();
}

function doReplace() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmReplaceNext(v);
  updateMatchInfo();
}

function doReplaceAll() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmReplaceAll(v);
  updateMatchInfo();
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    nextMatch();
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    prevMatch();
  }
}

watch([searchText, caseSensitive, useRegex, replaceText], () => {
  if (searchVisible.value) dispatchSearchQuery();
});

defineExpose({ openSearch });
</script>

<template>
  <div
    class="h-full w-full overflow-hidden relative"
    @gesturestart="onEditorGestureStart"
    @gesturechange="onEditorGestureChange"
    @gestureend="onEditorGestureEnd"
  >
    <div ref="editorRef" data-query-editor-root class="h-full w-full overflow-hidden" />
    <Transition
      enter-active-class="transition-all duration-150"
      leave-active-class="transition-all duration-100"
      enter-from-class="opacity-0 -translate-y-1"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="searchVisible"
        class="absolute top-1 right-4 z-20 bg-background border rounded-md shadow-md p-1.5 flex flex-col gap-1"
      >
        <div class="flex items-center gap-0.5">
          <input
            ref="searchInputRef"
            v-model="searchText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            :placeholder="t('editor.search.find')"
            @keydown="onSearchKeydown"
          />
          <button
            class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent"
            :class="caseSensitive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
            :title="t('editor.search.caseSensitive')"
            @click="caseSensitive = !caseSensitive"
          >
            Aa
          </button>
          <button
            class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent"
            :class="useRegex ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
            :title="t('editor.search.regex')"
            @click="useRegex = !useRegex"
          >
            .*
          </button>
          <span v-if="searchText" class="text-xs text-muted-foreground min-w-[3rem] text-center shrink-0">
            {{ matchCount > 0 ? `${currentMatchIndex}/${matchCount}` : t("editor.search.noResults") }}
          </span>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            :title="t('editor.search.prevMatch')"
            @click="prevMatch"
          >
            <ChevronUp class="w-3.5 h-3.5" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            :title="t('editor.search.nextMatch')"
            @click="nextMatch"
          >
            <ChevronDown class="w-3.5 h-3.5" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            :title="showReplace ? t('editor.search.collapseReplace') : t('editor.search.expandReplace')"
            @click="showReplace = !showReplace"
          >
            <ChevronRight class="w-3 h-3 transition-transform" :class="showReplace && 'rotate-90'" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            :title="t('editor.search.close')"
            @click="closeSearch"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div v-if="showReplace" class="flex items-center gap-0.5">
          <input
            v-model="replaceText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            :placeholder="t('editor.search.replace')"
            @keydown.enter.prevent="doReplace"
          />
          <button
            class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border"
            :title="t('editor.search.replace')"
            @click="doReplace"
          >
            {{ t("editor.search.replace") }}
          </button>
          <button
            class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border"
            :title="t('editor.search.replaceAll')"
            @click="doReplaceAll"
          >
            全部
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
