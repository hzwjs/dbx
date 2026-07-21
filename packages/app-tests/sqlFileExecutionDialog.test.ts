import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

const dialogPath = "apps/desktop/src/components/sql-file/SqlFileExecutionDialog.vue";
const dialogSource = readFileSync(dialogPath, "utf8");
const trackerSource = readFileSync("apps/desktop/src/composables/useExportTracker.ts", "utf8");
const englishSource = readFileSync("apps/desktop/src/i18n/locales/en.ts", "utf8");
const simplifiedChineseSource = readFileSync("apps/desktop/src/i18n/locales/zh-CN.ts", "utf8");

test("SQL file execution dialog SFC compiles", () => {
  const { descriptor, errors } = parse(dialogSource, { filename: dialogPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup);
  compileScript(descriptor, { id: dialogPath });
  assert.ok(descriptor.template);
  const result = compileTemplate({ id: dialogPath, filename: dialogPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
});

test("SQL file execution dialog keeps actions visible within narrow viewports", () => {
  assert.match(dialogSource, /DialogScrollContent class="[^"]*max-h-\[calc\(100dvh-6rem\)\][^"]*flex-col[^"]*overflow-hidden/);
  assert.match(dialogSource, /<DialogHeader class="shrink-0">/);
  assert.match(dialogSource, /class="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto py-3"/);
  assert.match(dialogSource, /class="grid grid-cols-1 gap-3 sm:grid-cols-2"/);
  assert.match(dialogSource, /<DialogFooter class="shrink-0">/);
});

test("SQL file execution dialog preserves cancel, close, and retry actions", () => {
  assert.match(dialogSource, /<template v-if="batchExecutionActive">[\s\S]*@click="handleOpenChange\(false\)"[\s\S]*@click="stopWebBatch"/);
  assert.match(dialogSource, /<template v-else>[\s\S]*@click="handleOpenChange\(false\)"[\s\S]*:disabled="!canStart" @click="startWebBatchExecution"/);
  assert.match(dialogSource, /async function stopWebBatch\(\)[\s\S]*await webBatch\.cancel\(\)/);
});

test("desktop SQL file execution renders ordered multi-target controls and batch actions", () => {
  assert.match(dialogSource, /const selectedConnectionIds = ref<string\[\]>\(\[\]\)/);
  assert.match(dialogSource, /<Popover>/);
  assert.match(dialogSource, /v-for="c in sameTypeSqlConnections"/);
  assert.match(dialogSource, /@click="toggleTargetSelection\(c\.id\)"/);
  assert.match(dialogSource, /:aria-pressed="selectedConnectionIds\.includes\(c\.id\)"/);
  assert.match(dialogSource, /t\("sqlFile\.selectedCount", \{ count: selectedConnectionIds\.length \}\)/);
  assert.match(dialogSource, /v-for="target in displayedBatchTargets"/);
  assert.match(dialogSource, /const batchDatabase = ref\(""\)/);
  assert.match(dialogSource, /batchDatabase\.value = database\.value\.trim\(\)/);
  assert.match(dialogSource, /@click="toggleTargetExpanded\(target\.executionId\)"/);
  assert.match(dialogSource, /:aria-expanded="isTargetExpanded\(target\.executionId\)"/);
  assert.match(dialogSource, /:aria-controls="`sql-file-target-details-\$\{target\.executionId\}`"/);
  assert.match(dialogSource, /:id="`sql-file-target-details-\$\{target\.executionId\}`"/);
  assert.match(dialogSource, /target\.failures/);
  assert.match(dialogSource, /decideSqlFileBatchDialogClose/);
  assert.match(dialogSource, /decideSqlFileBatchDialogOpen/);
  assert.match(dialogSource, /function handleOpenChange\(nextOpen: boolean\)[\s\S]*decideSqlFileBatchDialogClose\(batchDialogSession\.value, isDesktop, batchRunning\.value\)/);
  assert.match(dialogSource, /<Dialog :open="open" @update:open="handleOpenChange">/);
  assert.match(dialogSource, /@click="handleOpenChange\(false\)"[\s\S]*t\("sqlFile\.runInBackground"\)/);
  assert.match(dialogSource, /<template v-if="isDesktop">[\s\S]*@click="stopBatch"[\s\S]*@click="startBatchExecution"/);
});

test("desktop targets are limited to the fixed baseline database type", () => {
  assert.match(dialogSource, /const baselineConnectionId = ref\(""\)/);
  assert.match(dialogSource, /const baselineConnection = computed/);
  assert.match(dialogSource, /const sameTypeSqlConnections = computed/);
  assert.match(dialogSource, /const baselineDbType = baselineConnection\.value\?\.db_type/);
  assert.match(dialogSource, /connection\.db_type === baselineDbType/);
  assert.match(dialogSource, /selectedConnectionIds\.value = initialConnectionId \? \[initialConnectionId\] : \[\]/);
  assert.match(dialogSource, /loadDatabasesForConnection\(baselineConnectionId\.value\)/);
});

test("Web uses the shared server batch execution path", () => {
  assert.match(dialogSource, /useWebSqlFileBatchExecution/);
  assert.match(dialogSource, /createSqlFileBatch/);
  assert.match(dialogSource, /listSqlFileBatches/);
  assert.match(dialogSource, /listenSqlFileBatch/);
  assert.match(dialogSource, /selectedConnectionIds/);
  assert.match(dialogSource, /webBatch\.start/);
  assert.match(dialogSource, /webBatch\.cancel/);
  assert.match(dialogSource, /webBatch\.load/);
  assert.match(dialogSource, /for \(const targetConnectionId of selectedConnectionIds\.value\)/);
  assert.match(dialogSource, /await prepareBatchTarget\(targetConnectionId, database\.value\.trim\(\)\)/);
  assert.match(dialogSource, /if \(!isDesktop\) webBatch\.disconnect\(\)/);
  assert.match(dialogSource, /watch\(\s*open,\s*\(value\) => \{\s*if \(!value\) \{\s*if \(!isDesktop\) webBatch\.disconnect\(\)/);
  assert.match(dialogSource, /webBatch\.batches\.value\.length > 1/);
  assert.match(dialogSource, /target\.status === "success" \|\| target\.status === "partial"/);
  assert.doesNotMatch(dialogSource, /listenSqlFileProgressById/);
  assert.doesNotMatch(dialogSource, /async function startExecution\(/);
  assert.doesNotMatch(dialogSource, /async function cancelExecution\(/);
});

test("desktop batch runtime delegates existing APIs and tracks target metadata", () => {
  assert.match(dialogSource, /useSqlFileBatchExecution\(/);
  assert.match(dialogSource, /prepareTarget: prepareBatchTarget/);
  assert.match(dialogSource, /listen: \(_executionId, handler\) => listenSqlFileProgress\(handler\)/);
  assert.match(dialogSource, /execute: executeSqlFile/);
  assert.match(dialogSource, /cancel: cancelSqlFileExecution/);
  assert.match(dialogSource, /addSqlFileTask\(executionId, fileName, taskFilePath, targetConnectionId, targetDatabase\)/);
  assert.match(dialogSource, /refreshDatabaseTreeNode\(targetConnectionId, targetDatabase\.trim\(\)\)/);

  assert.match(trackerSource, /function addSqlFileTask\(executionId: string, fileName: string, filePath: string, connectionId\?: string, database\?: string\)/);
  assert.match(trackerSource, /targetConnectionId: connectionId/);
  assert.match(trackerSource, /targetDatabase: database/);
});

test("batch SQL file labels include the required English and Simplified Chinese copy", () => {
  assert.match(englishSource, /selectedCount: "\{count\} selected"/);
  assert.match(englishSource, /batchProgress: "\{completed\} of \{total\} targets complete"/);
  assert.match(englishSource, /partialSuccess: "Partially succeeded"/);
  assert.match(englishSource, /pending: "Pending"/);
  assert.match(englishSource, /skipped: "Skipped"/);
  assert.match(englishSource, /failureDetails: "Statement failures"/);
  assert.match(englishSource, /runInBackground: "Run in Background"/);
  assert.match(englishSource, /stopBatch: "Stop Batch"/);
  assert.match(englishSource, /sharedBatches: "Shared batches"/);
  assert.match(englishSource, /selectBatch: "Select batch"/);
  assert.match(englishSource, /cancelling: "Cancelling"/);
  assert.match(englishSource, /completed: "Completed"/);

  assert.match(simplifiedChineseSource, /selectedCount: "已选择 \{count\} 个"/);
  assert.match(simplifiedChineseSource, /batchProgress: "已完成 \{completed\}\/\{total\} 个目标"/);
  assert.match(simplifiedChineseSource, /partialSuccess: "部分成功"/);
  assert.match(simplifiedChineseSource, /pending: "等待执行"/);
  assert.match(simplifiedChineseSource, /skipped: "已跳过"/);
  assert.match(simplifiedChineseSource, /failureDetails: "语句失败详情"/);
  assert.match(simplifiedChineseSource, /runInBackground: "后台运行"/);
  assert.match(simplifiedChineseSource, /stopBatch: "停止批量执行"/);
  assert.match(simplifiedChineseSource, /sharedBatches: "共享批次"/);
  assert.match(simplifiedChineseSource, /selectBatch: "选择批次"/);
  assert.match(simplifiedChineseSource, /cancelling: "正在取消"/);
  assert.match(simplifiedChineseSource, /completed: "已完成"/);
});
