// @vitest-environment happy-dom

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import SqlFileExecutionDialog from "@/components/sql-file/SqlFileExecutionDialog.vue";
import type { CreateWebSqlFileBatchRequest, WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

const behaviorMocks = vi.hoisted(() => ({
  runtime: undefined as any,
  productionActive: true,
  requestConfirmation: vi.fn(),
  ensureConnected: vi.fn(async () => {}),
  refreshDatabaseTreeNode: vi.fn(async () => {}),
  toast: vi.fn(),
  preview: {
    fileName: "seed.sql",
    filePath: "uploaded://seed.sql",
    sizeBytes: 32,
    preview: "select 1;",
    canExecuteWithoutSelectedDatabase: true,
  },
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [
      { id: "connection-a", name: "Connection A", db_type: "sqlite" },
      { id: "connection-b", name: "Connection B", db_type: "sqlite" },
    ],
    ensureConnected: behaviorMocks.ensureConnected,
    refreshDatabaseTreeNode: behaviorMocks.refreshDatabaseTreeNode,
    getConfig: (id: string) => ({ id, db_type: "sqlite", database: "" }),
  }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({ requestConfirmation: behaviorMocks.requestConfirmation }) }));
vi.mock("@/lib/database/productionSafety", () => ({ productionContextForDatabase: () => ({ active: behaviorMocks.productionActive, databases: ["app"] }) }));
vi.mock("@/lib/backend/api", () => ({
  cancelSqlFileExecution: vi.fn(),
  executeSqlFile: vi.fn(),
  listenSqlFileProgress: vi.fn(async () => () => {}),
  listDatabases: vi.fn(async () => []),
  previewSqlFile: vi.fn(),
}));
vi.mock("@/lib/backend/http", () => ({
  previewSqlFile: vi.fn(async () => behaviorMocks.preview),
  createSqlFileBatch: (request: CreateWebSqlFileBatchRequest) => behaviorMocks.runtime.create(request),
  listSqlFileBatches: () => behaviorMocks.runtime.list(),
  getSqlFileBatch: (batchId: string) => behaviorMocks.runtime.get(batchId),
  cancelSqlFileBatch: (batchId: string) => behaviorMocks.runtime.cancel(batchId),
}));
vi.mock("@/lib/sql/httpSqlFileBatch", () => ({ listenSqlFileBatch: (batchId: string, handler: (snapshot: WebSqlFileBatchSnapshot) => void) => behaviorMocks.runtime.listen(batchId, handler) }));
vi.mock("@/composables/useDatabaseOptions", () => ({ databaseOptionsForConnection: (names: string[]) => names }));
vi.mock("@/lib/connection/connectionLevelDatabaseBootstrap", () => ({ requiresSqlFileTargetDatabaseSelection: () => false }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => ({ addSqlFileTask: vi.fn(), updateSqlFileTask: vi.fn() }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: behaviorMocks.toast }) }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/components/connection/ConnectionGroupBadge.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ name: "ConnectionGroupBadge", setup: () => () => h("span") }) };
});

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
  assert.match(dialogSource, /for \(const targetConnectionId of connectionIds\)/);
  assert.match(dialogSource, /await prepareBatchTarget\(targetConnectionId, targetDatabase, previewSql\)/);
  assert.match(dialogSource, /if \(!isDesktop\) webBatch\.disconnect\(\)/);
  assert.match(dialogSource, /watch\(\s*open,\s*\(value\) => \{\s*if \(!value\) \{\s*if \(!isDesktop\) webBatch\.disconnect\(\)/);
  assert.match(dialogSource, /webBatch\.batches\.value\.length > 1/);
  assert.match(dialogSource, /target\.status === "success" \|\| target\.status === "partial"/);
  assert.doesNotMatch(dialogSource, /listenSqlFileProgressById/);
  assert.doesNotMatch(dialogSource, /async function startExecution\(/);
  assert.doesNotMatch(dialogSource, /async function cancelExecution\(/);
});

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

function webSnapshot(batchId: string): WebSqlFileBatchSnapshot {
  return {
    batchId,
    fileName: "seed.sql",
    database: "app",
    continueOnError: false,
    status: "running",
    createdAtMs: 1,
    updatedAtMs: 1,
    targets: [],
    summary: { success: 0, partial: 0, failed: 0, cancelled: 0, skipped: 0 },
  };
}

class DeferredWebBatchRuntime {
  listQueue: Promise<WebSqlFileBatchSnapshot[]>[] = [];
  createQueue: Promise<WebSqlFileBatchSnapshot>[] = [];
  createdRequests: CreateWebSqlFileBatchRequest[] = [];
  activeSubscriptions = new Map<number, string>();
  closes = 0;
  nextSubscription = 0;

  async create(request: CreateWebSqlFileBatchRequest) {
    this.createdRequests.push({ ...request, connectionIds: [...request.connectionIds] });
    return (this.createQueue.shift() ?? Promise.resolve(webSnapshot(`created-${this.createdRequests.length}`))) as Promise<WebSqlFileBatchSnapshot>;
  }

  async list() {
    return (this.listQueue.shift() ?? Promise.resolve([])) as Promise<WebSqlFileBatchSnapshot[]>;
  }

  async get(batchId: string) {
    return webSnapshot(batchId);
  }

  async cancel() {
    return true;
  }

  listen(batchId: string) {
    const subscription = ++this.nextSubscription;
    this.activeSubscriptions.set(subscription, batchId);
    return () => {
      if (this.activeSubscriptions.delete(subscription)) this.closes += 1;
    };
  }
}

const mountedApps: App[] = [];

async function flushBehavior(rounds = 2) {
  for (let index = 0; index < rounds; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountWebDialog(runtime: DeferredWebBatchRuntime, prefillFile = false) {
  behaviorMocks.runtime = runtime;
  const state = reactive({ open: true });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(SqlFileExecutionDialog, {
          open: state.open,
          prefillConnectionId: "connection-a",
          prefillFilePath: prefillFile ? "seed.sql" : undefined,
          "onUpdate:open": (value: boolean) => {
            state.open = value;
          },
        }),
    }),
  );
  app.provide("sqlFileWebBatchRuntime", runtime);
  mountedApps.push(app);
  app.mount(container);
  await flushBehavior(3);
  return { app, state };
}

function buttonWithText(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

async function selectSecondTarget() {
  buttonWithText("sqlFile.selectedCount")?.click();
  await flushBehavior();
  const target = buttonWithText("Connection B");
  expect(target).toBeDefined();
  target?.click();
  await flushBehavior();
  return target;
}

function databaseInput() {
  return Array.from(document.body.querySelectorAll("input")).find((input) => input.type !== "file" && !input.readOnly) as HTMLInputElement | undefined;
}

async function setDatabase(value: string) {
  const input = databaseInput();
  expect(input).toBeDefined();
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flushBehavior();
}

beforeEach(() => {
  behaviorMocks.productionActive = true;
  behaviorMocks.runtime = undefined;
  behaviorMocks.requestConfirmation.mockReset();
  behaviorMocks.requestConfirmation.mockResolvedValue(true);
  behaviorMocks.ensureConnected.mockClear();
  behaviorMocks.refreshDatabaseTreeNode.mockClear();
  behaviorMocks.toast.mockClear();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

test("closing while Web batch load is pending disconnects the late subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const load = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(load.promise);
  const { state } = await mountWebDialog(runtime);

  state.open = false;
  await flushBehavior();
  load.resolve([webSnapshot("late-load")]);
  await flushBehavior(3);

  expect(runtime.activeSubscriptions.size).toBe(0);
  expect(runtime.closes).toBe(1);
});

test("unmounting the Web dialog disconnects its EventSource subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  runtime.listQueue.push(Promise.resolve([webSnapshot("mounted-batch")]));
  const { app } = await mountWebDialog(runtime);
  expect([...runtime.activeSubscriptions.values()]).toEqual(["mounted-batch"]);

  app.unmount();
  mountedApps.splice(mountedApps.indexOf(app), 1);

  expect(runtime.activeSubscriptions.size).toBe(0);
  expect(runtime.closes).toBe(1);
});

test("unmounting while Web batch load is pending prevents a late subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const load = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(load.promise);
  const { app } = await mountWebDialog(runtime);

  app.unmount();
  mountedApps.splice(mountedApps.indexOf(app), 1);
  load.resolve([webSnapshot("late-after-unmount")]);
  await flushBehavior(3);

  expect(runtime.activeSubscriptions.size).toBe(0);
});

test("unmounting while Web batch start is pending prevents a late subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const created = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.createQueue.push(created.promise);
  behaviorMocks.productionActive = false;
  const { app } = await mountWebDialog(runtime, true);

  buttonWithText("sqlFile.execute")?.click();
  await flushBehavior();
  expect(runtime.createdRequests).toHaveLength(1);
  app.unmount();
  mountedApps.splice(mountedApps.indexOf(app), 1);
  created.resolve(webSnapshot("late-start-after-unmount"));
  await flushBehavior(3);

  expect(runtime.activeSubscriptions.size).toBe(0);
});

test("closing while Web batch start is pending disconnects the late subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const created = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.createQueue.push(created.promise);
  behaviorMocks.productionActive = false;
  const { state } = await mountWebDialog(runtime, true);

  buttonWithText("sqlFile.execute")?.click();
  await flushBehavior();
  expect(runtime.createdRequests).toHaveLength(1);
  state.open = false;
  await flushBehavior();
  created.resolve(webSnapshot("late-start"));
  await flushBehavior(3);

  expect(runtime.activeSubscriptions.size).toBe(0);
  expect(runtime.closes).toBe(1);
});

test("reopening before an old load completes preserves the new subscription", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const oldLoad = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(oldLoad.promise, Promise.resolve([webSnapshot("reopened")]));
  const { state } = await mountWebDialog(runtime);

  state.open = false;
  await flushBehavior();
  state.open = true;
  await flushBehavior(3);
  expect([...runtime.activeSubscriptions.values()]).toEqual(["reopened"]);
  const closesBeforeOldLoad = runtime.closes;

  oldLoad.resolve([webSnapshot("stale")]);
  await flushBehavior(3);

  expect([...runtime.activeSubscriptions.values()]).toEqual(["reopened"]);
  expect(runtime.closes).toBe(closesBeforeOldLoad);
});

test("duplicate Web starts share one confirmation chain and submit the captured form", async () => {
  const runtime = new DeferredWebBatchRuntime();
  const firstConfirmation = new Deferred<boolean>();
  const secondConfirmation = new Deferred<boolean>();
  behaviorMocks.requestConfirmation.mockImplementationOnce(() => firstConfirmation.promise).mockImplementationOnce(() => secondConfirmation.promise);
  await mountWebDialog(runtime, true);
  const secondTarget = await selectSecondTarget();
  await setDatabase("captured-db");
  const continueButton = buttonWithText("sqlFile.continueOnError");
  continueButton?.click();
  await flushBehavior();

  const executeButton = buttonWithText("sqlFile.execute");
  executeButton?.click();
  executeButton?.click();
  await flushBehavior();
  expect(behaviorMocks.requestConfirmation).toHaveBeenCalledTimes(1);
  expect(executeButton?.disabled).toBe(true);
  expect(databaseInput()?.disabled).toBe(true);
  expect(continueButton?.disabled).toBe(true);
  expect(buttonWithText("sqlFile.browse")?.disabled).toBe(true);

  secondTarget?.click();
  const input = databaseInput();
  if (input) {
    input.value = "mutated-db";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  continueButton?.click();
  await flushBehavior();

  firstConfirmation.resolve(true);
  await flushBehavior();
  expect(behaviorMocks.requestConfirmation).toHaveBeenCalledTimes(2);
  secondConfirmation.resolve(true);
  await flushBehavior(3);

  expect(runtime.createdRequests).toEqual([
    {
      connectionIds: ["connection-a", "connection-b"],
      database: "captured-db",
      filePath: "uploaded://seed.sql",
      continueOnError: true,
    },
  ]);
});

test("declining any production confirmation skips create and restores the guard", async () => {
  const runtime = new DeferredWebBatchRuntime();
  behaviorMocks.requestConfirmation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await mountWebDialog(runtime, true);
  await selectSecondTarget();

  const executeButton = buttonWithText("sqlFile.execute");
  executeButton?.click();
  await flushBehavior(3);

  expect(behaviorMocks.requestConfirmation).toHaveBeenCalledTimes(2);
  expect(runtime.createdRequests).toHaveLength(0);
  expect(executeButton?.disabled).toBe(false);
});

test("a production confirmation error skips create and restores the guard", async () => {
  const runtime = new DeferredWebBatchRuntime();
  behaviorMocks.requestConfirmation.mockRejectedValue(new Error("confirmation failed"));
  await mountWebDialog(runtime, true);

  const executeButton = buttonWithText("sqlFile.execute");
  executeButton?.click();
  await flushBehavior(3);

  expect(runtime.createdRequests).toHaveLength(0);
  expect(executeButton?.disabled).toBe(false);
  expect(behaviorMocks.toast).toHaveBeenCalledWith("confirmation failed", 5000);
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
