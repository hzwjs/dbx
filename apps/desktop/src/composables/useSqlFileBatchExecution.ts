import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { SqlFileProgress, SqlFileRequest } from "@/lib/backend/api";
import { createSqlFileBatchTargets, failSqlFileBatchTarget, reduceSqlFileBatchProgress, skipPendingSqlFileBatchTargets, summarizeSqlFileBatch, type SqlFileBatchTargetState } from "@/lib/sql/sqlFileBatchExecution";

export interface SqlFileBatchRunRequest {
  connectionIds: string[];
  database: string;
  fileName: string;
  filePath: string;
  continueOnError: boolean;
}

export interface SqlFileBatchRuntime {
  createExecutionId(connectionId: string): string;
  prepareTarget(connectionId: string, database: string): Promise<"ready" | "declined">;
  addTask(executionId: string, fileName: string, filePath: string, connectionId: string, database: string): void;
  updateTask(executionId: string, progress: SqlFileProgress): void;
  listen(executionId: string, handler: (progress: SqlFileProgress) => void): Promise<() => void>;
  execute(request: SqlFileRequest): Promise<void>;
  cancel(executionId: string): Promise<boolean>;
  refresh(connectionId: string, database: string): Promise<void>;
}

export function useSqlFileBatchExecution(runtime: SqlFileBatchRuntime): {
  targets: Ref<SqlFileBatchTargetState[]>;
  running: Ref<boolean>;
  stopping: Ref<boolean>;
  activeTarget: ComputedRef<SqlFileBatchTargetState | undefined>;
  summary: ComputedRef<ReturnType<typeof summarizeSqlFileBatch>>;
  start(request: SqlFileBatchRunRequest): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
} {
  const targets = ref<SqlFileBatchTargetState[]>([]);
  const running = ref(false);
  const stopping = ref(false);
  const activeExecutionId = ref<string>();
  let stopRequested = false;
  let executionStarted = false;

  const activeTarget = computed(() => targets.value.find((target) => target.executionId === activeExecutionId.value));
  const summary = computed(() => summarizeSqlFileBatch(targets.value));

  function replaceTarget(next: SqlFileBatchTargetState) {
    targets.value = targets.value.map((target) => (target.executionId === next.executionId ? next : target));
  }

  function skipPendingTargets() {
    targets.value = skipPendingSqlFileBatchTargets(targets.value);
  }

  function failTrackedTarget(target: SqlFileBatchTargetState, error: string) {
    runtime.updateTask(target.executionId, {
      executionId: target.executionId,
      status: "error",
      statementIndex: target.statementIndex,
      successCount: target.successCount,
      failureCount: target.failureCount,
      affectedRows: target.affectedRows,
      elapsedMs: target.elapsedMs,
      statementSummary: target.statementSummary,
      error,
    });
    replaceTarget(failSqlFileBatchTarget(target, error));
  }

  async function refreshTarget(target: SqlFileBatchTargetState, database: string) {
    if (target.status !== "success" && target.status !== "partial") return;
    try {
      await runtime.refresh(target.connectionId, database);
    } catch {
      // A metadata refresh must not change an already terminal execution result.
    }
  }

  async function runTarget(target: SqlFileBatchTargetState, request: SqlFileBatchRunRequest) {
    activeExecutionId.value = target.executionId;
    executionStarted = false;

    try {
      const preparation = await runtime.prepareTarget(target.connectionId, request.database);
      if (stopRequested) return;
      if (preparation === "declined") {
        replaceTarget(failSqlFileBatchTarget(target, "Production confirmation declined"));
        return;
      }

      runtime.addTask(target.executionId, request.fileName, request.filePath, target.connectionId, request.database);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await runtime.listen(target.executionId, (progress) => {
          if (progress.executionId !== target.executionId) return;
          replaceTarget(reduceSqlFileBatchProgress(activeTarget.value ?? target, progress));
          runtime.updateTask(target.executionId, progress);
        });
        if (stopRequested) return;

        executionStarted = true;
        await runtime.execute({
          executionId: target.executionId,
          connectionId: target.connectionId,
          database: request.database,
          filePath: request.filePath,
          continueOnError: request.continueOnError,
        });

        const completed = targets.value.find((item) => item.executionId === target.executionId) ?? target;
        if (!isTerminal(completed)) {
          failTrackedTarget(completed, "Execution completed without terminal progress");
        }
      } catch (error) {
        const completed = targets.value.find((item) => item.executionId === target.executionId) ?? target;
        if (!isTerminal(completed)) {
          failTrackedTarget(completed, errorMessage(error));
        }
      } finally {
        executionStarted = false;
        unlisten?.();
      }
    } catch (error) {
      if (!stopRequested) replaceTarget(failSqlFileBatchTarget(target, errorMessage(error)));
    } finally {
      const completed = targets.value.find((item) => item.executionId === target.executionId) ?? target;
      await refreshTarget(completed, request.database);
      activeExecutionId.value = undefined;
    }
  }

  async function start(request: SqlFileBatchRunRequest) {
    if (running.value) return;

    stopRequested = false;
    stopping.value = false;
    targets.value = createSqlFileBatchTargets(request.connectionIds, (connectionId) => runtime.createExecutionId(connectionId));
    running.value = true;

    try {
      for (const target of targets.value) {
        if (stopRequested) {
          skipPendingTargets();
          return;
        }

        await runTarget(target, request);

        if (stopRequested) {
          skipPendingTargets();
          return;
        }
      }
    } finally {
      activeExecutionId.value = undefined;
      executionStarted = false;
      running.value = false;
      stopping.value = false;
    }
  }

  async function stop() {
    if (!running.value || stopRequested) return;

    stopRequested = true;
    stopping.value = true;
    if (!activeExecutionId.value || !executionStarted) return;

    try {
      await runtime.cancel(activeExecutionId.value);
    } catch {
      // The stop request remains in force even when the runtime rejects cancellation.
    }
  }

  function reset() {
    if (running.value) return;
    stopRequested = false;
    stopping.value = false;
    activeExecutionId.value = undefined;
    targets.value = [];
  }

  return { targets, running, stopping, activeTarget, summary, start, stop, reset };
}

function isTerminal(target: SqlFileBatchTargetState) {
  return target.status === "success" || target.status === "partial" || target.status === "failed" || target.status === "cancelled" || target.status === "skipped";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
