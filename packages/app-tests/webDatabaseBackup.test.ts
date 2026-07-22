import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { newWebDatabaseBackupScheduleInput, normalizeWebDatabaseBackupTablePatterns, supportsWebDatabaseBackup, webDatabaseBackupScheduleInput, type WebDatabaseBackupSchedule } from "../../apps/desktop/src/lib/web-backup/webDatabaseBackup.ts";
import { cancelWebDatabaseBackupRun, webDatabaseBackupFileDownloadUrl } from "../../apps/desktop/src/lib/web-backup/webDatabaseBackupApi.ts";

test("Web backup schedule helpers remain independent from desktop storage", () => {
  const input = newWebDatabaseBackupScheduleInput("connection-1", "Nightly");
  assert.equal(input.connectionId, "connection-1");
  assert.equal("destinationDirectory" in input, false);
  assert.deepEqual(normalizeWebDatabaseBackupTablePatterns(" orders, audit_*;orders "), ["orders", "audit_*"]);
  assert.equal(supportsWebDatabaseBackup("mysql"), true);
  assert.equal(supportsWebDatabaseBackup("sqlite"), false);
});

test("Web backup schedule payload contains no server filesystem path", () => {
  const schedule: WebDatabaseBackupSchedule = {
    ...newWebDatabaseBackupScheduleInput("connection-1", "Nightly"),
    id: "schedule-1",
    createdAt: "2026-07-22T00:00:00+08:00",
    updatedAt: "2026-07-22T00:00:00+08:00",
    nextRunAt: "2026-07-23T02:00:00+08:00",
  };
  const payload = webDatabaseBackupScheduleInput(schedule);
  assert.equal("backupDirectory" in payload, false);
  assert.equal("destinationDirectory" in payload, false);
});

test("Web cloned UI does not import desktop backup business modules or Tauri paths", () => {
  const source = fs.readFileSync("apps/desktop/src/components/web-backup/WebDatabaseBackupSettings.vue", "utf8");
  assert.doesNotMatch(source, /ScheduledDatabaseBackupSettings|useScheduledDatabaseBackups|scheduledDatabaseBackup|@tauri-apps/);
  assert.doesNotMatch(source, /localStorage|destinationDirectory/);
  assert.match(source, /useWebDatabaseBackups/);
});

test("Settings dispatch keeps desktop and Web backup components separate", () => {
  const source = fs.readFileSync("apps/desktop/src/components/editor/EditorSettingsDialog.vue", "utf8");
  assert.match(source, /<WebDatabaseBackupSettings v-if="isWeb" \/>/);
  assert.match(source, /<ScheduledDatabaseBackupSettings v-else \/>/);
});

test("cancelling a Web backup accepts an empty 202 response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.match(String(input), /\/api\/database-backups\/runs\/run-1\/cancel$/);
    assert.equal(init?.method, "POST");
    return new Response(null, { status: 202 });
  }) as typeof fetch;

  try {
    await assert.doesNotReject(cancelWebDatabaseBackupRun("run-1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Web backup download URLs scope the file to its recorded run", () => {
  assert.equal(webDatabaseBackupFileDownloadUrl("run 1", "dbx-backup__nightly report.sql"), "/api/database-backups/runs/run%201/files/dbx-backup__nightly%20report.sql/download");
});
