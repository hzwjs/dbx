# Web Batch SQL File Minimal Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-owned, in-memory multi-target SQL file execution to DBX Web while preserving the existing desktop implementation and all existing single-target Web APIs.

**Architecture:** `dbx-web` owns a compact batch registry and one worker per batch. A worker loops over real saved connection IDs in submission order and delegates each target to the existing SQL-file execution path. The Web dialog uses a Web-only HTTP state adapter and reuses the current desktop batch presentation; no code under `crates/dbx-core` changes.

**Tech Stack:** Rust 2021, Axum, Tokio broadcast/CancellationToken, Vue 3 Composition API, TypeScript, Vitest, Python Playwright for final acceptance only.

## Global Constraints

- `git diff custom/main...HEAD -- crates/dbx-core` must remain empty.
- Do not add temporary connection configs, Scoped Connection Lease, driver locks, persistence, Redis, message queues, RBAC, audit, retry, rollback, deletion, or retention management.
- A batch uses only submitted real saved `connectionId` values; it never constructs synthetic `ConnectionConfig` values.
- Targets within one batch execute strictly serially in submission order; distinct batches may execute concurrently.
- Target failure never stops later targets. `continueOnError` only controls statement failures inside one target.
- Cancelling a batch cancels the active target and marks all pending targets `skipped`; no later target may start.
- Batch state is shared by all authenticated users, survives browser refresh/close, and is lost on `dbx-web` restart.
- Existing `/api/sql-file/execute`, `/api/sql-file/progress/{executionId}`, and `/api/sql-file/cancel` contracts remain compatible.
- Desktop keeps using `useSqlFileBatchExecution`; the Web server batch adapter must not replace or alter desktop orchestration.
- Production confirmation uses the currently saved frontend connection data before submission. Configuration or driver changes during execution may make a target fail.
- The existing per-execution 200 MiB limit remains; do not add a new global admission manager.
- E2E uses two temporary SQLite files and temporary Playwright artifacts; do not add Playwright or another E2E framework to project dependencies.

---

## File Map

- Create `crates/dbx-web/src/sql_file_batch.rs`: Web-only batch model, in-memory registry, target progress reducer, cancellation and serial worker.
- Modify `crates/dbx-web/src/state.rs`: own one `Arc<SqlFileBatchRegistry>`.
- Modify `crates/dbx-web/src/routes/sql_file.rs`: extract the existing file validation/read/decode/execute body into a Web-only shared helper without changing the single-target contract.
- Create `crates/dbx-web/src/routes/sql_file_batch.rs`: authenticated create/list/get/SSE/cancel handlers and real executor adapter.
- Modify `crates/dbx-web/src/routes/mod.rs` and `crates/dbx-web/src/main.rs`: register the module, state and five routes.
- Modify `crates/dbx-web/src/auth.rs`: add a regression proving the new API path is protected when password auth is enabled.
- Modify WebState test constructors in `crates/dbx-web/src/routes/connection.rs` and `crates/dbx-web/src/routes/mongo.rs` only to initialize the new registry field.
- Create `apps/desktop/src/lib/sql/webSqlFileBatch.ts`: exact HTTP DTOs and batch helpers shared by Web client code.
- Modify `apps/desktop/src/lib/backend/http.ts`: Web batch CRUD functions.
- Create `apps/desktop/src/lib/sql/httpSqlFileBatch.ts`: SSE listener returning an explicit close function.
- Create `apps/desktop/src/composables/useWebSqlFileBatchExecution.ts`: list/current/subscription/start/cancel lifecycle for server-owned batches.
- Modify `apps/desktop/src/components/sql-file/SqlFileExecutionDialog.vue`: Web multi-select, production preflight, batch selector and reuse of existing target results UI.
- Modify `apps/desktop/src/i18n/locales/en.ts` and `apps/desktop/src/i18n/locales/zh-CN.ts`: only labels needed for shared batch selection/recovery.
- Create `packages/app-tests/webSqlFileBatch.test.ts` and `packages/app-tests/useWebSqlFileBatchExecution.test.ts`: DTO/reducer and composable behavior.
- Modify `packages/app-tests/sqlFileExecutionDialog.test.ts`: compile and architecture assertions for the Web batch path while retaining desktop assertions.

---

### Task 1: Compact Web Batch Registry and Serial Worker

**Files:**
- Create: `crates/dbx-web/src/sql_file_batch.rs`
- Modify: `crates/dbx-web/src/main.rs` (declare `mod sql_file_batch;` only)

**Interfaces:**
- Consumes: `dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus}` and `tokio_util::sync::CancellationToken`.
- Produces: `CreateSqlFileBatchRequest`, `SqlFileBatchSnapshot`, `SqlFileBatchRegistry`, `SqlFileBatchExecutor`, `ProgressSink`, and `run_sql_file_batch` for Task 2.

- [ ] **Step 1: Write failing model and worker tests**

Add `#[cfg(test)]` tests in `crates/dbx-web/src/sql_file_batch.rs` with a module-local fake executor. The fake must record call order, optionally emit a configured terminal progress, and block on a `Notify` when cancellation timing is under test.

Required tests and exact observations:

```rust
#[tokio::test]
async fn targets_execute_strictly_in_submission_order() {
    let fixture = BatchFixture::new(&["a", "b"], false).await;
    fixture.executor.finish_with("a", SqlFileStatus::Done);
    fixture.executor.finish_with("b", SqlFileStatus::Done);
    fixture.run().await;
    assert_eq!(fixture.executor.connection_calls(), vec!["a", "b"]);
    let b_started = fixture.first_snapshot_with_status("b", SqlFileBatchTargetStatus::Running);
    assert_eq!(b_started.target("a").status, SqlFileBatchTargetStatus::Success);
}

#[tokio::test]
async fn failed_target_does_not_stop_the_next_target() {
    let fixture = BatchFixture::new(&["a", "b"], false).await;
    fixture.executor.finish_with("a", SqlFileStatus::Error);
    fixture.executor.finish_with("b", SqlFileStatus::Done);
    fixture.run().await;
    assert_eq!(fixture.final_statuses(), vec![SqlFileBatchTargetStatus::Failed, SqlFileBatchTargetStatus::Success]);
    assert_eq!(fixture.executor.connection_calls(), vec!["a", "b"]);
}

#[tokio::test]
async fn continue_on_error_is_forwarded_to_every_target_request() {
    let fixture = BatchFixture::new(&["a", "b"], true).await;
    fixture.run().await;
    assert!(fixture.executor.requests().iter().all(|request| request.continue_on_error));
}

#[tokio::test]
async fn cancellation_stops_active_and_skips_pending_targets() {
    let fixture = BatchFixture::new_blocked(&["a", "b"]).await;
    let worker = fixture.spawn();
    fixture.executor.wait_until_started("a").await;
    assert!(fixture.registry.cancel(&fixture.batch_id).await);
    fixture.executor.release_with("a", SqlFileStatus::Cancelled);
    worker.await.unwrap();
    assert_eq!(fixture.final_statuses(), vec![SqlFileBatchTargetStatus::Cancelled, SqlFileBatchTargetStatus::Skipped]);
    assert_eq!(fixture.executor.connection_calls(), vec!["a"]);
}

#[tokio::test]
async fn batches_have_independent_tokens_and_can_run_concurrently() {
    let registry = Arc::new(SqlFileBatchRegistry::default());
    let first = BatchFixture::new_blocked_in(registry.clone(), &["a"]).await;
    let second = BatchFixture::new_blocked_in(registry, &["b"]).await;
    let first_worker = first.spawn();
    let second_worker = second.spawn();
    first.executor.wait_until_started("a").await;
    second.executor.wait_until_started("b").await;
    assert!(first.registry.cancel(&first.batch_id).await);
    first.executor.release_with("a", SqlFileStatus::Cancelled);
    second.executor.release_with("b", SqlFileStatus::Done);
    first_worker.await.unwrap();
    second_worker.await.unwrap();
    assert_eq!(second.final_statuses(), vec![SqlFileBatchTargetStatus::Success]);
}
```

Implement `BatchFixture` and its fake executor inside the test module with exactly these helper operations; they are test-only and must not leak into production APIs.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
rtk cargo test -p dbx-web sql_file_batch::tests
```

Expected: compilation fails because the new types and worker are not implemented.

- [ ] **Step 3: Implement the exact Web-only DTOs and executor boundary**

Use serde camelCase and the exact status strings from the design:

```rust
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchSnapshot {
    pub batch_id: String,
    pub revision: u64,
    pub file_name: String,
    pub database: String,
    pub continue_on_error: bool,
    pub status: SqlFileBatchStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub targets: Vec<SqlFileBatchTarget>,
    pub summary: SqlFileBatchSummary,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileBatchStatus { Running, Cancelling, Completed, Cancelled }

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileBatchTargetStatus { Pending, Running, Success, Partial, Failed, Cancelled, Skipped }

pub type ProgressSink = Arc<dyn Fn(SqlFileProgress) + Send + Sync>;
pub type SqlFileBatchFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

pub trait SqlFileBatchExecutor: Send + Sync {
    fn execute(&self, request: SqlFileRequest, token: CancellationToken, progress: ProgressSink)
        -> SqlFileBatchFuture;
}
```

`CreateSqlFileBatchRequest` contains only `connection_ids`, `database`, `file_path`, and `continue_on_error`. The registry derives `file_name` from the validated path and generates UUIDs for the batch and targets.

- [ ] **Step 4: Implement the registry without holding locks across execution**

Each entry owns the snapshot, one batch `CancellationToken`, and `broadcast::Sender<SqlFileBatchSnapshot>`. Provide these exact operations:

```rust
impl SqlFileBatchRegistry {
    pub async fn create(&self, request: CreateSqlFileBatchRequest) -> Result<SqlFileBatchSnapshot, String>;
    pub async fn list(&self) -> Vec<SqlFileBatchSnapshot>;
    pub async fn get(&self, batch_id: &str) -> Option<SqlFileBatchSnapshot>;
    pub async fn subscribe(&self, batch_id: &str)
        -> Option<(SqlFileBatchSnapshot, broadcast::Receiver<SqlFileBatchSnapshot>)>;
    pub async fn cancel(&self, batch_id: &str) -> bool;
}
```

`create` rejects an empty list and duplicate IDs. `list` sorts by `created_at_ms` descending. Each batch starts with a server-owned monotonic `revision`; every authoritative mutation increments it under the same snapshot lock before broadcasting. Mutators lock only long enough to replace a snapshot and send its clone.

The private entry also stores the canonical `file_path`; the public snapshot does not expose it. Keep this module specific to SQL-file batches—do not introduce a generic task registry.

- [ ] **Step 5: Implement the strict serial worker and progress reducer**

```rust
pub async fn run_sql_file_batch(
    registry: Arc<SqlFileBatchRegistry>,
    batch_id: String,
    executor: Arc<dyn SqlFileBatchExecutor>,
);
```

The implementation obtains the stored target count, iterates `0..target_count`, checks the batch token before each start, marks exactly one target running, constructs `SqlFileRequest` from that target's stored real connection ID, awaits the executor, and then advances. It finishes as `completed`, or as `cancelled` after changing every remaining `pending` target to `skipped`.

Map `Done + failure_count == 0` to `success`, `Done + failure_count > 0` to `partial`, `Error` to `failed`, and `Cancelled` to `cancelled`. Convert an executor return without terminal progress to `failed` with `Execution completed without terminal progress`. Append a failure detail only for `StatementFailed` with a non-empty error.

Because the existing SQL-file progress callback is synchronous, create a `tokio::sync::mpsc::unbounded_channel<SqlFileProgress>` per target. The `ProgressSink` only sends to that channel. Pin the executor future and use `tokio::select!` to apply progress messages in order while the execution future runs; drain already queued messages before deciding whether terminal progress was missing. This avoids spawning unordered state-update tasks.

- [ ] **Step 6: Run focused tests and formatting**

Run:

```bash
rtk cargo fmt --all -- --check
rtk cargo test -p dbx-web sql_file_batch::tests
```

Expected: all new tests pass and formatting check exits 0.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/dbx-web/src/sql_file_batch.rs crates/dbx-web/src/main.rs
rtk git commit -m "feat(web): add SQL file batch registry"
```

---

### Task 2: Reuse the Existing Executor and Expose Batch HTTP APIs

**Files:**
- Modify: `crates/dbx-web/src/routes/sql_file.rs`
- Create: `crates/dbx-web/src/routes/sql_file_batch.rs`
- Modify: `crates/dbx-web/src/routes/mod.rs`
- Modify: `crates/dbx-web/src/auth.rs`
- Modify: `crates/dbx-web/src/state.rs`
- Modify: `crates/dbx-web/src/main.rs`
- Modify: `crates/dbx-web/src/routes/connection.rs`
- Modify: `crates/dbx-web/src/routes/mongo.rs`

**Interfaces:**
- Consumes: all Task 1 interfaces; existing `execute_sql_file_content`, path validation, `WebState`, and Axum auth middleware.
- Produces: five `/api/sql-file/batches` endpoints and a real `SqlFileBatchExecutor` adapter.

- [ ] **Step 1: Add failing route and compatibility tests**

Tests in `routes/sql_file_batch.rs` must construct a test `WebState`, insert a registry snapshot, and directly exercise handlers or a minimal Axum router:

```rust
#[tokio::test]
async fn list_and_get_return_the_same_shared_snapshot() {
    let created = create_test_batch().await;
    let Json(listed) = list_sql_file_batches(State(created.state.clone())).await;
    let Json(fetched) = get_sql_file_batch(State(created.state), AxumPath(created.snapshot.batch_id.clone())).await.unwrap();
    assert_eq!(listed, vec![created.snapshot.clone()]);
    assert_eq!(fetched, created.snapshot);
}

#[tokio::test]
async fn event_stream_starts_with_the_current_snapshot() {
    let created = create_test_batch().await;
    let (initial, _receiver) = created.state.sql_file_batches.subscribe(&created.snapshot.batch_id).await.unwrap();
    assert_eq!(initial, created.snapshot);
}

#[tokio::test]
async fn cancel_returns_false_for_missing_or_terminal_batches() {
    let created = create_terminal_test_batch().await;
    assert!(!created.state.sql_file_batches.cancel("missing").await);
    assert!(!created.state.sql_file_batches.cancel(&created.snapshot.batch_id).await);
}

#[tokio::test]
async fn create_rejects_paths_outside_the_uploaded_tmp_directory() {
    let result = create_test_batch_from_path(test_state().await, "/tmp/outside.sql").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn batch_api_requires_auth_when_password_is_enabled() {
    let response = request_protected_batch_route_without_session().await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
```

Implement the named test helpers inside the test module; each helper uses a unique temporary data directory and removes it after the test.

Extend the existing `routes::sql_file` tests with a helper-level test proving the original single-target function still emits `Started` then a terminal status for a temporary SQLite target.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
rtk cargo test -p dbx-web sql_file
```

Expected: compilation failure for missing routes/state/helper.

- [ ] **Step 3: Extract one shared single-target helper in the Web crate**

In `routes/sql_file.rs`, keep early read-only rejection and the public handler contract unchanged. Extract only the spawned body:

```rust
pub(crate) async fn run_validated_sql_file_request(
    app: &Arc<AppState>,
    data_dir: &Path,
    request: &SqlFileRequest,
    token: CancellationToken,
    progress: impl Fn(SqlFileProgress) + Send + Sync,
) {
    // validate canonical upload path, enforce 200 MiB, read/decode, emit Started,
    // then call execute_sql_file_content with the same request and token.
}
```

The existing `execute_sql_file` handler calls this helper inside its existing `tokio::spawn`; do not rename or remove existing routes or state maps.

- [ ] **Step 4: Add registry state and real executor adapter**

Add to `WebState`:

```rust
pub sql_file_batches: Arc<SqlFileBatchRegistry>,
```

Initialize it in `main.rs` and all WebState test constructors. `WebSqlFileBatchExecutor` checks the existing read-only guard for the current real connection ID and then calls `run_validated_sql_file_request`. A setup/read-only failure must emit one terminal `SqlFileStatus::Error` progress so the worker can continue.

- [ ] **Step 5: Implement and register five handlers**

```rust
pub async fn create_sql_file_batch(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateSqlFileBatchRequest>,
) -> Result<Json<SqlFileBatchSnapshot>, AppError>;
pub async fn list_sql_file_batches(State(state): State<Arc<WebState>>) -> Json<Vec<SqlFileBatchSnapshot>>;
pub async fn get_sql_file_batch(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Json<SqlFileBatchSnapshot>, AppError>;
pub async fn sql_file_batch_events(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError>;
pub async fn cancel_sql_file_batch(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Json<serde_json::Value>;
```

Register:

```rust
.route("/sql-file/batches", post(create_sql_file_batch).get(list_sql_file_batches))
.route("/sql-file/batches/{batchId}", get(get_sql_file_batch))
.route("/sql-file/batches/{batchId}/events", get(sql_file_batch_events))
.route("/sql-file/batches/{batchId}/cancel", post(cancel_sql_file_batch))
```

SSE concatenates a one-item stream containing the current snapshot with the broadcast receiver stream. Serialize complete snapshots only.

- [ ] **Step 6: Verify server behavior and Core scope**

```bash
rtk cargo fmt --all -- --check
rtk cargo test -p dbx-web sql_file
rtk cargo check -p dbx-web
rtk git diff custom/main...HEAD -- crates/dbx-core
```

Expected: tests/check pass; the final diff command prints nothing.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/dbx-web/src/routes/sql_file.rs crates/dbx-web/src/routes/sql_file_batch.rs crates/dbx-web/src/routes/mod.rs crates/dbx-web/src/auth.rs crates/dbx-web/src/state.rs crates/dbx-web/src/main.rs crates/dbx-web/src/routes/connection.rs crates/dbx-web/src/routes/mongo.rs
rtk git commit -m "feat(web): expose SQL file batch APIs"
```

---

### Task 3: Web Batch HTTP State Adapter

**Files:**
- Create: `apps/desktop/src/lib/sql/webSqlFileBatch.ts`
- Create: `apps/desktop/src/lib/sql/httpSqlFileBatch.ts`
- Modify: `apps/desktop/src/lib/backend/http.ts`
- Create: `apps/desktop/src/composables/useWebSqlFileBatchExecution.ts`
- Create: `packages/app-tests/webSqlFileBatch.test.ts`
- Create: `packages/app-tests/useWebSqlFileBatchExecution.test.ts`

**Interfaces:**
- Consumes: Task 2 camelCase JSON and existing `apiUrl`, HTTP `get`/`post` helpers.
- Produces: typed HTTP functions and a Web-only composable used by Task 4.

- [ ] **Step 1: Write failing DTO and composable tests**

Required tests:

```ts
test("batch snapshots preserve server target order and summary", () => {});
test("load selects the newest running batch before a terminal batch", async () => {});
test("start stores and subscribes to the returned batch", async () => {});
test("an SSE snapshot replaces rather than merges local state", async () => {});
test("switching batches closes the previous EventSource", async () => {});
test("closing the dialog subscription does not cancel the server batch", async () => {});
test("cancel delegates once and reloads the authoritative snapshot", async () => {});
test("older GET or list snapshots cannot replace a newer server revision", async () => {});
```

Use injected runtime functions in the composable tests; do not make real network calls. All local snapshot writes must compare the per-batch server `revision`, rather than using client request-arrival order.

- [ ] **Step 2: Run tests and verify failure**

```bash
rtk pnpm exec vitest run packages/app-tests/webSqlFileBatch.test.ts packages/app-tests/useWebSqlFileBatchExecution.test.ts
```

Expected: import failures for the missing files.

- [ ] **Step 3: Define exact frontend DTOs and helpers**

`webSqlFileBatch.ts` mirrors the design schema exactly and reuses `SqlFileBatchTargetState` where compatible:

```ts
export interface CreateWebSqlFileBatchRequest {
  connectionIds: string[];
  database: string;
  filePath: string;
  continueOnError: boolean;
}

export interface WebSqlFileBatchSnapshot {
  batchId: string;
  revision: number;
  fileName: string;
  database: string;
  continueOnError: boolean;
  status: "running" | "cancelling" | "completed" | "cancelled";
  createdAtMs: number;
  updatedAtMs: number;
  targets: SqlFileBatchTargetState[];
  summary: ReturnType<typeof summarizeSqlFileBatch>;
}
```

Export `isWebSqlFileBatchTerminal` and `preferredWebSqlFileBatch`: newest non-terminal first, otherwise newest snapshot.

- [ ] **Step 4: Add Web-only HTTP and SSE functions**

In `http.ts` export:

```ts
export function createSqlFileBatch(request: CreateWebSqlFileBatchRequest): Promise<WebSqlFileBatchSnapshot>;
export function listSqlFileBatches(): Promise<WebSqlFileBatchSnapshot[]>;
export function getSqlFileBatch(batchId: string): Promise<WebSqlFileBatchSnapshot>;
export function cancelSqlFileBatch(batchId: string): Promise<boolean>;
```

`httpSqlFileBatch.ts` opens ``new EventSource(apiUrl(`/api/sql-file/batches/${encodeURIComponent(batchId)}/events`))``, parses complete snapshots, and returns `() => es.close()`. Terminal events close the source. `onerror` closes it; the composable can recover on its next `load`/open.

- [ ] **Step 5: Implement the Web-only composable with runtime injection**

```ts
export interface WebSqlFileBatchRuntime {
  create(request: CreateWebSqlFileBatchRequest): Promise<WebSqlFileBatchSnapshot>;
  list(): Promise<WebSqlFileBatchSnapshot[]>;
  get(batchId: string): Promise<WebSqlFileBatchSnapshot>;
  cancel(batchId: string): Promise<boolean>;
  listen(batchId: string, handler: (snapshot: WebSqlFileBatchSnapshot) => void): () => void;
}

export function useWebSqlFileBatchExecution(runtime: WebSqlFileBatchRuntime) {
  // refs: batches, selectedBatchId, currentBatch, loading, starting, cancelling
  // methods: load, select, start, cancel, disconnect
}
```

`disconnect` closes SSE only. `load` replaces the list, selects the preferred batch when the current ID is absent, and subscribes. `start` inserts the returned snapshot, selects it and subscribes.

- [ ] **Step 6: Run focused frontend tests and typecheck**

```bash
rtk pnpm exec vitest run packages/app-tests/webSqlFileBatch.test.ts packages/app-tests/useWebSqlFileBatchExecution.test.ts
rtk pnpm typecheck
```

Expected: all focused tests pass; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
rtk git add apps/desktop/src/lib/sql/webSqlFileBatch.ts apps/desktop/src/lib/sql/httpSqlFileBatch.ts apps/desktop/src/lib/backend/http.ts apps/desktop/src/composables/useWebSqlFileBatchExecution.ts packages/app-tests/webSqlFileBatch.test.ts packages/app-tests/useWebSqlFileBatchExecution.test.ts
rtk git commit -m "feat(web): add SQL file batch client state"
```

---

### Task 4: Adapt the Existing SQL File Dialog for Web Batches

**Files:**
- Modify: `apps/desktop/src/components/sql-file/SqlFileExecutionDialog.vue`
- Modify: `apps/desktop/src/i18n/locales/en.ts`
- Modify: `apps/desktop/src/i18n/locales/zh-CN.ts`
- Modify: `packages/app-tests/sqlFileExecutionDialog.test.ts`

**Interfaces:**
- Consumes: Task 3 composable and existing desktop `useSqlFileBatchExecution`/batch presentation.
- Produces: Web multi-select submit/recovery/cancel UI while leaving desktop runtime unchanged.

- [ ] **Step 1: Replace the obsolete Web-single-target source assertions with failing Web-batch assertions**

Keep SFC compile, viewport, desktop delegation, desktop dialog-session and i18n assertions. Replace only the test named `Web keeps the original single-target selector and execution path` with assertions for:

```ts
assert.match(dialogSource, /useWebSqlFileBatchExecution/);
assert.match(dialogSource, /createSqlFileBatch/);
assert.match(dialogSource, /listSqlFileBatches/);
assert.match(dialogSource, /listenSqlFileBatch/);
assert.match(dialogSource, /selectedConnectionIds/);
assert.match(dialogSource, /webBatch\.start/);
assert.match(dialogSource, /webBatch\.cancel/);
assert.match(dialogSource, /webBatch\.load/);
```

Also compile the SFC so template regressions are caught.

- [ ] **Step 2: Run the dialog test and verify failure**

```bash
rtk pnpm exec vitest run packages/app-tests/sqlFileExecutionDialog.test.ts
```

Expected: the new Web-batch assertions fail.

- [ ] **Step 3: Wire the Web runtime without altering desktop orchestration**

Instantiate `useWebSqlFileBatchExecution` with dynamic imports or direct Web-only HTTP functions. Derive common presentation values:

```ts
const displayedBatchTargets = computed(() => isDesktop ? batchTargets.value : webBatch.currentBatch.value?.targets ?? []);
const displayedBatchSummary = computed(() => isDesktop ? batchSummary.value : webBatch.currentBatch.value?.summary ?? emptySummary());
const batchExecutionActive = computed(() => isDesktop ? batchRunning.value : webBatch.currentBatch.value?.status === "running" || webBatch.currentBatch.value?.status === "cancelling");
```

Do not route desktop calls through the Web composable.

Remove the obsolete component-local Web single-target state and handlers (`running`, `progress`, `startExecution`, `cancelExecution`, and the ID-specific single-target listener) once the template no longer references them. This is a local deletion only; the existing backend single-target APIs remain intact and tested.

- [ ] **Step 4: Reuse same-type multi-select and perform production confirmation before POST**

Show the multi-select popover in both runtimes. A fixed baseline connection determines eligible `sameTypeSqlConnections`. Before Web submission, loop selected IDs in selection order and call the existing `productionSafetyStore.requestConfirmation` for each production target using the existing preview. If any confirmation is declined, return without creating a server batch.

Submit exactly:

```ts
await webBatch.start({
  connectionIds: [...selectedConnectionIds.value],
  database: database.value.trim(),
  filePath: preview.value.filePath,
  continueOnError: continueOnError.value,
});
```

- [ ] **Step 5: Reuse result details and add the compact shared-batch selector**

The existing progress summary and target detail cards render `displayedBatchTargets` for both runtimes. In Web mode, show a compact selector only when `webBatch.batches.value.length > 1`; label entries with file name, creation time and translated batch status. Opening the dialog calls `webBatch.load()`. Closing calls `webBatch.disconnect()` and never cancels.

The Web stop button calls `webBatch.cancel()`. Refresh metadata once for each target transition into `success` or `partial`; refresh failure must not change the server snapshot.

- [ ] **Step 6: Add only required English and Chinese labels**

Add keys under `sqlFile` for `sharedBatches`, `selectBatch`, and the four batch-level statuses. Do not translate unrelated strings or edit other locales.

- [ ] **Step 7: Run frontend regression gates**

```bash
rtk pnpm exec vitest run packages/app-tests/sqlFileBatchDialogSession.test.ts packages/app-tests/sqlFileBatchExecution.test.ts packages/app-tests/sqlFileExecutionDialog.test.ts packages/app-tests/useSqlFileBatchExecution.test.ts packages/app-tests/webSqlFileBatch.test.ts packages/app-tests/useWebSqlFileBatchExecution.test.ts
rtk pnpm typecheck
rtk pnpm fmt
rtk git diff --check
```

Expected: all focused tests pass (at least the original 39 plus new tests), typecheck passes and formatting leaves no unexpected files.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/desktop/src/components/sql-file/SqlFileExecutionDialog.vue apps/desktop/src/i18n/locales/en.ts apps/desktop/src/i18n/locales/zh-CN.ts packages/app-tests/sqlFileExecutionDialog.test.ts
rtk git commit -m "feat(web): enable multi-target SQL file batches"
```

---

## Controller Acceptance Gate

After all four task reviews are clean, the controlling agent—not an implementer—runs these gates.

### Static and focused regression

```bash
rtk cargo fmt --all -- --check
rtk cargo test -p dbx-web sql_file
rtk cargo check -p dbx-web
rtk pnpm exec vitest run packages/app-tests/sqlFileBatchDialogSession.test.ts packages/app-tests/sqlFileBatchExecution.test.ts packages/app-tests/sqlFileExecutionDialog.test.ts packages/app-tests/useSqlFileBatchExecution.test.ts packages/app-tests/webSqlFileBatch.test.ts packages/app-tests/useWebSqlFileBatchExecution.test.ts
rtk pnpm typecheck
rtk git diff --check
rtk git diff custom/main...HEAD -- crates/dbx-core
```

The final command must print nothing.

### Real E2E

Use `/Users/huangzhiwen/.codex/skills/webapp-testing/scripts/with_server.py` after confirming `--help`. Create a unique `/tmp/dbx-batch-sql-e2e.XXXXXX` directory and run:

```bash
env DBX_E2E_DIR=<unique-dir> python /Users/huangzhiwen/.codex/skills/webapp-testing/scripts/with_server.py \
  --server "env DBX_DATA_DIR=<unique-dir>/data DBX_PORT=44224 DBX_DISABLE_PASSWORD=1 cargo run -p dbx-web" --port 44224 \
  --server "env DBX_BACKEND_URL=http://127.0.0.1:44224 pnpm exec vite --config apps/desktop/vite.config.ts --port 45173 --mode web" --port 45173 \
  --timeout 120 \
  -- python <temporary-playwright-acceptance-script>
```

The temporary Python script must:

1. Seed two SQLite connections through `/api/connection/save`.
2. Create a long SQL fixture with a marker table and enough independent inserts to observe running state.
3. Use browser context A to upload, select A/B in order and start.
4. Poll `/api/sql-file/batches/{batchId}` and assert no snapshot has two running targets and B never leaves pending before A is terminal.
5. Reload context A mid-run, reopen the dialog and assert the same batch is restored.
6. Open context B and assert the same batch ID, target states and summary are visible.
7. Verify both SQLite files contain the success marker.
8. Start a second long batch, cancel while A is running, assert A is cancelled, B is skipped, and B has no cancellation-fixture marker.
9. On failure, save `failure.png`, console errors, failed requests and `last-snapshot.json` under the unique directory.

Pass criteria: all assertions pass, no unexpected browser console error or failed API response occurs, and the Core diff remains empty.
