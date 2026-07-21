import assert from "node:assert/strict";
import { effectScope } from "vue";
import { test } from "vitest";
import { useWebSqlFileBatchExecution, type WebSqlFileBatchRuntime } from "@/composables/useWebSqlFileBatchExecution";
import type { CreateWebSqlFileBatchRequest, WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

const request: CreateWebSqlFileBatchRequest = {
  connectionIds: ["connection-a", "connection-b"],
  database: "app",
  filePath: "/tmp/seed.sql",
  continueOnError: true,
};

function snapshot(batchId: string, status: WebSqlFileBatchSnapshot["status"], updatedAtMs: number, targetCount = 1, revision = updatedAtMs): WebSqlFileBatchSnapshot {
  return {
    batchId,
    fileName: "seed.sql",
    database: "app",
    continueOnError: true,
    status,
    createdAtMs: updatedAtMs - 1,
    updatedAtMs,
    revision,
    targets: Array.from({ length: targetCount }, (_, index) => ({
      connectionId: `connection-${index + 1}`,
      executionId: `${batchId}-${index + 1}`,
      status: "running" as const,
      statementIndex: index,
      successCount: 0,
      failureCount: 0,
      affectedRows: 0,
      elapsedMs: 0,
      statementSummary: "",
      error: "",
      failures: [],
    })),
    summary: { success: 0, partial: 0, failed: 0, cancelled: 0, skipped: 0 },
  } as WebSqlFileBatchSnapshot;
}

class FakeRuntime implements WebSqlFileBatchRuntime {
  listed: WebSqlFileBatchSnapshot[] = [];
  listQueue: Promise<WebSqlFileBatchSnapshot[]>[] = [];
  created = snapshot("created", "running", 10);
  fetched = new Map<string, WebSqlFileBatchSnapshot>();
  getQueue: Promise<WebSqlFileBatchSnapshot>[] = [];
  createdRequests: CreateWebSqlFileBatchRequest[] = [];
  cancelled: string[] = [];
  closes = 0;
  listens = 0;
  private handlers = new Map<string, (next: WebSqlFileBatchSnapshot) => void>();

  async create(next: CreateWebSqlFileBatchRequest) {
    this.createdRequests.push(next);
    return this.created;
  }

  async list() {
    return this.listQueue.shift() ?? this.listed;
  }

  async get(batchId: string) {
    return this.getQueue.shift() ?? this.fetched.get(batchId) ?? this.created;
  }

  async cancel(batchId: string) {
    this.cancelled.push(batchId);
    return true;
  }

  listen(batchId: string, handler: (next: WebSqlFileBatchSnapshot) => void) {
    this.listens += 1;
    this.handlers.set(batchId, handler);
    return () => {
      this.closes += 1;
      this.handlers.delete(batchId);
    };
  }

  emit(next: WebSqlFileBatchSnapshot) {
    this.handlers.get(next.batchId)?.(next);
  }
}

class Deferred<T> {
  resolve!: (value: T) => void;
  promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

test("load selects the newest running batch before a terminal batch", async () => {
  const runtime = new FakeRuntime();
  runtime.listed = [snapshot("terminal", "completed", 30), snapshot("older-running", "running", 20), snapshot("newer-running", "cancelling", 40)];
  const batch = useWebSqlFileBatchExecution(runtime);

  await batch.load();

  assert.equal(batch.selectedBatchId.value, "newer-running");
  assert.equal(batch.currentBatch.value?.batchId, "newer-running");
});

test("start stores and subscribes to the returned batch", async () => {
  const runtime = new FakeRuntime();
  const batch = useWebSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.deepEqual(runtime.createdRequests, [request]);
  assert.equal(batch.selectedBatchId.value, "created");
  assert.equal(batch.batches.value[0]?.batchId, "created");
  assert.equal(batch.currentBatch.value?.batchId, "created");
});

test("an SSE snapshot replaces rather than merges local state", async () => {
  const runtime = new FakeRuntime();
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.start(request);
  const replacement = { ...snapshot("created", "completed", 20, 2), summary: { success: 2, partial: 0, failed: 0, cancelled: 0, skipped: 0 } };

  runtime.emit(replacement);

  assert.deepEqual(batch.currentBatch.value, replacement);
  assert.equal(batch.currentBatch.value?.targets.length, 2);
  assert.deepEqual(batch.currentBatch.value?.summary, replacement.summary);
});

test("switching batches closes the previous EventSource", async () => {
  const runtime = new FakeRuntime();
  runtime.listed = [snapshot("first", "running", 10), snapshot("second", "running", 20)];
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  batch.select("first");

  assert.equal(batch.selectedBatchId.value, "first");
  assert.equal(runtime.closes, 1);
});

test("closing the dialog subscription does not cancel the server batch", async () => {
  const runtime = new FakeRuntime();
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.start(request);

  batch.disconnect();

  assert.equal(runtime.closes, 1);
  assert.deepEqual(runtime.cancelled, []);
});

test("cancel delegates once and reloads the authoritative snapshot", async () => {
  const runtime = new FakeRuntime();
  const initial = snapshot("running", "running", 10);
  const refreshed = snapshot("running", "cancelled", 20);
  runtime.listed = [initial];
  runtime.fetched.set("running", refreshed);
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  await batch.cancel();

  assert.deepEqual(runtime.cancelled, ["running"]);
  assert.deepEqual(batch.currentBatch.value, refreshed);
});

test("a cancel GET cannot overwrite an SSE update that arrived after the GET started", async () => {
  const runtime = new FakeRuntime();
  const initial = snapshot("running", "running", 10);
  const staleGet = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.listed = [initial];
  runtime.getQueue.push(staleGet.promise);
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  const cancelling = batch.cancel();
  await Promise.resolve();
  runtime.emit(snapshot("running", "cancelled", 30));
  staleGet.resolve(snapshot("running", "cancelling", 20));
  await cancelling;

  assert.equal(batch.currentBatch.value?.status, "cancelled");
  assert.equal(batch.currentBatch.value?.updatedAtMs, 30);
});

test("a cancel GET cannot overwrite a newer snapshot written by a concurrent load", async () => {
  const runtime = new FakeRuntime();
  const staleGet = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.listQueue.push(Promise.resolve([snapshot("running", "running", 10)]), Promise.resolve([snapshot("running", "cancelled", 30)]));
  runtime.getQueue.push(staleGet.promise);
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  const cancelling = batch.cancel();
  await Promise.resolve();
  await batch.load();
  staleGet.resolve(snapshot("running", "cancelling", 20));
  await cancelling;

  assert.equal(batch.currentBatch.value?.status, "cancelled");
  assert.equal(batch.currentBatch.value?.updatedAtMs, 30);
});

test("a newer cancel GET wins after an earlier captured load arrives first", async () => {
  const runtime = new FakeRuntime();
  const staleLoad = new Deferred<WebSqlFileBatchSnapshot[]>();
  const newerGet = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.listQueue.push(Promise.resolve([snapshot("running", "running", 10, 1, 1)]), staleLoad.promise);
  runtime.getQueue.push(newerGet.promise);
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  const loading = batch.load();
  const cancelling = batch.cancel();
  await Promise.resolve();
  staleLoad.resolve([snapshot("running", "running", 10, 1, 1)]);
  await loading;
  newerGet.resolve(snapshot("running", "cancelled", 30, 1, 3));
  await cancelling;

  assert.equal(batch.currentBatch.value?.status, "cancelled");
  assert.equal(batch.currentBatch.value?.revision, 3);
});

test("list merges batches by their independent server revisions", async () => {
  const runtime = new FakeRuntime();
  runtime.listQueue.push(
    Promise.resolve([snapshot("a", "cancelled", 30, 1, 3), snapshot("b", "running", 10, 1, 1)]),
    Promise.resolve([snapshot("a", "cancelling", 20, 1, 2), snapshot("b", "cancelled", 20, 1, 2)]),
  );
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();
  await batch.load();

  assert.equal(batch.batches.value.find((item) => item.batchId === "a")?.status, "cancelled");
  assert.equal(batch.batches.value.find((item) => item.batchId === "b")?.status, "cancelled");
});

test("a repeated snapshot revision is idempotent", async () => {
  const runtime = new FakeRuntime();
  runtime.listed = [snapshot("same", "cancelled", 30, 1, 3)];
  const batch = useWebSqlFileBatchExecution(runtime);
  await batch.load();

  runtime.emit(snapshot("same", "cancelling", 40, 1, 3));

  assert.equal(batch.currentBatch.value?.status, "cancelled");
  assert.equal(batch.currentBatch.value?.revision, 3);
});

test("scope disposal prevents a pending load from ever creating a subscription", async () => {
  const runtime = new FakeRuntime();
  const deferred = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(deferred.promise);
  const scope = effectScope();
  const batch = scope.run(() => useWebSqlFileBatchExecution(runtime))!;

  const loading = batch.load();
  scope.stop();
  deferred.resolve([snapshot("late-load", "running", 1, 1, 0)]);
  await loading;

  assert.equal(runtime.listens, 0);
});

test("scope disposal prevents a pending start from ever creating a subscription", async () => {
  const runtime = new FakeRuntime();
  const deferred = new Deferred<WebSqlFileBatchSnapshot>();
  runtime.create = async () => deferred.promise;
  const scope = effectScope();
  const batch = scope.run(() => useWebSqlFileBatchExecution(runtime))!;

  const starting = batch.start(request);
  scope.stop();
  deferred.resolve(snapshot("late-start", "running", 1, 1, 0));
  await starting;

  assert.equal(runtime.listens, 0);
});

test("a load that started before start cannot replace the created batch", async () => {
  const runtime = new FakeRuntime();
  const staleLoad = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(staleLoad.promise);
  const batch = useWebSqlFileBatchExecution(runtime);

  const loading = batch.load();
  await batch.start(request);
  staleLoad.resolve([snapshot("old", "running", 1)]);
  await loading;

  assert.equal(batch.selectedBatchId.value, "created");
  assert.equal(batch.currentBatch.value?.batchId, "created");
  assert.equal(runtime.closes, 0);
  assert.equal(batch.loading.value, false);
});

test("an older load cannot replace the state from a newer completed load", async () => {
  const runtime = new FakeRuntime();
  const older = new Deferred<WebSqlFileBatchSnapshot[]>();
  const newer = new Deferred<WebSqlFileBatchSnapshot[]>();
  runtime.listQueue.push(older.promise, newer.promise);
  const batch = useWebSqlFileBatchExecution(runtime);

  const firstLoad = batch.load();
  const secondLoad = batch.load();
  newer.resolve([snapshot("newest", "running", 20)]);
  await secondLoad;
  assert.equal(batch.loading.value, true);
  older.resolve([snapshot("oldest", "running", 10)]);
  await firstLoad;

  assert.equal(batch.selectedBatchId.value, "newest");
  assert.equal(batch.currentBatch.value?.batchId, "newest");
  assert.equal(batch.loading.value, false);
});
