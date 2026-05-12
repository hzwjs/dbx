<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { buildTableSelectSql, qualifiedTableName } from "@/lib/tableSelectSql";
import {
  compareDataRows,
  generateDataSyncSql,
  generateDataSyncStatements,
  type DataCompareResult,
} from "@/lib/dataCompare";
import * as api from "@/lib/api";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { Copy, GitCompareArrows, Loader2, Play, ArrowLeftRight } from "lucide-vue-next";

const { t } = useI18n();
const { toast } = useToast();
const store = useConnectionStore();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceSchema = ref("");
const sourceTable = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const sourceTables = ref<string[]>([]);

const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetSchema = ref("");
const targetTable = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const targetTables = ref<string[]>([]);

const keyColumnsText = ref("");
const rowLimit = ref("1000");
const sourceRowCount = ref<number | null>(null);
const targetRowCount = ref<number | null>(null);
const result = ref<DataCompareResult | null>(null);
const syncSql = ref("");
const syncStatements = ref<string[]>([]);
const comparing = ref(false);
const executing = ref(false);
const executedCount = ref(0);
const executeTotal = ref(0);
const syncErrors = ref<{ sql: string; error: string }[]>([]);
const rowLimitOptions = [1000, 5000, 10000, 50000];

const sqlConnections = computed(() =>
  store.connections.filter((connection) => !["redis", "mongodb", "elasticsearch"].includes(connection.db_type)),
);
const canCompare = computed(
  () =>
    sourceConnectionId.value &&
    sourceDatabase.value &&
    sourceSchema.value &&
    sourceTable.value &&
    targetConnectionId.value &&
    targetDatabase.value &&
    targetSchema.value &&
    targetTable.value,
);
const keyColumns = computed(() =>
  keyColumnsText.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const summary = computed(() => {
  const diff = result.value;
  if (!diff) return "";
  return t("dataCompare.summary", {
    added: diff.added.length,
    removed: diff.removed.length,
    modified: diff.modified.length,
  });
});
const rowLimitNumber = computed(() => Number(rowLimit.value) || 1000);
const isSourceTruncated = computed(() => sourceRowCount.value !== null && sourceRowCount.value > rowLimitNumber.value);
const isTargetTruncated = computed(() => targetRowCount.value !== null && targetRowCount.value > rowLimitNumber.value);

function connectionIconType(connectionId: string) {
  const config = store.getConfig(connectionId);
  return config?.driver_profile || config?.db_type || "mysql";
}

function swapSourceTarget() {
  const tmpConnId = sourceConnectionId.value;
  const tmpDb = sourceDatabase.value;
  const tmpDbs = sourceDatabases.value;
  const tmpSchema = sourceSchema.value;
  const tmpSchemas = sourceSchemas.value;
  const tmpTable = sourceTable.value;
  const tmpTables = sourceTables.value;
  sourceConnectionId.value = targetConnectionId.value;
  sourceDatabase.value = targetDatabase.value;
  sourceDatabases.value = targetDatabases.value;
  sourceSchema.value = targetSchema.value;
  sourceSchemas.value = targetSchemas.value;
  sourceTable.value = targetTable.value;
  sourceTables.value = targetTables.value;
  targetConnectionId.value = tmpConnId;
  targetDatabase.value = tmpDb;
  targetDatabases.value = tmpDbs;
  targetSchema.value = tmpSchema;
  targetSchemas.value = tmpSchemas;
  targetTable.value = tmpTable;
  targetTables.value = tmpTables;
  clearResult();
}

async function resolveSchema(connectionId: string, database: string, preferredSchema = ""): Promise<string> {
  const config = store.getConfig(connectionId);
  if (isSchemaAware(config?.db_type)) {
    const schemas = await api.listSchemas(connectionId, database);
    if (preferredSchema && schemas.includes(preferredSchema)) return preferredSchema;
    return schemas.includes("public") ? "public" : (schemas[0] ?? "");
  }
  return database;
}

async function loadSchemas(side: "source" | "target", preferredSchema = "") {
  const connectionId = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
  const database = side === "source" ? sourceDatabase.value : targetDatabase.value;
  if (!connectionId || !database) return;
  const config = store.getConfig(connectionId);
  if (!isSchemaAware(config?.db_type)) {
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else {
      targetSchemas.value = [];
      targetSchema.value = database;
    }
    await loadTables(side);
    return;
  }

  const schemas = await api.listSchemas(connectionId, database);
  const schema =
    preferredSchema && schemas.includes(preferredSchema)
      ? preferredSchema
      : schemas.includes("public")
        ? "public"
        : (schemas[0] ?? "");
  if (side === "source") {
    sourceSchemas.value = schemas;
    sourceSchema.value = schema;
  } else {
    targetSchemas.value = schemas;
    targetSchema.value = schema;
  }
}

async function loadDatabases(connectionId: string, side: "source" | "target") {
  if (!connectionId) return;
  await store.ensureConnected(connectionId);
  const names = (await api.listDatabases(connectionId)).map((database) => database.name);
  if (side === "source") {
    sourceDatabases.value = names;
    sourceDatabase.value = names.length === 1 ? names[0] : "";
    sourceSchemas.value = [];
    sourceSchema.value = "";
    sourceTables.value = [];
    sourceTable.value = "";
  } else {
    targetDatabases.value = names;
    targetDatabase.value = names.length === 1 ? names[0] : "";
    targetSchemas.value = [];
    targetSchema.value = "";
    targetTables.value = [];
    targetTable.value = "";
  }
}

async function loadTables(side: "source" | "target") {
  const connectionId = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
  const database = side === "source" ? sourceDatabase.value : targetDatabase.value;
  if (!connectionId || !database) return;
  const schema =
    side === "source"
      ? sourceSchema.value || (await resolveSchema(connectionId, database, props.prefillSchema))
      : targetSchema.value || (await resolveSchema(connectionId, database));
  const tables = (await api.listTables(connectionId, database, schema))
    .filter((table) => table.table_type !== "VIEW")
    .map((table) => table.name);
  if (side === "source") {
    sourceSchema.value = schema;
    sourceTables.value = tables;
    const preferred =
      props.prefillTable && tables.includes(props.prefillTable) ? props.prefillTable : sourceTable.value;
    sourceTable.value = tables.includes(preferred) ? preferred : "";
  } else {
    targetSchema.value = schema;
    targetTables.value = tables;
    const preferred = sourceTable.value && tables.includes(sourceTable.value) ? sourceTable.value : targetTable.value;
    targetTable.value = tables.includes(preferred) ? preferred : "";
  }
}

function clearResult() {
  result.value = null;
  syncSql.value = "";
  syncStatements.value = [];
  sourceRowCount.value = null;
  targetRowCount.value = null;
}

async function countTableRows(connectionId: string, database: string, schema: string, tableName: string) {
  const config = store.getConfig(connectionId);
  const table = qualifiedTableName({ databaseType: config?.db_type, schema, tableName });
  const result = await api.executeQuery(connectionId, database, `SELECT COUNT(*) AS row_count FROM ${table}`, schema);
  return Number(result.rows[0]?.[0] ?? 0);
}

async function inferKeyColumns() {
  if (!sourceConnectionId.value || !sourceDatabase.value || !sourceTable.value) return;
  const columns = await api.getColumns(
    sourceConnectionId.value,
    sourceDatabase.value,
    sourceSchema.value,
    sourceTable.value,
  );
  const primaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  keyColumnsText.value = (primaryKeys.length ? primaryKeys : columns.slice(0, 1).map((column) => column.name)).join(
    ", ",
  );
}

async function startCompare() {
  if (!canCompare.value || comparing.value) return;
  comparing.value = true;
  clearResult();
  try {
    await Promise.all([
      store.ensureConnected(sourceConnectionId.value),
      store.ensureConnected(targetConnectionId.value),
    ]);
    if (keyColumns.value.length === 0) await inferKeyColumns();
    if (keyColumns.value.length === 0) throw new Error(t("dataCompare.noKeyColumns"));

    const sourceConfig = store.getConfig(sourceConnectionId.value);
    const targetConfig = store.getConfig(targetConnectionId.value);
    const sourceColumns = await api.getColumns(
      sourceConnectionId.value,
      sourceDatabase.value,
      sourceSchema.value,
      sourceTable.value,
    );
    const targetColumns = await api.getColumns(
      targetConnectionId.value,
      targetDatabase.value,
      targetSchema.value,
      targetTable.value,
    );
    const columns = sourceColumns
      .map((column) => column.name)
      .filter((column) => targetColumns.some((target) => target.name === column));
    const missingKeys = keyColumns.value.filter((column) => !columns.includes(column));
    if (missingKeys.length > 0) {
      throw new Error(t("dataCompare.missingKeyColumns", { columns: missingKeys.join(", ") }));
    }
    if (columns.length === 0) throw new Error(t("dataCompare.noCommonColumns"));
    const [srcCount, tgtCount] = await Promise.all([
      countTableRows(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, sourceTable.value),
      countTableRows(targetConnectionId.value, targetDatabase.value, targetSchema.value, targetTable.value),
    ]);
    sourceRowCount.value = srcCount;
    targetRowCount.value = tgtCount;

    const sourceSql = buildTableSelectSql({
      databaseType: sourceConfig?.db_type,
      schema: sourceSchema.value,
      tableName: sourceTable.value,
      primaryKeys: keyColumns.value,
      limit: rowLimitNumber.value,
    });
    const targetSql = buildTableSelectSql({
      databaseType: targetConfig?.db_type,
      schema: targetSchema.value,
      tableName: targetTable.value,
      primaryKeys: keyColumns.value,
      limit: rowLimitNumber.value,
    });
    const [sourceResult, targetResult] = await Promise.all([
      api.executeQuery(sourceConnectionId.value, sourceDatabase.value, sourceSql, sourceSchema.value),
      api.executeQuery(targetConnectionId.value, targetDatabase.value, targetSql, targetSchema.value),
    ]);
    const diff = compareDataRows({
      columns,
      keyColumns: keyColumns.value,
      sourceRows: sourceResult.rows,
      targetRows: targetResult.rows,
    });
    result.value = diff;
    const syncOptions = {
      tableName: targetTable.value,
      schema: targetSchema.value,
      columns,
      keyColumns: keyColumns.value,
      diff,
      databaseType: targetConfig?.db_type,
    };
    syncStatements.value = generateDataSyncStatements(syncOptions);
    syncSql.value = generateDataSyncSql(syncOptions);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    comparing.value = false;
  }
}

async function copySql() {
  await navigator.clipboard.writeText(syncSql.value);
  toast(t("grid.copied"));
}

async function executeSql() {
  if (!syncSql.value.trim() || syncStatements.value.length === 0 || executing.value) return;
  executing.value = true;
  syncErrors.value = [];
  executeTotal.value = syncStatements.value.length;
  executedCount.value = 0;
  try {
    await store.ensureConnected(targetConnectionId.value);
    for (const stmt of syncStatements.value) {
      try {
        await api.executeQuery(targetConnectionId.value, targetDatabase.value, stmt, targetSchema.value);
      } catch (e: any) {
        syncErrors.value.push({ sql: stmt, error: e?.message || String(e) });
      }
      executedCount.value++;
    }
    const failed = syncErrors.value.length;
    if (failed === 0) {
      toast(t("dataCompare.syncSuccess"), 2000);
    } else {
      toast(t("diff.syncSummary", { success: syncStatements.value.length - failed, failed }), 5000);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    executing.value = false;
  }
}

watch(sourceConnectionId, (id) => {
  clearResult();
  sourceDatabase.value = "";
  sourceSchema.value = "";
  sourceSchemas.value = [];
  sourceTables.value = [];
  loadDatabases(id, "source").catch((e) => toast(String(e), 5000));
});
watch(targetConnectionId, (id) => {
  clearResult();
  targetDatabase.value = "";
  targetSchema.value = "";
  targetSchemas.value = [];
  targetTables.value = [];
  loadDatabases(id, "target").catch((e) => toast(String(e), 5000));
});
watch(sourceDatabase, () => {
  clearResult();
  sourceSchema.value = "";
  sourceSchemas.value = [];
  sourceTables.value = [];
  sourceTable.value = "";
  loadSchemas("source", props.prefillSchema).catch((e) => toast(String(e), 5000));
});
watch(targetDatabase, () => {
  clearResult();
  targetSchema.value = "";
  targetSchemas.value = [];
  targetTables.value = [];
  targetTable.value = "";
  loadSchemas("target").catch((e) => toast(String(e), 5000));
});
watch(sourceSchema, () => {
  clearResult();
  sourceTables.value = [];
  sourceTable.value = "";
  if (sourceSchema.value) loadTables("source").catch((e) => toast(String(e), 5000));
});
watch(targetSchema, () => {
  clearResult();
  targetTables.value = [];
  targetTable.value = "";
  if (targetSchema.value) loadTables("target").catch((e) => toast(String(e), 5000));
});
watch(sourceTable, (table, previous) => {
  clearResult();
  if (table !== previous) keyColumnsText.value = "";
  if (table && targetTables.value.includes(table)) targetTable.value = table;
  if (sourceTable.value) {
    inferKeyColumns().catch(() => {});
  }
});
watch(targetTable, () => clearResult());
watch(open, async (value) => {
  if (!value) return;
  result.value = null;
  syncSql.value = "";
  if (props.prefillConnectionId) {
    sourceConnectionId.value = props.prefillConnectionId;
    await loadDatabases(props.prefillConnectionId, "source");
    if (props.prefillDatabase) sourceDatabase.value = props.prefillDatabase;
    if (props.prefillDatabase) await loadSchemas("source", props.prefillSchema);
    if (props.prefillTable) {
      await loadTables("source");
      if (sourceTables.value.includes(props.prefillTable)) sourceTable.value = props.prefillTable;
    }
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitCompareArrows class="w-4 h-4" />
          {{ t("dataCompare.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto space-y-4 py-2">
        <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t("diff.source") }}</Label>
            <Select
              :model-value="sourceConnectionId"
              @update:model-value="(v: any) => (sourceConnectionId = String(v))"
            >
              <SelectTrigger class="h-8 text-xs">
                <div class="flex items-center gap-2">
                  <DatabaseIcon
                    v-if="sourceConnectionId"
                    :db-type="connectionIconType(sourceConnectionId)"
                    class="w-3.5 h-3.5"
                  />
                  <SelectValue :placeholder="t('diff.selectConnection')" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">
                  {{ connection.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select :model-value="sourceDatabase" @update:model-value="(v: any) => (sourceDatabase = String(v))">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('diff.selectDatabase')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="database in sourceDatabases" :key="database" :value="database">{{
                  database
                }}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              v-if="sourceSchemas.length"
              :model-value="sourceSchema"
              @update:model-value="(v: any) => (sourceSchema = String(v))"
            >
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('diff.selectSchema')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="schema in sourceSchemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
              </SelectContent>
            </Select>
            <Select :model-value="sourceTable" @update:model-value="(v: any) => (sourceTable = String(v))">
              <SelectTrigger class="h-8 text-xs"
                ><SelectValue :placeholder="t('dataCompare.selectTable')"
              /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="table in sourceTables" :key="table" :value="table">{{ table }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center pt-6">
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('diff.swap')" @click="swapSourceTarget">
              <ArrowLeftRight class="w-3.5 h-3.5" />
            </Button>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t("diff.target") }}</Label>
            <Select
              :model-value="targetConnectionId"
              @update:model-value="(v: any) => (targetConnectionId = String(v))"
            >
              <SelectTrigger class="h-8 text-xs">
                <div class="flex items-center gap-2">
                  <DatabaseIcon
                    v-if="targetConnectionId"
                    :db-type="connectionIconType(targetConnectionId)"
                    class="w-3.5 h-3.5"
                  />
                  <SelectValue :placeholder="t('diff.selectConnection')" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="connection in sqlConnections" :key="connection.id" :value="connection.id">
                  {{ connection.name }}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select :model-value="targetDatabase" @update:model-value="(v: any) => (targetDatabase = String(v))">
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('diff.selectDatabase')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="database in targetDatabases" :key="database" :value="database">{{
                  database
                }}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              v-if="targetSchemas.length"
              :model-value="targetSchema"
              @update:model-value="(v: any) => (targetSchema = String(v))"
            >
              <SelectTrigger class="h-8 text-xs"><SelectValue :placeholder="t('diff.selectSchema')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="schema in targetSchemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
              </SelectContent>
            </Select>
            <Select :model-value="targetTable" @update:model-value="(v: any) => (targetTable = String(v))">
              <SelectTrigger class="h-8 text-xs"
                ><SelectValue :placeholder="t('dataCompare.selectTable')"
              /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="table in targetTables" :key="table" :value="table">{{ table }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="space-y-1">
          <Label class="text-xs font-medium">{{ t("dataCompare.keyColumns") }}</Label>
          <input
            v-model="keyColumnsText"
            class="h-8 w-full rounded-md border bg-background px-2 text-xs"
            :placeholder="t('dataCompare.keyColumnsPlaceholder')"
          />
        </div>

        <div class="space-y-1">
          <Label class="text-xs font-medium">{{ t("dataCompare.rowLimit") }}</Label>
          <Select v-model="rowLimit">
            <SelectTrigger class="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="limit in rowLimitOptions" :key="limit" :value="String(limit)">
                {{ t("dataCompare.rowLimitOption", { count: limit }) }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" :disabled="!canCompare || comparing" @click="startCompare">
          <Loader2 v-if="comparing" class="w-3.5 h-3.5 animate-spin mr-1" />
          <GitCompareArrows v-else class="w-3.5 h-3.5 mr-1" />
          {{ t("dataCompare.compare") }}
        </Button>

        <div v-if="result" class="rounded-lg border p-3 text-sm">
          {{ summary }}
          <div v-if="sourceRowCount !== null && targetRowCount !== null" class="mt-1 text-xs text-muted-foreground">
            {{
              t("dataCompare.rowCounts", {
                source: sourceRowCount,
                target: targetRowCount,
                limit: rowLimitNumber,
              })
            }}
          </div>
          <div v-if="isSourceTruncated || isTargetTruncated" class="mt-1 text-xs text-yellow-600">
            {{ t("dataCompare.truncatedWarning") }}
          </div>
        </div>

        <div v-if="result && syncSql.trim()" class="space-y-1">
          <Label class="text-xs font-medium">{{ t("diff.generatedSql") }}</Label>
          <textarea
            v-model="syncSql"
            class="w-full h-48 rounded-lg border bg-muted/20 p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div v-else-if="result" class="text-sm text-muted-foreground">
          {{ t("dataCompare.noDifferences") }}
        </div>

        <!-- Sync Errors -->
        <div v-if="syncErrors.length > 0" class="space-y-1">
          <Label class="text-xs font-medium text-destructive">
            {{ t("diff.syncSummary", { success: executeTotal - syncErrors.length, failed: syncErrors.length }) }}
          </Label>
          <div class="max-h-32 overflow-auto border rounded-lg bg-destructive/5 p-2 space-y-1">
            <div v-for="(err, i) in syncErrors" :key="i" class="text-xs font-mono">
              <span class="text-destructive">{{ err.error }}</span>
              <span class="text-muted-foreground ml-1"
                >— {{ err.sql.slice(0, 80) }}{{ err.sql.length > 80 ? "..." : "" }}</span
              >
            </div>
          </div>
        </div>
      </div>

      <DialogFooter v-if="result && syncSql.trim()" class="flex items-center gap-2">
        <span v-if="executing" class="text-xs text-muted-foreground mr-auto">
          {{ t("diff.syncProgress", { current: executedCount, total: executeTotal }) }}
        </span>
        <Button variant="outline" size="sm" @click="copySql">
          <Copy class="w-3 h-3 mr-1" /> {{ t("diff.copySql") }}
        </Button>
        <Button size="sm" :disabled="executing || syncStatements.length === 0" @click="executeSql">
          <Loader2 v-if="executing" class="w-3 h-3 animate-spin mr-1" />
          <Play v-else class="w-3 h-3 mr-1" />
          {{ t("diff.executeSync") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
