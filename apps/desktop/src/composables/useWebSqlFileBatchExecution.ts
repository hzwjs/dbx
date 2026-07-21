import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import { preferredWebSqlFileBatch, type CreateWebSqlFileBatchRequest, type WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

export interface WebSqlFileBatchRuntime {
  create(request: CreateWebSqlFileBatchRequest): Promise<WebSqlFileBatchSnapshot>;
  list(): Promise<WebSqlFileBatchSnapshot[]>;
  get(batchId: string): Promise<WebSqlFileBatchSnapshot>;
  cancel(batchId: string): Promise<boolean>;
  listen(batchId: string, handler: (snapshot: WebSqlFileBatchSnapshot) => void): () => void;
}

export function useWebSqlFileBatchExecution(runtime: WebSqlFileBatchRuntime) {
  const batches = ref<WebSqlFileBatchSnapshot[]>([]);
  const selectedBatchId = ref<string>();
  const currentBatch = computed(() => batches.value.find((snapshot) => snapshot.batchId === selectedBatchId.value));
  const loading = ref(false);
  const starting = ref(false);
  const cancelling = ref(false);
  let unlisten: (() => void) | undefined;
  let loadGeneration = 0;
  let pendingLoads = 0;
  let active = true;

  function mergeSnapshots(snapshots: WebSqlFileBatchSnapshot[]) {
    const current = new Map(batches.value.map((snapshot) => [snapshot.batchId, snapshot]));
    const merged = snapshots.map((snapshot) => {
      const existing = current.get(snapshot.batchId);
      current.delete(snapshot.batchId);
      return existing && existing.revision >= snapshot.revision ? existing : snapshot;
    });
    batches.value = [...merged, ...current.values()];
  }

  function replaceSnapshot(snapshot: WebSqlFileBatchSnapshot) {
    const existing = batches.value.find((item) => item.batchId === snapshot.batchId);
    if (existing && existing.revision >= snapshot.revision) return;
    batches.value = existing ? batches.value.map((item) => (item.batchId === snapshot.batchId ? snapshot : item)) : [snapshot, ...batches.value];
  }

  function disconnect() {
    unlisten?.();
    unlisten = undefined;
  }

  function subscribe(batchId: string) {
    disconnect();
    if (!active) return;
    unlisten = runtime.listen(batchId, (snapshot) => {
      if (selectedBatchId.value !== batchId) return;
      replaceSnapshot(snapshot);
    });
  }

  function select(batchId: string | undefined) {
    selectedBatchId.value = batchId;
    if (batchId) subscribe(batchId);
    else disconnect();
  }

  async function load() {
    const generation = ++loadGeneration;
    pendingLoads += 1;
    loading.value = true;
    try {
      const snapshots = await runtime.list();
      if (!active || generation !== loadGeneration) return;

      mergeSnapshots(snapshots);
      const selected = selectedBatchId.value ? batches.value.find((snapshot) => snapshot.batchId === selectedBatchId.value) : undefined;
      select(selected?.batchId ?? preferredWebSqlFileBatch(batches.value)?.batchId);
    } finally {
      pendingLoads -= 1;
      loading.value = pendingLoads > 0;
    }
  }

  async function start(request: CreateWebSqlFileBatchRequest) {
    starting.value = true;
    loadGeneration += 1;
    try {
      const snapshot = await runtime.create(request);
      if (!active) return;
      loadGeneration += 1;
      replaceSnapshot(snapshot);
      select(snapshot.batchId);
    } finally {
      starting.value = false;
    }
  }

  async function cancel() {
    const batchId = selectedBatchId.value;
    if (!batchId || cancelling.value) return;

    cancelling.value = true;
    try {
      await runtime.cancel(batchId);
      const snapshot = await runtime.get(batchId);
      if (active && selectedBatchId.value === batchId) replaceSnapshot(snapshot);
    } finally {
      cancelling.value = false;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      active = false;
      loadGeneration += 1;
      disconnect();
    });
  }

  return { batches, selectedBatchId, currentBatch, loading, starting, cancelling, load, select, start, cancel, disconnect };
}
