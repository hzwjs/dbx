import type { SqlFileProgress, SqlFileStatus } from "@/lib/backend/api";

export type SqlFileBatchTargetStatus = "pending" | "running" | "success" | "partial" | "failed" | "cancelled" | "skipped";

export interface SqlFileBatchFailure {
  statementIndex: number;
  statementSummary: string;
  error: string;
}

export interface SqlFileBatchTargetState {
  connectionId: string;
  executionId: string;
  status: SqlFileBatchTargetStatus;
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
  elapsedMs: number;
  statementSummary: string;
  error: string;
  failures: SqlFileBatchFailure[];
}

export function createSqlFileBatchTargets(connectionIds: string[], executionIdFor: (connectionId: string) => string): SqlFileBatchTargetState[] {
  return connectionIds.map((connectionId) => ({
    connectionId,
    executionId: executionIdFor(connectionId),
    status: "pending",
    statementIndex: 0,
    successCount: 0,
    failureCount: 0,
    affectedRows: 0,
    elapsedMs: 0,
    statementSummary: "",
    error: "",
    failures: [],
  }));
}

export function reduceSqlFileBatchProgress(target: SqlFileBatchTargetState, progress: SqlFileProgress): SqlFileBatchTargetState {
  const error = progress.error ?? "";
  const failures = progress.status === "statementFailed" && error ? [...target.failures, { statementIndex: progress.statementIndex, statementSummary: progress.statementSummary, error }] : target.failures;
  const failureCount = Math.max(progress.failureCount, failures.length);

  return {
    ...target,
    status: statusForProgress(progress.status, failureCount),
    statementIndex: progress.statementIndex,
    successCount: progress.successCount,
    failureCount,
    affectedRows: progress.affectedRows,
    elapsedMs: progress.elapsedMs,
    statementSummary: progress.statementSummary,
    error,
    failures,
  };
}

export function failSqlFileBatchTarget(target: SqlFileBatchTargetState, error: string): SqlFileBatchTargetState {
  return { ...target, status: "failed", error };
}

export function skipPendingSqlFileBatchTargets(targets: SqlFileBatchTargetState[]): SqlFileBatchTargetState[] {
  return targets.map((target) => (target.status === "pending" ? { ...target, status: "skipped" } : target));
}

export function summarizeSqlFileBatch(targets: SqlFileBatchTargetState[]): Record<"success" | "partial" | "failed" | "cancelled" | "skipped", number> {
  const summary = { success: 0, partial: 0, failed: 0, cancelled: 0, skipped: 0 };

  for (const target of targets) {
    if (target.status in summary) summary[target.status]++;
  }

  return summary;
}

function statusForProgress(status: SqlFileStatus, failureCount: number): SqlFileBatchTargetStatus {
  switch (status) {
    case "done":
      return failureCount > 0 ? "partial" : "success";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}
