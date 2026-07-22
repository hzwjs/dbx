import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  cancelWebDatabaseBackupRun,
  createWebDatabaseBackupSchedule,
  deleteWebDatabaseBackupRun,
  deleteWebDatabaseBackupSchedule,
  getWebDatabaseBackupConfig,
  listWebDatabaseBackupRuns,
  listWebDatabaseBackupSchedules,
  runWebDatabaseBackupSchedule,
  updateWebDatabaseBackupSchedule,
} from "@/lib/web-backup/webDatabaseBackupApi";
import { webDatabaseBackupScheduleInput, type WebDatabaseBackupConfig, type WebDatabaseBackupRun, type WebDatabaseBackupSchedule, type WebDatabaseBackupScheduleInput } from "@/lib/web-backup/webDatabaseBackup";

const ACTIVE_POLL_INTERVAL_MS = 2_000;
const IDLE_POLL_INTERVAL_MS = 15_000;

export function useWebDatabaseBackups() {
  const config = ref<WebDatabaseBackupConfig | null>(null);
  const schedules = ref<WebDatabaseBackupSchedule[]>([]);
  const runs = ref<WebDatabaseBackupRun[]>([]);
  const loading = ref(true);
  const error = ref("");
  let stopped = false;
  let pollTimer: ReturnType<typeof window.setTimeout> | undefined;

  const activeRuns = computed(() => runs.value.filter((run) => run.status === "running"));
  const activeScheduleIds = computed(() => new Set(activeRuns.value.map((run) => run.scheduleId)));

  async function refresh() {
    try {
      const [nextConfig, nextSchedules, nextRuns] = await Promise.all([getWebDatabaseBackupConfig(), listWebDatabaseBackupSchedules(), listWebDatabaseBackupRuns()]);
      config.value = nextConfig;
      schedules.value = nextSchedules;
      runs.value = nextRuns;
      error.value = "";
    } catch (reason: any) {
      error.value = reason?.message || String(reason);
    } finally {
      loading.value = false;
    }
  }

  function schedulePoll() {
    if (stopped) return;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(
      async () => {
        await refresh();
        schedulePoll();
      },
      activeRuns.value.length > 0 ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
  }

  async function refreshAfter<T>(operation: Promise<T>): Promise<T> {
    const result = await operation;
    await refresh();
    schedulePoll();
    return result;
  }

  function saveSchedule(input: WebDatabaseBackupScheduleInput, scheduleId?: string) {
    return refreshAfter(scheduleId ? updateWebDatabaseBackupSchedule(scheduleId, input) : createWebDatabaseBackupSchedule(input));
  }

  function setScheduleEnabled(schedule: WebDatabaseBackupSchedule, enabled: boolean) {
    return saveSchedule({ ...webDatabaseBackupScheduleInput(schedule), enabled }, schedule.id);
  }

  function deleteSchedule(scheduleId: string) {
    return refreshAfter(deleteWebDatabaseBackupSchedule(scheduleId));
  }

  function runSchedule(scheduleId: string) {
    return refreshAfter(runWebDatabaseBackupSchedule(scheduleId));
  }

  function cancelRun(runId: string) {
    return refreshAfter(cancelWebDatabaseBackupRun(runId));
  }

  function deleteRun(runId: string) {
    return refreshAfter(deleteWebDatabaseBackupRun(runId));
  }

  onMounted(async () => {
    stopped = false;
    await refresh();
    schedulePoll();
  });

  onUnmounted(() => {
    stopped = true;
    if (pollTimer) window.clearTimeout(pollTimer);
  });

  return {
    config,
    schedules,
    runs,
    activeRuns,
    activeScheduleIds,
    loading,
    error,
    refresh,
    saveSchedule,
    setScheduleEnabled,
    deleteSchedule,
    runSchedule,
    cancelRun,
    deleteRun,
  };
}
