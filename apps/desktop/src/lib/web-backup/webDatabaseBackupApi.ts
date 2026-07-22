import { apiUrl } from "@/lib/common/webPath";
import type { WebDatabaseBackupConfig, WebDatabaseBackupRun, WebDatabaseBackupSchedule, WebDatabaseBackupScheduleInput } from "./webDatabaseBackup";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) throw new Error((await response.text()) || `Web database backup request failed (${response.status})`);
  const body = await response.text();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

function jsonRequest(method: "POST" | "PUT", body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function getWebDatabaseBackupConfig(): Promise<WebDatabaseBackupConfig> {
  return request("/api/database-backups/config");
}

export function listWebDatabaseBackupSchedules(): Promise<WebDatabaseBackupSchedule[]> {
  return request("/api/database-backups/schedules");
}

export function createWebDatabaseBackupSchedule(input: WebDatabaseBackupScheduleInput): Promise<WebDatabaseBackupSchedule> {
  return request("/api/database-backups/schedules", jsonRequest("POST", input));
}

export function updateWebDatabaseBackupSchedule(scheduleId: string, input: WebDatabaseBackupScheduleInput): Promise<WebDatabaseBackupSchedule> {
  return request(`/api/database-backups/schedules/${encodeURIComponent(scheduleId)}`, jsonRequest("PUT", input));
}

export function deleteWebDatabaseBackupSchedule(scheduleId: string): Promise<void> {
  return request(`/api/database-backups/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}

export function listWebDatabaseBackupRuns(): Promise<WebDatabaseBackupRun[]> {
  return request("/api/database-backups/runs");
}

export function runWebDatabaseBackupSchedule(scheduleId: string): Promise<WebDatabaseBackupRun> {
  return request(`/api/database-backups/schedules/${encodeURIComponent(scheduleId)}/run`, jsonRequest("POST"));
}

export function cancelWebDatabaseBackupRun(runId: string): Promise<void> {
  return request(`/api/database-backups/runs/${encodeURIComponent(runId)}/cancel`, jsonRequest("POST"));
}

export function webDatabaseBackupFileDownloadUrl(runId: string, relativePath: string): string {
  return apiUrl(`/api/database-backups/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(relativePath)}/download`);
}

export function deleteWebDatabaseBackupRun(runId: string): Promise<void> {
  return request(`/api/database-backups/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
}
