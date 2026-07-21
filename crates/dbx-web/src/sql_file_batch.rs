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
    pub target_id: String,
    pub connection_id: String,
    pub status: SqlFileBatchTargetStatus,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub error: Option<String>,
    pub failure_details: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileBatchSummary {
    pub total: usize,
    pub pending: usize,
    pub running: usize,
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
                target_id: uuid::Uuid::new_v4().to_string(),
                connection_id,
                status: SqlFileBatchTargetStatus::Pending,
                success_count: 0,
                failure_count: 0,
                affected_rows: 0,
                elapsed_ms: 0,
                error: None,
                failure_details: Vec::new(),
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

    pub async fn subscribe(
        &self,
        batch_id: &str,
    ) -> Option<(SqlFileBatchSnapshot, broadcast::Receiver<SqlFileBatchSnapshot>)> {
        let entry = self.entry(batch_id).await?;
        let snapshot = entry.snapshot.lock().await.clone();
        Some((snapshot, entry.updates.subscribe()))
    }

    pub async fn cancel(&self, batch_id: &str) -> bool {
        let Some(entry) = self.entry(batch_id).await else {
            return false;
        };
        entry.token.cancel();
        update_entry(&entry, |snapshot| {
            if snapshot.status == SqlFileBatchStatus::Running {
                snapshot.status = SqlFileBatchStatus::Cancelling;
            }
        })
        .await;
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
        if entry.token.is_cancelled() {
            finish_cancelled(&entry).await;
            return;
        }

        let (target_id, connection_id, database, file_path, continue_on_error) = {
            let snapshot = entry.snapshot.lock().await;
            let target = &snapshot.targets[target_index];
            (
                target.target_id.clone(),
                target.connection_id.clone(),
                snapshot.database.clone(),
                entry.file_path.clone(),
                snapshot.continue_on_error,
            )
        };
        update_entry(&entry, |snapshot| {
            snapshot.targets[target_index].status = SqlFileBatchTargetStatus::Running;
        })
        .await;

        let request =
            SqlFileRequest { execution_id: target_id.clone(), connection_id, database, file_path, continue_on_error };
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel();
        let progress: ProgressSink = Arc::new(move |progress| {
            let _ = progress_tx.send(progress);
        });
        let execution = executor.execute(request, entry.token.clone(), progress);
        tokio::pin!(execution);
        let mut execution_finished = false;
        let mut terminal_progress = None;

        while !execution_finished {
            tokio::select! {
                Some(progress) = progress_rx.recv() => {
                    if is_terminal(progress.status) {
                        terminal_progress = Some(progress.clone());
                    }
                    apply_progress(&entry, &target_id, progress).await;
                }
                _ = &mut execution => execution_finished = true,
            }
        }
        while let Ok(progress) = progress_rx.try_recv() {
            if is_terminal(progress.status) {
                terminal_progress = Some(progress.clone());
            }
            apply_progress(&entry, &target_id, progress).await;
        }
        if terminal_progress.is_none() {
            update_entry(&entry, |snapshot| {
                let target = &mut snapshot.targets[target_index];
                target.status = SqlFileBatchTargetStatus::Failed;
                target.error = Some("Execution completed without terminal progress".to_string());
            })
            .await;
        }
        if entry.token.is_cancelled() {
            finish_cancelled(&entry).await;
            return;
        }
    }

    update_entry(&entry, |snapshot| {
        snapshot.status = SqlFileBatchStatus::Completed;
    })
    .await;
}

async fn apply_progress(entry: &SqlFileBatchEntry, target_id: &str, progress: SqlFileProgress) {
    update_entry(entry, |snapshot| {
        let Some(target) = snapshot.targets.iter_mut().find(|target| target.target_id == target_id) else {
            return;
        };
        target.success_count = progress.success_count;
        target.failure_count = progress.failure_count;
        target.affected_rows = progress.affected_rows;
        target.elapsed_ms = progress.elapsed_ms;
        match progress.status {
            SqlFileStatus::Done => {
                target.status = if progress.failure_count == 0 {
                    SqlFileBatchTargetStatus::Success
                } else {
                    SqlFileBatchTargetStatus::Partial
                };
                target.error = progress.error;
            }
            SqlFileStatus::Error => {
                target.status = SqlFileBatchTargetStatus::Failed;
                target.error = progress.error;
            }
            SqlFileStatus::Cancelled => {
                target.status = SqlFileBatchTargetStatus::Cancelled;
                target.error = progress.error;
            }
            SqlFileStatus::StatementFailed => {
                if let Some(error) = progress.error.filter(|error| !error.is_empty()) {
                    target.failure_details.push(error);
                }
            }
            SqlFileStatus::Started | SqlFileStatus::Running | SqlFileStatus::StatementDone => {}
        }
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
    let snapshot = {
        let mut snapshot = entry.snapshot.lock().await;
        let mut updated = snapshot.clone();
        update(&mut updated);
        updated.updated_at_ms = now_ms();
        update_summary(&mut updated);
        *snapshot = updated.clone();
        updated
    };
    let _ = entry.updates.send(snapshot);
}

fn update_summary(snapshot: &mut SqlFileBatchSnapshot) {
    let mut summary = SqlFileBatchSummary { total: snapshot.targets.len(), ..SqlFileBatchSummary::default() };
    for target in &snapshot.targets {
        match target.status {
            SqlFileBatchTargetStatus::Pending => summary.pending += 1,
            SqlFileBatchTargetStatus::Running => summary.running += 1,
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
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
    use tokio::sync::{broadcast, Notify};

    use super::*;

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
