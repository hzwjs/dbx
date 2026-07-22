export type WebDatabaseBackupFrequency = "hourly" | "daily" | "weekly";
export type WebDatabaseBackupTableFilterMode = "all" | "include" | "exclude";
export type WebDatabaseBackupRunTrigger = "manual" | "scheduled";
export type WebDatabaseBackupRunStatus = "running" | "success" | "failed" | "cancelled";

export interface WebDatabaseBackupScheduleInput {
  name: string;
  enabled: boolean;
  connectionId: string;
  databases: string[];
  tableFilterMode: WebDatabaseBackupTableFilterMode;
  tablePatterns: string[];
  frequency: WebDatabaseBackupFrequency;
  intervalHours: number;
  timeOfDay: string;
  weekday: number;
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  dropTableIfExists: boolean;
  retentionCount: number;
}

export interface WebDatabaseBackupSchedule extends WebDatabaseBackupScheduleInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastRunStatus?: Exclude<WebDatabaseBackupRunStatus, "running">;
}

export interface WebDatabaseBackupFile {
  database: string;
  schema: string;
  displayName: string;
  relativePath: string;
}

export interface WebDatabaseBackupRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  connectionId: string;
  connectionName: string;
  trigger: WebDatabaseBackupRunTrigger;
  status: WebDatabaseBackupRunStatus;
  startedAt: string;
  completedAt?: string;
  files: WebDatabaseBackupFile[];
  error?: string;
}

export interface WebDatabaseBackupConfig {
  available: boolean;
  backupDirectory: string;
  serverTimezone: string;
}

export function supportsWebDatabaseBackup(databaseType: string | undefined): boolean {
  return databaseType === "mysql" || databaseType === "postgres";
}

export function normalizeWebDatabaseBackupTablePatterns(value: string | readonly string[]): string[] {
  const values = typeof value === "string" ? value.split(/[,;\n]+/) : value;
  return [...new Set(values.map((pattern) => pattern.trim()).filter(Boolean))];
}

export function webDatabaseBackupScheduleInput(schedule: WebDatabaseBackupSchedule): WebDatabaseBackupScheduleInput {
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    connectionId: schedule.connectionId,
    databases: [...schedule.databases],
    tableFilterMode: schedule.tableFilterMode,
    tablePatterns: [...schedule.tablePatterns],
    frequency: schedule.frequency,
    intervalHours: schedule.intervalHours,
    timeOfDay: schedule.timeOfDay,
    weekday: schedule.weekday,
    includeStructure: schedule.includeStructure,
    includeData: schedule.includeData,
    includeObjects: schedule.includeObjects,
    dropTableIfExists: schedule.dropTableIfExists,
    retentionCount: schedule.retentionCount,
  };
}

export function newWebDatabaseBackupScheduleInput(connectionId: string, name: string): WebDatabaseBackupScheduleInput {
  return {
    name,
    enabled: true,
    connectionId,
    databases: [],
    tableFilterMode: "all",
    tablePatterns: [],
    frequency: "daily",
    intervalHours: 6,
    timeOfDay: "02:00",
    weekday: 1,
    includeStructure: true,
    includeData: true,
    includeObjects: true,
    dropTableIfExists: false,
    retentionCount: 10,
  };
}
