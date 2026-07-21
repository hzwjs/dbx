<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { requiresSqlFileTargetDatabaseSelection } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { cancelSqlFileExecution, executeSqlFile, listenSqlFileProgress, listDatabases, previewSqlFile, type SqlFilePreview } from "@/lib/backend/api";
import { cancelSqlFileBatch, createSqlFileBatch, getSqlFileBatch, listSqlFileBatches } from "@/lib/backend/http";
import { useExportTracker } from "@/composables/useExportTracker";
import { useSqlFileBatchExecution } from "@/composables/useSqlFileBatchExecution";
import { useWebSqlFileBatchExecution } from "@/composables/useWebSqlFileBatchExecution";
import { listenSqlFileBatch } from "@/lib/sql/httpSqlFileBatch";
import type { SqlFileBatchTargetState, SqlFileBatchTargetStatus } from "@/lib/sql/sqlFileBatchExecution";
import type { WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";
import { decideSqlFileBatchDialogClose, decideSqlFileBatchDialogOpen, initialSqlFileBatchDialogSession } from "@/lib/sql/sqlFileBatchDialogSession";
import { CheckSquare, ChevronDown, ChevronRight, FileCode, FolderOpen, Loader2, Play, Square, X } from "@lucide/vue";

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const { addSqlFileTask, updateSqlFileTask } = useExportTracker();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillFilePath?: string;
}>();

const store = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
const isDesktop = isTauriRuntime();

const fileInput = ref<HTMLInputElement | null>(null);
const filePath = ref("");
const preview = ref<SqlFilePreview | null>(null);
const selectingFile = ref(false);
const loadingPreview = ref(false);
const baselineConnectionId = ref("");
const selectedConnectionIds = ref<string[]>([]);
const expandedTargetIds = ref<string[]>([]);
const batchDialogSession = ref(initialSqlFileBatchDialogSession());
const database = ref("");
const batchDatabase = ref("");
const databaseOptions = ref<string[]>([]);
const loadingDatabases = ref(false);
const continueOnError = ref(false);

const sqlConnections = computed(() => store.connections.filter((c) => !["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "nacos"].includes(c.db_type)));

const baselineConnection = computed(() => sqlConnections.value.find((connection) => connection.id === baselineConnectionId.value));
const sameTypeSqlConnections = computed(() => {
  const baselineDbType = baselineConnection.value?.db_type;
  if (!baselineDbType) return [];
  return sqlConnections.value.filter((connection) => connection.db_type === baselineDbType);
});

async function prepareBatchTarget(targetConnectionId: string, targetDatabase: string): Promise<"ready" | "declined"> {
  await store.ensureConnected(targetConnectionId);
  const targetConnection = sqlConnections.value.find((connection) => connection.id === targetConnectionId);
  if (!targetConnection) throw new Error(`Connection not found: ${targetConnectionId}`);
  if (!preview.value) throw new Error("SQL file preview is unavailable");

  const productionContext = productionContextForDatabase(targetConnection, targetDatabase);
  if (!productionContext.active) return "ready";

  const confirmed = await productionSafetyStore.requestConfirmation({
    sql: preview.value.preview,
    connectionName: targetConnection.name,
    database: targetDatabase,
    productionDatabases: productionContext.databases,
    source: t("production.sourceSqlFile"),
  });
  return confirmed ? "ready" : "declined";
}

const {
  targets: batchTargets,
  running: batchRunning,
  stopping: batchStopping,
  summary: batchSummary,
  start: startBatch,
  stop: stopBatchController,
  reset: resetBatch,
} = useSqlFileBatchExecution({
  createExecutionId: () => uuid(),
  prepareTarget: prepareBatchTarget,
  addTask(executionId, fileName, taskFilePath, targetConnectionId, targetDatabase) {
    addSqlFileTask(executionId, fileName, taskFilePath, targetConnectionId, targetDatabase);
  },
  updateTask: updateSqlFileTask,
  listen: (_executionId, handler) => listenSqlFileProgress(handler),
  execute: executeSqlFile,
  cancel: cancelSqlFileExecution,
  refresh: (targetConnectionId, targetDatabase) => store.refreshDatabaseTreeNode(targetConnectionId, targetDatabase.trim()),
});

const webBatch = useWebSqlFileBatchExecution({
  create: createSqlFileBatch,
  list: listSqlFileBatches,
  get: getSqlFileBatch,
  cancel: cancelSqlFileBatch,
  listen: listenSqlFileBatch,
});

function emptySummary() {
  return { success: 0, partial: 0, failed: 0, cancelled: 0, skipped: 0 };
}

const displayedBatchTargets = computed(() => (isDesktop ? batchTargets.value : (webBatch.currentBatch.value?.targets ?? [])));
const displayedBatchSummary = computed(() => (isDesktop ? batchSummary.value : (webBatch.currentBatch.value?.summary ?? emptySummary())));
const displayedBatchDatabase = computed(() => (isDesktop ? batchDatabase.value : (webBatch.currentBatch.value?.database ?? "")));
const batchExecutionActive = computed(() => (isDesktop ? batchRunning.value : webBatch.currentBatch.value?.status === "running" || webBatch.currentBatch.value?.status === "cancelling"));
const executionActive = computed(() => batchExecutionActive.value || (!isDesktop && webBatch.starting.value));
const completedTargetCount = computed(() => displayedBatchTargets.value.filter((target) => target.status !== "pending" && target.status !== "running").length);
const batchProgressPercent = computed(() => (displayedBatchTargets.value.length > 0 ? Math.round((completedTargetCount.value / displayedBatchTargets.value.length) * 100) : 0));
const batchElapsedMs = computed(() => displayedBatchTargets.value.reduce((total, target) => total + target.elapsedMs, 0));

const canStart = computed(() => {
  const connection = baselineConnection.value;
  if (!preview.value || !connection || executionActive.value || loadingPreview.value || loadingDatabases.value) return false;
  if (selectedConnectionIds.value.length === 0) return false;
  return !!database.value.trim() || !requiresSqlFileTargetDatabaseSelection(connection, preview.value.canExecuteWithoutSelectedDatabase);
});
const previewLineCount = computed(() => preview.value?.preview.split(/\r\n|\r|\n/).length ?? 0);
const previewLineNumbers = computed(() => Array.from({ length: previewLineCount.value }, (_, index) => index + 1));
const previewIsTruncated = computed(() => {
  if (!preview.value) return false;
  return preview.value.sizeBytes > preview.value.preview.length;
});
const previewLineSummary = computed(() => (previewIsTruncated.value ? t("sqlFile.previewingFirstLines", { count: previewLineCount.value }) : t("sqlFile.previewingLines", { count: previewLineCount.value })));

function connectionIconType(id: string) {
  const config = store.getConfig(id);
  return config?.driver_profile || config?.db_type || "mysql";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function connectionName(id: string) {
  return sqlConnections.value.find((connection) => connection.id === id)?.name ?? id;
}

function batchStatusLabel(status: SqlFileBatchTargetStatus) {
  return t(`sqlFile.batchStatus.${status}`);
}

function sharedBatchStatusLabel(status: WebSqlFileBatchSnapshot["status"]) {
  return t(`sqlFile.batchStatus.${status}`);
}

function formatBatchCreatedAt(createdAtMs: number) {
  return new Date(createdAtMs).toLocaleString();
}

function batchStatusTone(status: SqlFileBatchTargetStatus) {
  if (status === "success") return "text-green-600";
  if (status === "partial") return "text-yellow-600";
  if (status === "failed") return "text-destructive";
  if (status === "cancelled" || status === "skipped") return "text-yellow-600";
  if (status === "running") return "text-primary";
  return "text-muted-foreground";
}

function isTargetExpanded(executionId: string) {
  return expandedTargetIds.value.includes(executionId);
}

function toggleTargetExpanded(executionId: string) {
  expandedTargetIds.value = isTargetExpanded(executionId) ? expandedTargetIds.value.filter((id) => id !== executionId) : [...expandedTargetIds.value, executionId];
}

function toggleTargetSelection(id: string) {
  if (batchExecutionActive.value) return;
  selectedConnectionIds.value = selectedConnectionIds.value.includes(id) ? selectedConnectionIds.value.filter((selectedId) => selectedId !== id) : [...selectedConnectionIds.value, id];
}

function targetHasDetails(target: SqlFileBatchTargetState) {
  return target.status !== "pending" || !!target.error || target.failures.length > 0;
}

function resolveInitialConnectionId() {
  if (props.prefillConnectionId && sqlConnections.value.some((c) => c.id === props.prefillConnectionId)) {
    return props.prefillConnectionId;
  }
  return sqlConnections.value[0]?.id ?? "";
}

function chooseDatabase(names: string[], id: string) {
  const configDatabase = store.getConfig(id)?.database ?? "";
  if (names.length > 0) {
    if (props.prefillDatabase && names.includes(props.prefillDatabase)) return props.prefillDatabase;
    if (configDatabase && names.includes(configDatabase)) return configDatabase;
    return names.length === 1 ? names[0] : "";
  }
  return props.prefillDatabase ?? configDatabase;
}

function resetState() {
  filePath.value = "";
  preview.value = null;
  selectingFile.value = false;
  loadingPreview.value = false;
  const initialConnectionId = resolveInitialConnectionId();
  baselineConnectionId.value = initialConnectionId;
  selectedConnectionIds.value = initialConnectionId ? [initialConnectionId] : [];
  expandedTargetIds.value = [];
  database.value = "";
  batchDatabase.value = "";
  databaseOptions.value = [];
  loadingDatabases.value = false;
  continueOnError.value = false;
  if (isDesktop) resetBatch();
}

let databaseLoadToken = 0;

async function loadDatabasesForConnection(id: string) {
  const token = databaseLoadToken + 1;
  databaseLoadToken = token;
  databaseOptions.value = [];

  if (!sqlConnections.value.some((c) => c.id === id)) {
    database.value = "";
    return;
  }

  loadingDatabases.value = true;
  try {
    await store.ensureConnected(id);
    const names = databaseOptionsForConnection(
      (await listDatabases(id)).map((db) => db.name),
      store.getConfig(id),
    );
    if (token !== databaseLoadToken) return;
    databaseOptions.value = names;
    database.value = chooseDatabase(names, id);
  } catch {
    if (token !== databaseLoadToken) return;
    databaseOptions.value = [];
    database.value = chooseDatabase([], id);
  } finally {
    if (token === databaseLoadToken) {
      loadingDatabases.value = false;
    }
  }
}

async function previewSelectedSqlFile(fileOrPath: string | File) {
  if (isTauriRuntime()) {
    return previewSqlFile(fileOrPath as string);
  }
  const { previewSqlFile: previewWebSqlFile } = await import("@/lib/backend/http");
  return previewWebSqlFile(fileOrPath as File);
}

async function loadPreview(fileOrPath: string | File) {
  loadingPreview.value = true;
  preview.value = null;
  try {
    preview.value = await previewSelectedSqlFile(fileOrPath);
    filePath.value = preview.value.filePath;
    if (isDesktop) {
      expandedTargetIds.value = [];
      resetBatch();
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingPreview.value = false;
  }
}

async function selectFile() {
  if (executionActive.value) return;
  if (!isDesktop) {
    fileInput.value?.click();
    return;
  }
  selectingFile.value = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof selected === "string") {
      await loadPreview(selected);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    selectingFile.value = false;
  }
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || executionActive.value) return;
  selectingFile.value = true;
  try {
    await loadPreview(file);
  } finally {
    selectingFile.value = false;
  }
}

async function startBatchExecution() {
  if (!isDesktop || !canStart.value || !preview.value) return;
  expandedTargetIds.value = [];
  batchDatabase.value = database.value.trim();
  await startBatch({
    connectionIds: [...selectedConnectionIds.value],
    database: database.value.trim(),
    fileName: preview.value.fileName,
    filePath: preview.value.filePath,
    continueOnError: continueOnError.value,
  });
}

async function startWebBatchExecution() {
  if (isDesktop || !canStart.value || !preview.value) return;

  try {
    for (const targetConnectionId of selectedConnectionIds.value) {
      if ((await prepareBatchTarget(targetConnectionId, database.value.trim())) === "declined") return;
    }

    expandedTargetIds.value = [];
    await webBatch.start({
      connectionIds: [...selectedConnectionIds.value],
      database: database.value.trim(),
      filePath: preview.value.filePath,
      continueOnError: continueOnError.value,
    });
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

async function stopBatch() {
  await stopBatchController();
}

async function stopWebBatch() {
  try {
    await webBatch.cancel();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

function selectWebBatch(batchId: string) {
  expandedTargetIds.value = [];
  webBatch.select(batchId);
}

function handleOpenChange(nextOpen: boolean) {
  if (!nextOpen) {
    batchDialogSession.value = decideSqlFileBatchDialogClose(batchDialogSession.value, isDesktop, batchRunning.value);
    if (!isDesktop) webBatch.disconnect();
  }
  open.value = nextOpen;
}

watch(baselineConnectionId, (id) => {
  loadDatabasesForConnection(id);
});

watch(sqlConnections, () => {
  if (!open.value || executionActive.value) return;
  if (baselineConnection.value) {
    const eligibleIds = new Set(sameTypeSqlConnections.value.map((connection) => connection.id));
    selectedConnectionIds.value = selectedConnectionIds.value.filter((id) => eligibleIds.has(id));
    return;
  }
  const initialConnectionId = resolveInitialConnectionId();
  baselineConnectionId.value = initialConnectionId;
  selectedConnectionIds.value = initialConnectionId ? [initialConnectionId] : [];
});

watch(
  () => webBatch.currentBatch.value,
  (snapshot, previousSnapshot) => {
    if (isDesktop || !snapshot || snapshot.batchId !== previousSnapshot?.batchId) return;
    const previousStatuses = new Map(previousSnapshot.targets.map((target) => [target.executionId, target.status]));
    for (const target of snapshot.targets) {
      const previousStatus = previousStatuses.get(target.executionId);
      if ((target.status === "success" || target.status === "partial") && previousStatus !== "success" && previousStatus !== "partial") {
        void store.refreshDatabaseTreeNode(target.connectionId, snapshot.database.trim()).catch((e: any) => toast(e?.message || String(e), 5000));
      }
    }
  },
);

watch(
  open,
  (value) => {
    if (!value) {
      if (!isDesktop) webBatch.disconnect();
      return;
    }
    if (isDesktop) {
      const decision = decideSqlFileBatchDialogOpen(batchDialogSession.value, batchRunning.value);
      batchDialogSession.value = decision.session;
      if (!decision.reset) return;
    }
    resetState();
    if (baselineConnectionId.value) {
      loadDatabasesForConnection(baselineConnectionId.value);
    }
    if (!isDesktop) void webBatch.load().catch((e: any) => toast(e?.message || String(e), 5000));
    // When opened from the SQL Files panel with a pre-selected file, load its
    // preview automatically so the user can review statements before running.
    if (props.prefillFilePath) {
      void loadPreview(props.prefillFilePath);
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogScrollContent class="flex max-h-[calc(100dvh-6rem)] min-h-0 min-w-0 flex-col overflow-hidden sm:max-w-[860px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-center gap-2">
          <FileCode class="w-4 h-4" />
          {{ t("sqlFile.title") }}
        </DialogTitle>
      </DialogHeader>

      <!-- Keep terminal actions reachable while long previews and errors scroll inside the viewport. -->
      <div class="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto py-3">
        <div class="min-w-0 space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.file") }}
          </div>

          <div class="flex items-center gap-2">
            <input ref="fileInput" type="file" accept=".sql,text/sql" class="hidden" @change="handleFileInputChange" />
            <Input :model-value="filePath" readonly class="h-8 text-xs font-mono" :placeholder="t('sqlFile.selectSqlFile')" />
            <Button variant="outline" size="sm" class="h-8 shrink-0" :disabled="executionActive || selectingFile" @click="selectFile">
              <Loader2 v-if="selectingFile || loadingPreview" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
              <FolderOpen v-else class="w-3.5 h-3.5 mr-1.5" />
              {{ t("sqlFile.browse") }}
            </Button>
          </div>

          <div v-if="preview" class="min-w-0 max-w-full overflow-hidden rounded-md border">
            <div class="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b bg-muted/40">
              <div class="min-w-0 flex items-center gap-2">
                <FileCode class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span class="font-medium truncate">{{ preview.fileName }}</span>
              </div>
              <div class="flex shrink-0 items-center gap-2 text-muted-foreground">
                <span>{{ previewLineSummary }}</span>
                <span class="h-3 w-px bg-border" />
                <span>{{ formatBytes(preview.sizeBytes) }}</span>
              </div>
            </div>
            <div class="sql-file-preview-viewer flex min-h-56 max-h-[min(42vh,360px)] max-w-full overflow-auto bg-muted/15 text-xs">
              <div class="sticky left-0 z-10 select-none border-r bg-background/95 px-2 py-3 text-right font-mono leading-5 text-muted-foreground/70">
                <div v-for="lineNumber in previewLineNumbers" :key="lineNumber">{{ lineNumber }}</div>
              </div>
              <pre class="min-w-max flex-1 p-3 font-mono leading-5 whitespace-pre" v-html="highlight(preview.preview)"></pre>
            </div>
          </div>
        </div>

        <div class="min-w-0 space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.target") }}
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("sqlFile.connection") }}</Label>
              <Popover>
                <PopoverTrigger as-child>
                  <Button variant="outline" class="h-8 w-full justify-between px-3 text-xs font-normal" :disabled="batchExecutionActive">
                    <span v-if="selectedConnectionIds.length" class="min-w-0 truncate">
                      {{ t("sqlFile.selectedCount", { count: selectedConnectionIds.length }) }}
                    </span>
                    <span v-else class="min-w-0 truncate text-muted-foreground">{{ t("sqlFile.selectConnection") }}</span>
                    <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" class="w-[var(--reka-popover-trigger-width)] gap-0 p-1">
                  <button v-for="c in sameTypeSqlConnections" :key="c.id" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent" :aria-pressed="selectedConnectionIds.includes(c.id)" @click="toggleTargetSelection(c.id)">
                    <CheckSquare v-if="selectedConnectionIds.includes(c.id)" class="h-3.5 w-3.5 shrink-0 text-primary" />
                    <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                    <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="h-3.5 w-3.5 shrink-0" />
                    <ConnectionGroupBadge :connection-id="c.id" />
                    <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
                  </button>
                </PopoverContent>
              </Popover>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("sqlFile.database") }}</Label>
              <Select v-if="databaseOptions.length" v-model="database" :disabled="executionActive || loadingDatabases">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('sqlFile.selectDatabase')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="db in databaseOptions" :key="db" :value="db">{{ db }}</SelectItem>
                </SelectContent>
              </Select>
              <div v-else class="relative">
                <Input v-model="database" class="h-8 text-xs" :disabled="executionActive || loadingDatabases" :placeholder="t('sqlFile.databasePlaceholder')" />
                <Loader2 v-if="loadingDatabases" class="absolute right-2 top-2 w-3.5 h-3.5 animate-spin text-muted-foreground" />
              </div>
            </div>
          </div>
        </div>

        <div class="min-w-0 space-y-2.5">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.options") }}
          </div>

          <button type="button" class="flex items-center gap-2 text-xs text-left" :disabled="executionActive" @click="continueOnError = !continueOnError">
            <CheckSquare v-if="continueOnError" class="w-3.5 h-3.5 text-primary shrink-0" />
            <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            {{ t("sqlFile.continueOnError") }}
          </button>
        </div>

        <div v-if="!isDesktop && webBatch.batches.value.length > 1" class="grid min-w-0 gap-1.5">
          <Label class="text-xs">{{ t("sqlFile.sharedBatches") }}</Label>
          <Select :model-value="webBatch.selectedBatchId.value" :disabled="webBatch.loading.value" @update:model-value="selectWebBatch">
            <SelectTrigger class="h-8 text-xs">
              <SelectValue :placeholder="t('sqlFile.selectBatch')" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem v-for="batch in webBatch.batches.value" :key="batch.batchId" :value="batch.batchId"> {{ batch.fileName }} · {{ formatBatchCreatedAt(batch.createdAtMs) }} · {{ sharedBatchStatusLabel(batch.status) }} </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div v-if="displayedBatchTargets.length" class="min-w-0 space-y-3">
          <div class="flex items-center justify-between gap-3 text-xs">
            <div class="min-w-0 font-medium">
              {{ t("sqlFile.batchProgress", { completed: completedTargetCount, total: displayedBatchTargets.length }) }}
            </div>
            <span class="shrink-0 text-muted-foreground">{{ formatElapsed(batchElapsedMs) }}</span>
          </div>

          <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div class="h-full rounded-full bg-primary transition-[width] duration-300" :style="{ width: `${batchProgressPercent}%` }" />
          </div>

          <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{{ t("sqlFile.batchStatus.success") }}: {{ displayedBatchSummary.success }}</span>
            <span>{{ t("sqlFile.batchStatus.partial") }}: {{ displayedBatchSummary.partial }}</span>
            <span>{{ t("sqlFile.batchStatus.failed") }}: {{ displayedBatchSummary.failed }}</span>
            <span>{{ t("sqlFile.batchStatus.cancelled") }}: {{ displayedBatchSummary.cancelled }}</span>
            <span>{{ t("sqlFile.batchStatus.skipped") }}: {{ displayedBatchSummary.skipped }}</span>
          </div>

          <div class="space-y-2">
            <div v-for="target in displayedBatchTargets" :key="target.executionId" class="overflow-hidden rounded-md border">
              <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40" :aria-expanded="isTargetExpanded(target.executionId)" :aria-controls="`sql-file-target-details-${target.executionId}`" @click="toggleTargetExpanded(target.executionId)">
                <ChevronDown v-if="isTargetExpanded(target.executionId)" class="h-3.5 w-3.5 shrink-0" />
                <ChevronRight v-else class="h-3.5 w-3.5 shrink-0" :class="{ 'text-muted-foreground/50': !targetHasDetails(target) }" />
                <DatabaseIcon :db-type="connectionIconType(target.connectionId)" class="h-3.5 w-3.5 shrink-0" />
                <span class="min-w-0 flex-1 truncate font-medium">{{ connectionName(target.connectionId) }}</span>
                <span class="hidden max-w-40 truncate text-muted-foreground sm:inline">{{ displayedBatchDatabase || t("sqlFile.noDatabase") }}</span>
                <span class="shrink-0 font-medium" :class="batchStatusTone(target.status)">
                  {{ batchStatusLabel(target.status) }}
                </span>
                <span class="w-16 shrink-0 text-right text-muted-foreground">{{ formatElapsed(target.elapsedMs) }}</span>
              </button>

              <div v-if="isTargetExpanded(target.executionId)" :id="`sql-file-target-details-${target.executionId}`" class="space-y-2 border-t bg-muted/10 px-3 py-2 text-xs">
                <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div>
                    <div class="text-muted-foreground">{{ t("sqlFile.succeeded") }}</div>
                    <div class="font-medium text-green-600">{{ target.successCount }}</div>
                  </div>
                  <div>
                    <div class="text-muted-foreground">{{ t("sqlFile.failed") }}</div>
                    <div class="font-medium text-destructive">{{ target.failureCount }}</div>
                  </div>
                  <div>
                    <div class="text-muted-foreground">{{ t("sqlFile.affectedRows") }}</div>
                    <div class="font-medium">{{ target.affectedRows.toLocaleString() }}</div>
                  </div>
                  <div>
                    <div class="text-muted-foreground">{{ t("sqlFile.database") }}</div>
                    <div class="truncate font-medium">{{ displayedBatchDatabase || t("sqlFile.noDatabase") }}</div>
                  </div>
                </div>

                <div v-if="target.statementSummary" class="space-y-1">
                  <div class="text-muted-foreground">{{ t("sqlFile.currentStatement") }}</div>
                  <div class="max-h-20 overflow-auto rounded-md border bg-background/60 p-2 font-mono whitespace-pre-wrap">
                    {{ target.statementSummary }}
                  </div>
                </div>

                <div v-if="target.error" class="space-y-1">
                  <div class="text-muted-foreground">{{ t("sqlFile.setupOrTerminalError") }}</div>
                  <div class="max-h-32 overflow-auto rounded-md border bg-destructive/5 p-2 text-destructive whitespace-pre-wrap">
                    {{ target.error }}
                  </div>
                </div>

                <div v-if="target.failures.length" class="space-y-1.5">
                  <div class="font-medium text-destructive">{{ t("sqlFile.failureDetails") }}</div>
                  <div v-for="(failure, failureIndex) in target.failures" :key="`${failure.statementIndex}-${failureIndex}`" class="space-y-1 rounded-md border bg-destructive/5 p-2">
                    <div class="font-medium text-destructive">{{ t("sqlFile.failedStatement", { index: failure.statementIndex }) }}</div>
                    <div v-if="failure.statementSummary" class="font-mono whitespace-pre-wrap">{{ failure.statementSummary }}</div>
                    <div class="text-destructive whitespace-pre-wrap">{{ failure.error }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter class="shrink-0">
        <template v-if="isDesktop">
          <template v-if="batchRunning">
            <Button variant="outline" size="sm" @click="handleOpenChange(false)">
              {{ t("sqlFile.runInBackground") }}
            </Button>
            <Button variant="destructive" size="sm" :disabled="batchStopping" @click="stopBatch">
              <Loader2 v-if="batchStopping" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              <X v-else class="mr-1.5 h-3.5 w-3.5" />
              {{ t("sqlFile.stopBatch") }}
            </Button>
          </template>
          <template v-else>
            <Button variant="outline" size="sm" @click="open = false">
              {{ t("common.close") }}
            </Button>
            <Button size="sm" :disabled="!canStart" @click="startBatchExecution">
              <Play class="mr-1.5 h-3.5 w-3.5" />
              {{ t("sqlFile.execute") }}
            </Button>
          </template>
        </template>
        <template v-else>
          <template v-if="batchExecutionActive">
            <Button variant="outline" size="sm" @click="handleOpenChange(false)">
              {{ t("sqlFile.runInBackground") }}
            </Button>
            <Button variant="destructive" size="sm" :disabled="webBatch.cancelling.value" @click="stopWebBatch">
              <Loader2 v-if="webBatch.cancelling.value" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              <X v-else class="mr-1.5 h-3.5 w-3.5" />
              {{ t("sqlFile.stopBatch") }}
            </Button>
          </template>
          <template v-else>
            <Button variant="outline" size="sm" @click="handleOpenChange(false)">
              {{ t("common.close") }}
            </Button>
            <Button size="sm" :disabled="!canStart" @click="startWebBatchExecution">
              <Play class="mr-1.5 h-3.5 w-3.5" />
              {{ t("sqlFile.execute") }}
            </Button>
          </template>
        </template>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
