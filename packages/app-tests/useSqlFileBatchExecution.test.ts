import assert from "node:assert/strict";
import { test } from "vitest";
import type { SqlFileProgress, SqlFileStatus } from "@/lib/backend/api";
import { useSqlFileBatchExecution, type SqlFileBatchRuntime } from "@/composables/useSqlFileBatchExecution";

const request = {
  connectionIds: ["a", "b"],
  database: "app",
  fileName: "seed.sql",
  filePath: "/tmp/seed.sql",
  continueOnError: true,
};

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeRuntime implements SqlFileBatchRuntime {
  actions: string[] = [];
  taskIds: string[] = [];
  tasks: Array<{ executionId: string; fileName: string; filePath: string; connectionId: string; database: string }> = [];
  taskUpdates: Array<{ executionId: string; progress: SqlFileProgress }> = [];
  cancelledIds: string[] = [];
  refreshedIds: string[] = [];
  prepare = new Map<string, () => Promise<"ready" | "declined">>();
  executeFor = new Map<string, (request: Parameters<SqlFileBatchRuntime["execute"]>[0]) => Promise<void>>();
  listenFor = new Map<string, () => Promise<() => void>>();
  addTaskFor = new Map<string, () => void>();
  unlistenCount = 0;
  cancelResult: Promise<boolean> = Promise.resolve(true);
  private handlers = new Map<string, (progress: SqlFileProgress) => void>();
  private ids = 0;

  createExecutionId(connectionId: string) {
    this.ids += 1;
    return `${connectionId}-${this.ids}`;
  }

  prepareTarget(connectionId: string) {
    this.actions.push(`prepare ${connectionId}`);
    return this.prepare.get(connectionId)?.() ?? Promise.resolve("ready");
  }

  addTask(executionId: string, fileName: string, filePath: string, connectionId: string, database: string) {
    this.taskIds.push(executionId);
    this.tasks.push({ executionId, fileName, filePath, connectionId, database });
    this.actions.push(`add ${executionId}`);
    this.addTaskFor.get(executionId)?.();
  }

  updateTask(executionId: string, progress: SqlFileProgress) {
    this.taskUpdates.push({ executionId, progress });
    this.actions.push(`update ${executionId} ${progress.status}`);
  }

  async listen(executionId: string, handler: (progress: SqlFileProgress) => void) {
    this.actions.push(`listen ${executionId}`);
    const customListener = this.listenFor.get(executionId);
    if (customListener) return customListener();
    this.handlers.set(executionId, handler);
    return () => {
      this.unlistenCount += 1;
      this.handlers.delete(executionId);
    };
  }

  async execute(next: Parameters<SqlFileBatchRuntime["execute"]>[0]) {
    this.actions.push(`execute ${next.connectionId}`);
    await (this.executeFor.get(next.connectionId) ?? (async () => this.emit(next.executionId, "done")))(next);
  }

  async cancel(executionId: string) {
    this.cancelledIds.push(executionId);
    return this.cancelResult;
  }

  async refresh(connectionId: string) {
    this.refreshedIds.push(connectionId);
  }

  emit(executionId: string, status: SqlFileStatus, overrides: Partial<SqlFileProgress> = {}) {
    const progress: SqlFileProgress = {
      executionId,
      status,
      statementIndex: 1,
      successCount: 0,
      failureCount: 0,
      affectedRows: 0,
      elapsedMs: 1,
      statementSummary: "SELECT 1",
      error: null,
      ...overrides,
    };
    this.actions.push(`terminal ${progress.executionId}`);
    this.handlers.get(executionId)?.(progress);
  }
}

function indexOf(actions: string[], action: string) {
  const index = actions.indexOf(action);
  assert.notEqual(index, -1, `missing action: ${action}`);
  return index;
}

async function waitForAction(actions: string[], action: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (actions.includes(action)) return;
    await Promise.resolve();
  }
  assert.fail(`missing action: ${action}`);
}

test("runs targets serially after each terminal progress event", async () => {
  const runtime = new FakeRuntime();
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.ok(indexOf(runtime.actions, "prepare a") < indexOf(runtime.actions, "execute a"));
  assert.ok(indexOf(runtime.actions, "execute a") < indexOf(runtime.actions, "terminal a-1"));
  assert.ok(indexOf(runtime.actions, "terminal a-1") < indexOf(runtime.actions, "prepare b"));
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["success", "success"],
  );
});

test("continues after a target setup failure", async () => {
  const runtime = new FakeRuntime();
  runtime.prepare.set("a", async () => {
    throw new Error("connection unavailable");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.deepEqual(
    batch.targets.value.map((target) => [target.status, target.error]),
    [
      ["failed", "connection unavailable"],
      ["success", ""],
    ],
  );
  assert.equal(runtime.actions.includes("execute a"), false);
  assert.equal(runtime.actions.includes("execute b"), true);
  assert.deepEqual(
    runtime.taskUpdates.filter(({ executionId }) => executionId === "a-1").map(({ progress }) => [progress.status, progress.error]),
    [["error", "connection unavailable"]],
  );
});

test("continues after a terminal execution error", async () => {
  const runtime = new FakeRuntime();
  runtime.executeFor.set("a", async (next) => runtime.emit(next.executionId, "error", { error: "permission denied" }));
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.deepEqual(
    batch.targets.value.map((target) => [target.status, target.error]),
    [
      ["failed", "permission denied"],
      ["success", ""],
    ],
  );
});

test("classifies a completed target with statement failures as partial and refreshes it", async () => {
  const runtime = new FakeRuntime();
  runtime.executeFor.set("a", async (next) => {
    runtime.emit(next.executionId, "statementFailed", { failureCount: 1, error: "duplicate row" });
    runtime.emit(next.executionId, "done", { successCount: 1, failureCount: 1 });
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start({ ...request, connectionIds: ["a"] });

  assert.equal(batch.targets.value[0]?.status, "partial");
  assert.deepEqual(runtime.refreshedIds, ["a"]);
});

test("registers every frozen target with metadata before preparing the first target", async () => {
  const runtime = new FakeRuntime();
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.deepEqual(
    batch.targets.value.map((target) => target.executionId),
    ["a-1", "b-2"],
  );
  assert.deepEqual(runtime.taskIds, ["a-1", "b-2"]);
  assert.deepEqual(runtime.tasks, [
    { executionId: "a-1", fileName: "seed.sql", filePath: "/tmp/seed.sql", connectionId: "a", database: "app" },
    { executionId: "b-2", fileName: "seed.sql", filePath: "/tmp/seed.sql", connectionId: "b", database: "app" },
  ]);
  assert.ok(indexOf(runtime.actions, "add b-2") < indexOf(runtime.actions, "prepare a"));
});

test("records declined production confirmation and continues to the next target", async () => {
  const runtime = new FakeRuntime();
  runtime.prepare.set("a", async () => "declined");
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.equal(batch.targets.value[0]?.status, "failed");
  assert.equal(batch.targets.value[0]?.error, "Production confirmation declined");
  assert.equal(runtime.actions.includes("execute a"), false);
  assert.equal(batch.targets.value[1]?.status, "success");
  assert.deepEqual(
    runtime.taskUpdates.filter(({ executionId }) => executionId === "a-1").map(({ progress }) => [progress.status, progress.error]),
    [["error", "Production confirmation declined"]],
  );
});

test("terminalizes a partially-created tracker task when addTask throws and continues", async () => {
  const runtime = new FakeRuntime();
  runtime.addTaskFor.set("a-1", () => {
    throw new Error("tracker registration failed");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start(request);

  assert.deepEqual(runtime.taskIds, ["a-1", "b-2"]);
  assert.deepEqual(
    batch.targets.value.map((target) => [target.status, target.error]),
    [
      ["failed", "tracker registration failed"],
      ["success", ""],
    ],
  );
  assert.equal(runtime.actions.includes("prepare a"), false);
  assert.equal(runtime.actions.includes("execute b"), true);
  assert.deepEqual(
    runtime.taskUpdates.filter(({ executionId }) => executionId === "a-1").map(({ progress }) => [progress.status, progress.error]),
    [["error", "tracker registration failed"]],
  );
});

test("fails an execution that throws before terminal progress and cleans up its listener", async () => {
  const runtime = new FakeRuntime();
  runtime.executeFor.set("a", async () => {
    throw new Error("backend disconnected");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start({ ...request, connectionIds: ["a"] });

  assert.equal(batch.targets.value[0]?.status, "failed");
  assert.equal(batch.targets.value[0]?.error, "backend disconnected");
  assert.equal(runtime.unlistenCount, 1);
  assert.deepEqual(runtime.taskUpdates, [
    {
      executionId: "a-1",
      progress: {
        executionId: "a-1",
        status: "error",
        statementIndex: 0,
        successCount: 0,
        failureCount: 0,
        affectedRows: 0,
        elapsedMs: 0,
        statementSummary: "",
        error: "backend disconnected",
      },
    },
  ]);
});

test("sends the latest progress as a terminal tracker error when execution rejects", async () => {
  const runtime = new FakeRuntime();
  runtime.executeFor.set("a", async (next) => {
    runtime.emit(next.executionId, "statementDone", {
      statementIndex: 4,
      successCount: 3,
      failureCount: 1,
      affectedRows: 27,
      elapsedMs: 900,
      statementSummary: "UPDATE orders",
    });
    throw new Error("transport closed");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start({ ...request, connectionIds: ["a"] });

  assert.deepEqual(
    runtime.taskUpdates.map(({ progress }) => progress),
    [
      {
        executionId: "a-1",
        status: "statementDone",
        statementIndex: 4,
        successCount: 3,
        failureCount: 1,
        affectedRows: 27,
        elapsedMs: 900,
        statementSummary: "UPDATE orders",
        error: null,
      },
      {
        executionId: "a-1",
        status: "error",
        statementIndex: 4,
        successCount: 3,
        failureCount: 1,
        affectedRows: 27,
        elapsedMs: 900,
        statementSummary: "UPDATE orders",
        error: "transport closed",
      },
    ],
  );
});

test("sends a terminal tracker error when listener setup rejects", async () => {
  const runtime = new FakeRuntime();
  runtime.listenFor.set("a-1", async () => {
    throw new Error("event channel unavailable");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start({ ...request, connectionIds: ["a"] });

  assert.equal(runtime.actions.includes("execute a"), false);
  assert.equal(runtime.taskUpdates.length, 1);
  assert.equal(runtime.taskUpdates[0]?.progress.status, "error");
  assert.equal(runtime.taskUpdates[0]?.progress.error, "event channel unavailable");
});

test("does not duplicate a terminal tracker update when execution rejects afterward", async () => {
  const runtime = new FakeRuntime();
  runtime.executeFor.set("a", async (next) => {
    runtime.emit(next.executionId, "error", { error: "permission denied" });
    throw new Error("request rejected after terminal progress");
  });
  const batch = useSqlFileBatchExecution(runtime);

  await batch.start({ ...request, connectionIds: ["a"] });

  assert.deepEqual(
    runtime.taskUpdates.map(({ progress }) => [progress.status, progress.error]),
    [["error", "permission denied"]],
  );
});

test("cancels the active target and skips pending targets", async () => {
  const runtime = new FakeRuntime();
  const execution = new Deferred<void>();
  runtime.executeFor.set("a", async (next) => {
    await execution.promise;
    runtime.emit(next.executionId, "cancelled");
  });
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start(request);
  await waitForAction(runtime.actions, "execute a");
  await batch.stop();
  execution.resolve();
  await started;

  assert.deepEqual(runtime.cancelledIds, ["a-1"]);
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["cancelled", "skipped"],
  );
  assert.deepEqual(
    runtime.taskUpdates.map(({ executionId, progress }) => [executionId, progress.status]),
    [
      ["a-1", "cancelled"],
      ["b-2", "cancelled"],
    ],
  );
});

test("stopping while listener setup is pending terminalizes its tracker and skips every target", async () => {
  const runtime = new FakeRuntime();
  const listener = new Deferred<() => void>();
  runtime.listenFor.set("a-1", () => listener.promise);
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start(request);
  await waitForAction(runtime.actions, "listen a-1");
  await batch.stop();
  listener.resolve(() => {
    runtime.unlistenCount += 1;
  });
  await started;

  assert.equal(runtime.actions.includes("execute a"), false);
  assert.equal(runtime.actions.includes("prepare b"), false);
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["skipped", "skipped"],
  );
  assert.deepEqual(runtime.cancelledIds, []);
  assert.equal(runtime.unlistenCount, 1);
  assert.deepEqual(
    runtime.taskUpdates.map(({ executionId, progress }) => [executionId, progress.status]),
    [
      ["a-1", "cancelled"],
      ["b-2", "cancelled"],
    ],
  );
});

test("keeps the queue stopped when cancellation is declined", async () => {
  const runtime = new FakeRuntime();
  const execution = new Deferred<void>();
  runtime.executeFor.set("a", async (next) => {
    await execution.promise;
    runtime.emit(next.executionId, "done");
  });
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start(request);
  await waitForAction(runtime.actions, "execute a");
  runtime.cancelResult = Promise.resolve(false);
  await batch.stop();
  execution.resolve();
  await started;

  assert.deepEqual(runtime.cancelledIds, ["a-1"]);
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["success", "skipped"],
  );
  assert.equal(runtime.actions.includes("prepare b"), false);
  assert.equal(runtime.actions.includes("execute b"), false);
});

test("keeps the queue stopped when cancellation rejects", async () => {
  const runtime = new FakeRuntime();
  const execution = new Deferred<void>();
  runtime.executeFor.set("a", async (next) => {
    await execution.promise;
    runtime.emit(next.executionId, "done");
  });
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start(request);
  await waitForAction(runtime.actions, "execute a");
  runtime.cancelResult = Promise.reject(new Error("cancel unavailable"));
  await batch.stop();
  execution.resolve();
  await started;

  assert.deepEqual(runtime.cancelledIds, ["a-1"]);
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["success", "skipped"],
  );
  assert.equal(runtime.actions.includes("prepare b"), false);
  assert.equal(runtime.actions.includes("execute b"), false);
});

test("skips a target stopped while preparation is pending without cancelling it", async () => {
  const runtime = new FakeRuntime();
  const preparation = new Deferred<"ready" | "declined">();
  runtime.prepare.set("a", () => preparation.promise);
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start(request);
  await Promise.resolve();
  await batch.stop();
  preparation.resolve("ready");
  await started;

  assert.deepEqual(runtime.cancelledIds, []);
  assert.deepEqual(
    batch.targets.value.map((target) => target.status),
    ["skipped", "skipped"],
  );
  assert.deepEqual(
    runtime.taskUpdates.map(({ executionId, progress }) => [executionId, progress.status]),
    [
      ["a-1", "cancelled"],
      ["b-2", "cancelled"],
    ],
  );
});

test("does not reset state while a batch is running", async () => {
  const runtime = new FakeRuntime();
  const execution = new Deferred<void>();
  runtime.executeFor.set("a", async (next) => {
    await execution.promise;
    runtime.emit(next.executionId, "done");
  });
  const batch = useSqlFileBatchExecution(runtime);

  const started = batch.start({ ...request, connectionIds: ["a"] });
  await Promise.resolve();
  batch.reset();

  assert.equal(batch.running.value, true);
  assert.equal(batch.targets.value.length, 1);
  execution.resolve();
  await started;
});
