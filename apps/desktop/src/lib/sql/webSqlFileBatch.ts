import { summarizeSqlFileBatch, type SqlFileBatchTargetState } from "@/lib/sql/sqlFileBatchExecution";

export interface CreateWebSqlFileBatchRequest {
  connectionIds: string[];
  database: string;
  filePath: string;
  continueOnError: boolean;
}

export interface WebSqlFileBatchSnapshot {
  batchId: string;
  fileName: string;
  database: string;
  continueOnError: boolean;
  status: "running" | "cancelling" | "completed" | "cancelled";
  createdAtMs: number;
  updatedAtMs: number;
  targets: SqlFileBatchTargetState[];
  summary: ReturnType<typeof summarizeSqlFileBatch>;
}

export function isWebSqlFileBatchTerminal(snapshot: Pick<WebSqlFileBatchSnapshot, "status">): boolean {
  return snapshot.status === "completed" || snapshot.status === "cancelled";
}

export function preferredWebSqlFileBatch(snapshots: WebSqlFileBatchSnapshot[]): WebSqlFileBatchSnapshot | undefined {
  const running = snapshots.filter((snapshot) => !isWebSqlFileBatchTerminal(snapshot));
  return [...(running.length > 0 ? running : snapshots)].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
}
