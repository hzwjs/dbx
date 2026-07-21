use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSqlFileBatchRequest {
    pub connection_ids: Vec<String>,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchSnapshot {
    pub batch_id: String,
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
pub enum SqlFileBatchStatus {
    Running,
    Cancelling,
    Completed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileBatchTargetStatus {
    Pending,
    Running,
    Success,
    Partial,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchTarget {
    pub connection_id: String,
    pub execution_id: String,
    pub status: SqlFileBatchTargetStatus,
    pub statement_index: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: String,
    pub failures: Vec<SqlFileBatchFailure>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchFailure {
    pub statement_index: usize,
    pub statement_summary: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchSummary {
    pub success: usize,
    pub partial: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub skipped: usize,
}

pub type ProgressSink = Arc<dyn Fn(SqlFileProgress) + Send + Sync>;
pub type SqlFileBatchFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

pub trait SqlFileBatchExecutor: Send + Sync {
    fn execute(&self, request: SqlFileRequest, token: CancellationToken, progress: ProgressSink) -> SqlFileBatchFuture;
}

#[derive(Default)]
pub struct SqlFileBatchRegistry {
    entries: RwLock<HashMap<String, Arc<SqlFileBatchEntry>>>,
}

struct SqlFileBatchEntry {
    snapshot: Mutex<SqlFileBatchSnapshot>,
    file_path: String,
    token: CancellationToken,
    updates: broadcast::Sender<SqlFileBatchSnapshot>,
    #[cfg(test)]
    test_hooks: SqlFileBatchTestHooks,
}

#[cfg(test)]
#[derive(Default)]
struct SqlFileBatchTestHooks {
    before_target_invoke: std::sync::Mutex<HashMap<usize, Arc<TestGate>>>,
    before_subscribe: std::sync::Mutex<Option<Arc<TestGate>>>,
    before_broadcast: std::sync::Mutex<Option<Arc<TestGate>>>,
    before_cancel_lock: std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>,
    before_finish_completed: std::sync::Mutex<Option<Arc<TestGate>>>,
}

#[cfg(test)]
impl SqlFileBatchEntry {
    async fn wait_before_target_invoke(&self, target_index: usize) {
        let gate = { self.test_hooks.before_target_invoke.lock().unwrap().remove(&target_index) };
        if let Some(gate) = gate {
            gate.wait_for_release().await;
        }
    }

    async fn wait_before_subscribe(&self) {
        let gate = { self.test_hooks.before_subscribe.lock().unwrap().take() };
        if let Some(gate) = gate {
            gate.wait_for_release().await;
        }
    }

    async fn wait_before_broadcast(&self) {
        let gate = { self.test_hooks.before_broadcast.lock().unwrap().take() };
        if let Some(gate) = gate {
            gate.wait_for_release().await;
        }
    }

    fn notify_before_cancel_lock(&self) {
        if let Some(notify) = self.test_hooks.before_cancel_lock.lock().unwrap().take() {
            notify.notify_one();
        }
    }

    async fn wait_before_finish_completed(&self) {
        let gate = { self.test_hooks.before_finish_completed.lock().unwrap().take() };
        if let Some(gate) = gate {
            gate.wait_for_release().await;
        }
    }
}

impl SqlFileBatchRegistry {
    pub async fn create(&self, request: CreateSqlFileBatchRequest) -> Result<SqlFileBatchSnapshot, String> {
        if request.connection_ids.is_empty() {
            return Err("At least one connection ID is required".to_string());
        }
        let unique_ids: HashSet<_> = request.connection_ids.iter().collect();
        if unique_ids.len() != request.connection_ids.len() {
            return Err("Connection IDs must be unique".to_string());
        }
        let file_name = Path::new(&request.file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "File path must include a file name".to_string())?
            .to_string();
        let timestamp = now_ms();
        let batch_id = uuid::Uuid::new_v4().to_string();
        let targets = request
            .connection_ids
            .into_iter()
            .map(|connection_id| SqlFileBatchTarget {
                connection_id,
                execution_id: uuid::Uuid::new_v4().to_string(),
                status: SqlFileBatchTargetStatus::Pending,
                statement_index: 0,
                success_count: 0,
                failure_count: 0,
                affected_rows: 0,
                elapsed_ms: 0,
                statement_summary: String::new(),
                error: String::new(),
                failures: Vec::new(),
            })
            .collect();
        let mut snapshot = SqlFileBatchSnapshot {
            batch_id: batch_id.clone(),
            file_name,
            database: request.database,
            continue_on_error: request.continue_on_error,
            status: SqlFileBatchStatus::Running,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            targets,
            summary: SqlFileBatchSummary::default(),
        };
        update_summary(&mut snapshot);
        let (updates, _) = broadcast::channel(64);
        let entry = Arc::new(SqlFileBatchEntry {
            snapshot: Mutex::new(snapshot.clone()),
            file_path: request.file_path,
            token: CancellationToken::new(),
            updates,
            #[cfg(test)]
            test_hooks: SqlFileBatchTestHooks::default(),
        });
        self.entries.write().await.insert(batch_id, entry);
        Ok(snapshot)
    }

    pub async fn list(&self) -> Vec<SqlFileBatchSnapshot> {
        let entries: Vec<_> = self.entries.read().await.values().cloned().collect();
        let mut snapshots = Vec::with_capacity(entries.len());
        for entry in entries {
            snapshots.push(entry.snapshot.lock().await.clone());
        }
        snapshots.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        snapshots
    }

    pub async fn get(&self, batch_id: &str) -> Option<SqlFileBatchSnapshot> {
        let entry = self.entry(batch_id).await?;
        let snapshot = entry.snapshot.lock().await.clone();
        Some(snapshot)
    }

    #[cfg(test)]
    pub(crate) async fn test_file_path(&self, batch_id: &str) -> Option<String> {
        self.entry(batch_id).await.map(|entry| entry.file_path.clone())
    }

    pub async fn subscribe(
        &self,
        batch_id: &str,
    ) -> Option<(SqlFileBatchSnapshot, broadcast::Receiver<SqlFileBatchSnapshot>)> {
        let entry = self.entry(batch_id).await?;
        let (snapshot, receiver) = {
            let snapshot = entry.snapshot.lock().await;
            #[cfg(test)]
            entry.wait_before_subscribe().await;
            let receiver = entry.updates.subscribe();
            (snapshot.clone(), receiver)
        };
        Some((snapshot, receiver))
    }

    pub async fn cancel(&self, batch_id: &str) -> bool {
        let Some(entry) = self.entry(batch_id).await else {
            return false;
        };
        #[cfg(test)]
        entry.notify_before_cancel_lock();
        let mut snapshot = entry.snapshot.lock().await;
        if snapshot.status != SqlFileBatchStatus::Running {
            return false;
        }
        entry.token.cancel();
        let mut updated = snapshot.clone();
        updated.status = SqlFileBatchStatus::Cancelling;
        updated.updated_at_ms = now_ms();
        update_summary(&mut updated);
        *snapshot = updated.clone();
        let _ = entry.updates.send(updated);
        drop(snapshot);
        true
    }

    async fn entry(&self, batch_id: &str) -> Option<Arc<SqlFileBatchEntry>> {
        self.entries.read().await.get(batch_id).cloned()
    }
}

pub async fn run_sql_file_batch(
    registry: Arc<SqlFileBatchRegistry>,
    batch_id: String,
    executor: Arc<dyn SqlFileBatchExecutor>,
) {
    let Some(entry) = registry.entry(&batch_id).await else {
        return;
    };
    let target_count = entry.snapshot.lock().await.targets.len();

    for target_index in 0..target_count {
        let start = {
            let mut snapshot = entry.snapshot.lock().await;
            if entry.token.is_cancelled() {
                None
            } else {
                let target = &snapshot.targets[target_index];
                let execution_id = target.execution_id.clone();
                let request = SqlFileRequest {
                    execution_id: execution_id.clone(),
                    connection_id: target.connection_id.clone(),
                    database: snapshot.database.clone(),
                    file_path: entry.file_path.clone(),
                    continue_on_error: snapshot.continue_on_error,
                };
                let mut updated = snapshot.clone();
                updated.targets[target_index].status = SqlFileBatchTargetStatus::Running;
                updated.updated_at_ms = now_ms();
                update_summary(&mut updated);
                *snapshot = updated.clone();
                let _ = entry.updates.send(updated);

                let (progress_tx, progress_rx) = tokio::sync::mpsc::unbounded_channel();
                let progress: ProgressSink = Arc::new(move |progress| {
                    let _ = progress_tx.send(progress);
                });
                #[cfg(test)]
                entry.wait_before_target_invoke(target_index).await;
                let execution = executor.execute(request, entry.token.clone(), progress);
                Some((execution_id, execution, progress_rx))
            }
        };
        let Some((execution_id, execution, mut progress_rx)) = start else {
            finish_cancelled(&entry).await;
            return;
        };
        tokio::pin!(execution);
        let mut execution_finished = false;
        let mut terminal_progress = None;

        while !execution_finished {
            tokio::select! {
                Some(progress) = progress_rx.recv() => {
                    if is_terminal(progress.status) {
                        terminal_progress = Some(progress.clone());
                    }
                    apply_progress(&entry, &execution_id, progress).await;
                }
                _ = &mut execution => execution_finished = true,
            }
        }
        while let Ok(progress) = progress_rx.try_recv() {
            if is_terminal(progress.status) {
                terminal_progress = Some(progress.clone());
            }
            apply_progress(&entry, &execution_id, progress).await;
        }
        if terminal_progress.is_none() {
            update_entry(&entry, |snapshot| {
                let target = &mut snapshot.targets[target_index];
                target.status = SqlFileBatchTargetStatus::Failed;
                target.error = "Execution completed without terminal progress".to_string();
            })
            .await;
        }
        if entry.token.is_cancelled() {
            finish_cancelled(&entry).await;
            return;
        }
    }

    #[cfg(test)]
    entry.wait_before_finish_completed().await;
    let mut snapshot = entry.snapshot.lock().await;
    let mut updated = snapshot.clone();
    if entry.token.is_cancelled() {
        for target in &mut updated.targets {
            if target.status == SqlFileBatchTargetStatus::Pending {
                target.status = SqlFileBatchTargetStatus::Skipped;
            }
        }
        updated.status = SqlFileBatchStatus::Cancelled;
    } else {
        updated.status = SqlFileBatchStatus::Completed;
    }
    updated.updated_at_ms = now_ms();
    update_summary(&mut updated);
    *snapshot = updated.clone();
    let _ = entry.updates.send(updated);
    drop(snapshot);
}

async fn apply_progress(entry: &SqlFileBatchEntry, execution_id: &str, progress: SqlFileProgress) {
    update_entry(entry, |snapshot| {
        let Some(target) = snapshot.targets.iter_mut().find(|target| target.execution_id == execution_id) else {
            return;
        };
        let error = progress.error.unwrap_or_default();
        if progress.status == SqlFileStatus::StatementFailed && !error.is_empty() {
            target.failures.push(SqlFileBatchFailure {
                statement_index: progress.statement_index,
                statement_summary: progress.statement_summary.clone(),
                error: error.clone(),
            });
        }
        target.statement_index = progress.statement_index;
        target.success_count = progress.success_count;
        target.failure_count = progress.failure_count.max(target.failures.len());
        target.affected_rows = progress.affected_rows;
        target.elapsed_ms = progress.elapsed_ms;
        target.statement_summary = progress.statement_summary;
        target.error = error;
        target.status = match progress.status {
            SqlFileStatus::Done => {
                if target.failure_count == 0 {
                    SqlFileBatchTargetStatus::Success
                } else {
                    SqlFileBatchTargetStatus::Partial
                }
            }
            SqlFileStatus::Error => SqlFileBatchTargetStatus::Failed,
            SqlFileStatus::Cancelled => SqlFileBatchTargetStatus::Cancelled,
            SqlFileStatus::Started
            | SqlFileStatus::Running
            | SqlFileStatus::StatementDone
            | SqlFileStatus::StatementFailed => SqlFileBatchTargetStatus::Running,
        };
    })
    .await;
}

async fn finish_cancelled(entry: &SqlFileBatchEntry) {
    update_entry(entry, |snapshot| {
        for target in &mut snapshot.targets {
            if target.status == SqlFileBatchTargetStatus::Pending {
                target.status = SqlFileBatchTargetStatus::Skipped;
            }
        }
        snapshot.status = SqlFileBatchStatus::Cancelled;
    })
    .await;
}

async fn update_entry(entry: &SqlFileBatchEntry, update: impl FnOnce(&mut SqlFileBatchSnapshot)) {
    let mut snapshot = entry.snapshot.lock().await;
    let mut updated = snapshot.clone();
    update(&mut updated);
    updated.updated_at_ms = now_ms();
    update_summary(&mut updated);
    *snapshot = updated.clone();
    #[cfg(test)]
    entry.wait_before_broadcast().await;
    let _ = entry.updates.send(updated);
    drop(snapshot);
}

#[cfg(test)]
#[derive(Default)]
struct TestGate {
    arrived: tokio::sync::Notify,
    released: tokio::sync::Notify,
}

#[cfg(test)]
impl TestGate {
    async fn wait_until_arrived(&self) {
        self.arrived.notified().await;
    }

    async fn wait_for_release(&self) {
        self.arrived.notify_one();
        self.released.notified().await;
    }

    fn release(&self) {
        self.released.notify_one();
    }
}

fn update_summary(snapshot: &mut SqlFileBatchSnapshot) {
    let mut summary = SqlFileBatchSummary::default();
    for target in &snapshot.targets {
        match target.status {
            SqlFileBatchTargetStatus::Pending | SqlFileBatchTargetStatus::Running => {}
            SqlFileBatchTargetStatus::Success => summary.success += 1,
            SqlFileBatchTargetStatus::Partial => summary.partial += 1,
            SqlFileBatchTargetStatus::Failed => summary.failed += 1,
            SqlFileBatchTargetStatus::Cancelled => summary.cancelled += 1,
            SqlFileBatchTargetStatus::Skipped => summary.skipped += 1,
        }
    }
    snapshot.summary = summary;
}

fn is_terminal(status: SqlFileStatus) -> bool {
    matches!(status, SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
    use tokio::sync::{broadcast, Notify};

    use super::*;

    #[tokio::test]
    async fn serialized_target_and_summary_match_the_approved_contract() {
        let registry = SqlFileBatchRegistry::default();
        let snapshot = registry.create(batch_request(&["saved-a"])).await.unwrap();
        let target = serde_json::to_value(&snapshot.targets[0]).unwrap();
        let summary = serde_json::to_value(&snapshot.summary).unwrap();

        let target_keys: BTreeSet<_> = target.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            target_keys,
            BTreeSet::from([
                "affectedRows",
                "connectionId",
                "elapsedMs",
                "error",
                "executionId",
                "failureCount",
                "failures",
                "statementIndex",
                "statementSummary",
                "status",
                "successCount",
            ])
        );
        assert!(target["error"].is_string());
        assert_eq!(
            summary.as_object().unwrap().keys().map(String::as_str).collect::<BTreeSet<_>>(),
            BTreeSet::from(["cancelled", "failed", "partial", "skipped", "success"])
        );
    }

    #[tokio::test]
    async fn statement_failure_then_done_reduces_to_structured_partial_target() {
        let registry = SqlFileBatchRegistry::default();
        let snapshot = registry.create(batch_request(&["saved-a"])).await.unwrap();
        let execution_id =
            serde_json::to_value(&snapshot.targets[0]).unwrap()["executionId"].as_str().unwrap().to_string();
        let entry = registry.entry(&snapshot.batch_id).await.unwrap();

        apply_progress(
            &entry,
            &execution_id,
            SqlFileProgress {
                execution_id: execution_id.clone(),
                status: SqlFileStatus::StatementFailed,
                statement_index: 3,
                success_count: 1,
                failure_count: 0,
                affected_rows: 4,
                elapsed_ms: 5,
                statement_summary: "insert failed".to_string(),
                error: Some("syntax error".to_string()),
            },
        )
        .await;
        apply_progress(
            &entry,
            &execution_id,
            SqlFileProgress {
                execution_id: execution_id.clone(),
                status: SqlFileStatus::Done,
                statement_index: 4,
                success_count: 2,
                failure_count: 0,
                affected_rows: 7,
                elapsed_ms: 9,
                statement_summary: "finished".to_string(),
                error: None,
            },
        )
        .await;

        let target = serde_json::to_value(&registry.get(&snapshot.batch_id).await.unwrap().targets[0]).unwrap();
        assert_eq!(target["status"], "partial");
        assert_eq!(target["statementIndex"], 4);
        assert_eq!(target["successCount"], 2);
        assert_eq!(target["failureCount"], 1);
        assert_eq!(target["affectedRows"], 7);
        assert_eq!(target["elapsedMs"], 9);
        assert_eq!(target["statementSummary"], "finished");
        assert_eq!(target["error"], "");
        assert_eq!(
            target["failures"],
            serde_json::json!([{
                "statementIndex": 3,
                "statementSummary": "insert failed",
                "error": "syntax error"
            }])
        );
    }

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
        assert_eq!(
            fixture.final_statuses(),
            vec![SqlFileBatchTargetStatus::Cancelled, SqlFileBatchTargetStatus::Skipped]
        );
        assert_eq!(fixture.executor.connection_calls(), vec!["a"]);
    }

    #[tokio::test]
    async fn cancel_rejects_terminal_and_repeated_cancellation() {
        let registry = Arc::new(SqlFileBatchRegistry::default());
        let snapshot = registry.create(batch_request(&["a"])).await.unwrap();

        assert!(registry.cancel(&snapshot.batch_id).await);
        assert!(!registry.cancel(&snapshot.batch_id).await);

        let completed = registry.create(batch_request(&["b"])).await.unwrap();
        let executor = Arc::new(FakeExecutor::new(false));
        run_sql_file_batch(registry.clone(), completed.batch_id.clone(), executor).await;
        assert_eq!(registry.get(&completed.batch_id).await.unwrap().status, SqlFileBatchStatus::Completed);
        assert!(!registry.cancel(&completed.batch_id).await);
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

    #[tokio::test]
    async fn cancellation_waits_for_the_started_target_to_be_invoked() {
        let fixture = BatchFixture::new_blocked(&["a", "b"]).await;
        let entry = fixture.registry.entry(&fixture.batch_id).await.unwrap();
        let gate = Arc::new(TestGate::default());
        entry.test_hooks.before_target_invoke.lock().unwrap().insert(1, gate.clone());
        let cancel_attempted = Arc::new(Notify::new());
        *entry.test_hooks.before_cancel_lock.lock().unwrap() = Some(cancel_attempted.clone());

        let worker = fixture.spawn();
        fixture.executor.wait_until_started("a").await;
        fixture.executor.release_with("a", SqlFileStatus::Done);
        gate.wait_until_arrived().await;
        let batch_id = fixture.batch_id.clone();
        let registry = fixture.registry.clone();
        let mut cancel = tokio::spawn(async move { registry.cancel(&batch_id).await });
        cancel_attempted.notified().await;
        assert!(!cancel.is_finished());
        gate.release();
        fixture.executor.wait_until_started("b").await;
        assert!(cancel.await.unwrap());
        fixture.executor.release_with("b", SqlFileStatus::Cancelled);
        worker.await.unwrap();

        assert_eq!(fixture.executor.connection_calls(), vec!["a", "b"]);
    }

    #[tokio::test]
    async fn subscription_creation_blocks_a_competing_cancellation_until_receiver_exists() {
        let registry = Arc::new(SqlFileBatchRegistry::default());
        let snapshot = registry.create(batch_request(&["a"])).await.unwrap();
        let entry = registry.entry(&snapshot.batch_id).await.unwrap();
        let gate = Arc::new(TestGate::default());
        *entry.test_hooks.before_subscribe.lock().unwrap() = Some(gate.clone());
        let cancel_attempted = Arc::new(Notify::new());
        *entry.test_hooks.before_cancel_lock.lock().unwrap() = Some(cancel_attempted.clone());

        let batch_id = snapshot.batch_id.clone();
        let subscriber_registry = registry.clone();
        let subscriber = tokio::spawn(async move { subscriber_registry.subscribe(&batch_id).await.unwrap() });
        gate.wait_until_arrived().await;
        let batch_id = snapshot.batch_id.clone();
        let cancel_registry = registry.clone();
        let mut cancel = tokio::spawn(async move { cancel_registry.cancel(&batch_id).await });
        cancel_attempted.notified().await;
        assert!(!cancel.is_finished());
        gate.release();
        let (initial, mut updates) = subscriber.await.unwrap();
        assert!(cancel.await.unwrap());

        let update = updates.try_recv().ok();
        assert!(
            initial.status == SqlFileBatchStatus::Cancelling
                || update.is_some_and(|snapshot| snapshot.status == SqlFileBatchStatus::Cancelling)
        );
    }

    #[tokio::test]
    async fn broadcast_of_running_precedes_a_competing_cancelling_snapshot() {
        let registry = Arc::new(SqlFileBatchRegistry::default());
        let snapshot = registry.create(batch_request(&["a"])).await.unwrap();
        let entry = registry.entry(&snapshot.batch_id).await.unwrap();
        let (_, mut updates) = registry.subscribe(&snapshot.batch_id).await.unwrap();
        let gate = Arc::new(TestGate::default());
        *entry.test_hooks.before_broadcast.lock().unwrap() = Some(gate.clone());
        let cancel_attempted = Arc::new(Notify::new());
        *entry.test_hooks.before_cancel_lock.lock().unwrap() = Some(cancel_attempted.clone());

        let entry_for_update = entry.clone();
        let update = tokio::spawn(async move {
            update_entry(&entry_for_update, |snapshot| {
                snapshot.targets[0].status = SqlFileBatchTargetStatus::Running;
            })
            .await;
        });
        gate.wait_until_arrived().await;
        let batch_id = snapshot.batch_id.clone();
        let cancel_registry = registry.clone();
        let mut cancel = tokio::spawn(async move { cancel_registry.cancel(&batch_id).await });
        cancel_attempted.notified().await;
        assert!(!cancel.is_finished());
        gate.release();
        update.await.unwrap();
        assert!(cancel.await.unwrap());

        let statuses: Vec<_> = std::iter::from_fn(|| updates.try_recv().ok()).map(|snapshot| snapshot.status).collect();
        let cancelling = statuses.iter().position(|status| *status == SqlFileBatchStatus::Cancelling).unwrap();
        assert!(!statuses[cancelling + 1..].contains(&SqlFileBatchStatus::Running));
    }

    #[tokio::test]
    async fn accepted_cancel_before_finalization_cannot_be_overwritten_by_completed() {
        let fixture = BatchFixture::new(&["a"], false).await;
        fixture.executor.finish_with("a", SqlFileStatus::Done);
        let entry = fixture.registry.entry(&fixture.batch_id).await.unwrap();
        let gate = Arc::new(TestGate::default());
        *entry.test_hooks.before_finish_completed.lock().unwrap() = Some(gate.clone());

        let worker = fixture.spawn();
        gate.wait_until_arrived().await;
        assert!(fixture.registry.cancel(&fixture.batch_id).await);
        gate.release();
        worker.await.unwrap();

        assert_eq!(fixture.registry.get(&fixture.batch_id).await.unwrap().status, SqlFileBatchStatus::Cancelled);
    }

    fn batch_request(connection_ids: &[&str]) -> CreateSqlFileBatchRequest {
        CreateSqlFileBatchRequest {
            connection_ids: connection_ids.iter().map(|connection_id| (*connection_id).to_string()).collect(),
            database: "db".to_string(),
            file_path: "/tmp/import.sql".to_string(),
            continue_on_error: false,
        }
    }

    struct BatchFixture {
        registry: Arc<SqlFileBatchRegistry>,
        executor: Arc<FakeExecutor>,
        batch_id: String,
        snapshots: Arc<Mutex<Vec<SqlFileBatchSnapshot>>>,
        receiver: Arc<tokio::sync::Mutex<broadcast::Receiver<SqlFileBatchSnapshot>>>,
    }

    impl BatchFixture {
        async fn new(connection_ids: &[&str], continue_on_error: bool) -> Self {
            Self::new_in(Arc::new(SqlFileBatchRegistry::default()), connection_ids, continue_on_error, false).await
        }

        async fn new_blocked(connection_ids: &[&str]) -> Self {
            Self::new_in(Arc::new(SqlFileBatchRegistry::default()), connection_ids, false, true).await
        }

        async fn new_blocked_in(registry: Arc<SqlFileBatchRegistry>, connection_ids: &[&str]) -> Self {
            Self::new_in(registry, connection_ids, false, true).await
        }

        async fn new_in(
            registry: Arc<SqlFileBatchRegistry>,
            connection_ids: &[&str],
            continue_on_error: bool,
            blocked: bool,
        ) -> Self {
            let snapshot = registry
                .create(CreateSqlFileBatchRequest {
                    connection_ids: connection_ids.iter().map(|id| (*id).to_string()).collect(),
                    database: "db".to_string(),
                    file_path: "/tmp/import.sql".to_string(),
                    continue_on_error,
                })
                .await
                .unwrap();
            let (_, receiver) = registry.subscribe(&snapshot.batch_id).await.unwrap();
            Self {
                registry,
                executor: Arc::new(FakeExecutor::new(blocked)),
                batch_id: snapshot.batch_id.clone(),
                snapshots: Arc::new(Mutex::new(vec![snapshot])),
                receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
            }
        }

        async fn run(&self) {
            self.spawn().await.unwrap();
        }

        fn spawn(&self) -> tokio::task::JoinHandle<()> {
            let registry = self.registry.clone();
            let batch_id = self.batch_id.clone();
            let executor = self.executor.clone();
            let snapshots = self.snapshots.clone();
            let receiver = self.receiver.clone();
            tokio::spawn(async move {
                run_sql_file_batch(registry, batch_id, executor).await;
                let mut receiver = receiver.lock().await;
                let mut snapshots = snapshots.lock().unwrap();
                while let Ok(snapshot) = receiver.try_recv() {
                    snapshots.push(snapshot);
                }
            })
        }

        fn first_snapshot_with_status(
            &self,
            connection_id: &str,
            status: SqlFileBatchTargetStatus,
        ) -> SqlFileBatchSnapshot {
            self.snapshots
                .lock()
                .unwrap()
                .iter()
                .find(|snapshot| snapshot.target(connection_id).status == status)
                .cloned()
                .unwrap()
        }

        fn final_statuses(&self) -> Vec<SqlFileBatchTargetStatus> {
            self.snapshots.lock().unwrap().last().unwrap().targets.iter().map(|target| target.status).collect()
        }
    }

    trait SnapshotTarget {
        fn target(&self, connection_id: &str) -> &SqlFileBatchTarget;
    }

    impl SnapshotTarget for SqlFileBatchSnapshot {
        fn target(&self, connection_id: &str) -> &SqlFileBatchTarget {
            self.targets.iter().find(|target| target.connection_id == connection_id).unwrap()
        }
    }

    struct FakeExecutor {
        blocked: bool,
        calls: Mutex<Vec<String>>,
        requests: Mutex<Vec<SqlFileRequest>>,
        terminal_statuses: Mutex<HashMap<String, SqlFileStatus>>,
        started: Mutex<HashSet<String>>,
        started_notify: Notify,
        releases: Arc<Mutex<HashMap<String, SqlFileStatus>>>,
        release_notify: Arc<Notify>,
    }

    impl FakeExecutor {
        fn new(blocked: bool) -> Self {
            Self {
                blocked,
                calls: Mutex::new(Vec::new()),
                requests: Mutex::new(Vec::new()),
                terminal_statuses: Mutex::new(HashMap::new()),
                started: Mutex::new(HashSet::new()),
                started_notify: Notify::new(),
                releases: Arc::new(Mutex::new(HashMap::new())),
                release_notify: Arc::new(Notify::new()),
            }
        }

        fn finish_with(&self, connection_id: &str, status: SqlFileStatus) {
            self.terminal_statuses.lock().unwrap().insert(connection_id.to_string(), status);
        }

        fn release_with(&self, connection_id: &str, status: SqlFileStatus) {
            self.releases.lock().unwrap().insert(connection_id.to_string(), status);
            self.release_notify.notify_waiters();
        }

        fn connection_calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn requests(&self) -> Vec<SqlFileRequest> {
            self.requests.lock().unwrap().clone()
        }

        async fn wait_until_started(&self, connection_id: &str) {
            loop {
                let notified = self.started_notify.notified();
                if self.started.lock().unwrap().contains(connection_id) {
                    return;
                }
                notified.await;
            }
        }
    }

    impl SqlFileBatchExecutor for FakeExecutor {
        fn execute(
            &self,
            request: SqlFileRequest,
            _token: tokio_util::sync::CancellationToken,
            progress: ProgressSink,
        ) -> SqlFileBatchFuture {
            self.calls.lock().unwrap().push(request.connection_id.clone());
            self.requests.lock().unwrap().push(request.clone());
            self.started.lock().unwrap().insert(request.connection_id.clone());
            self.started_notify.notify_waiters();

            let future: SqlFileBatchFuture = if self.blocked {
                let releases = self.releases.clone();
                let release_notify = self.release_notify.clone();
                let connection_id = request.connection_id.clone();
                Box::pin(async move {
                    loop {
                        let notified = release_notify.notified();
                        if let Some(status) = releases.lock().unwrap().remove(&connection_id) {
                            progress(terminal_progress(&request, status));
                            return;
                        }
                        notified.await;
                    }
                })
            } else {
                let status = self
                    .terminal_statuses
                    .lock()
                    .unwrap()
                    .get(&request.connection_id)
                    .copied()
                    .unwrap_or(SqlFileStatus::Done);
                Box::pin(async move { progress(terminal_progress(&request, status)) })
            };
            future
        }
    }

    fn terminal_progress(request: &SqlFileRequest, status: SqlFileStatus) -> SqlFileProgress {
        SqlFileProgress {
            execution_id: request.execution_id.clone(),
            status,
            statement_index: 0,
            success_count: 1,
            failure_count: 0,
            affected_rows: 0,
            elapsed_ms: 0,
            statement_summary: String::new(),
            error: None,
        }
    }
}
