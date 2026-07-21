import { computed, ref } from "vue";
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
  let snapshotRevision = 0;

  function replaceSnapshot(snapshot: WebSqlFileBatchSnapshot) {
    snapshotRevision += 1;
    const existing = batches.value.some((item) => item.batchId === snapshot.batchId);
    batches.value = existing ? batches.value.map((item) => (item.batchId === snapshot.batchId ? snapshot : item)) : [snapshot, ...batches.value];
  }

  function disconnect() {
    unlisten?.();
    unlisten = undefined;
  }

  function subscribe(batchId: string) {
    disconnect();
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
      if (generation !== loadGeneration) return;

      batches.value = snapshots;
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
      loadGeneration += 1;
      batches.value = [snapshot, ...batches.value.filter((item) => item.batchId !== snapshot.batchId)];
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
      const revisionAtRequest = snapshotRevision;
      const snapshot = await runtime.get(batchId);
      if (revisionAtRequest === snapshotRevision && selectedBatchId.value === batchId) replaceSnapshot(snapshot);
    } finally {
      cancelling.value = false;
    }
  }

  return { batches, selectedBatchId, currentBatch, loading, starting, cancelling, load, select, start, cancel, disconnect };
}
