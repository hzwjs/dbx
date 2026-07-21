use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::{self, Stream, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::routes::sql_file::{run_validated_sql_file_request, validated_uploaded_sql_path};
use crate::sql_file_batch::{
    run_sql_file_batch, CreateSqlFileBatchRequest, ProgressSink, SqlFileBatchExecutor, SqlFileBatchFuture,
    SqlFileBatchSnapshot,
};
use crate::state::WebState;

pub async fn create_sql_file_batch(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateSqlFileBatchRequest>,
) -> Result<Json<SqlFileBatchSnapshot>, AppError> {
    let file_path = validated_uploaded_sql_path(&state.data_dir, &request.file_path)?;
    let mut request = request;
    request.file_path = file_path.to_string_lossy().into_owned();
    let saved_connection_ids: HashSet<_> = state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError)?
        .into_iter()
        .map(|connection| connection.id)
        .collect();
    if let Some(connection_id) =
        request.connection_ids.iter().find(|connection_id| !saved_connection_ids.contains(*connection_id))
    {
        return Err(AppError(format!("SQL file batch connection '{connection_id}' is not a saved connection")));
    }
    let snapshot = state.sql_file_batches.create(request).await.map_err(AppError)?;
    let registry = state.sql_file_batches.clone();
    let batch_id = snapshot.batch_id.clone();
    let executor = Arc::new(WebSqlFileBatchExecutor { state });
    tokio::spawn(run_sql_file_batch(registry, batch_id, executor));
    Ok(Json(snapshot))
}

pub async fn list_sql_file_batches(State(state): State<Arc<WebState>>) -> Json<Vec<SqlFileBatchSnapshot>> {
    Json(state.sql_file_batches.list().await)
}

pub async fn get_sql_file_batch(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Json<SqlFileBatchSnapshot>, AppError> {
    state
        .sql_file_batches
        .get(&batch_id)
        .await
        .map(Json)
        .ok_or_else(|| AppError("SQL file batch not found".to_string()))
}

pub async fn sql_file_batch_events(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let (snapshot, mut receiver) = state
        .sql_file_batches
        .subscribe(&batch_id)
        .await
        .ok_or_else(|| AppError("SQL file batch not found".to_string()))?;
    let initial = stream::once(async move { Ok(Event::default().data(serde_json::to_string(&snapshot).unwrap())) });
    let updates = async_stream::stream! {
        while let Some(snapshot) = receive_next_batch_snapshot(&mut receiver).await {
            yield Ok(Event::default().data(serde_json::to_string(&snapshot).unwrap()));
        }
    };
    Ok(Sse::new(initial.chain(updates)).keep_alive(KeepAlive::default()))
}

async fn receive_next_batch_snapshot(
    receiver: &mut tokio::sync::broadcast::Receiver<SqlFileBatchSnapshot>,
) -> Option<SqlFileBatchSnapshot> {
    loop {
        match receiver.recv().await {
            Ok(snapshot) => return Some(snapshot),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
        }
    }
}

pub async fn cancel_sql_file_batch(
    State(state): State<Arc<WebState>>,
    AxumPath(batch_id): AxumPath<String>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "cancelled": state.sql_file_batches.cancel(&batch_id).await }))
}

struct WebSqlFileBatchExecutor {
    state: Arc<WebState>,
}

impl SqlFileBatchExecutor for WebSqlFileBatchExecutor {
    fn execute(
        &self,
        request: dbx_core::sql::SqlFileRequest,
        token: CancellationToken,
        progress: ProgressSink,
    ) -> SqlFileBatchFuture {
        let state = self.state.clone();
        Box::pin(async move {
            if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &request.connection_id).await {
                progress(dbx_core::sql_file_import::sql_file_error_progress(
                    &request.execution_id,
                    std::time::Instant::now(),
                    format!(
                        "Read-only mode: connection '{}' has read-only protection enabled. SQL file execution blocked.",
                        name
                    ),
                ));
                return;
            }

            run_validated_sql_file_request(&state.app, &state.data_dir, &request, token, move |update| {
                progress(update);
            })
            .await;
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;

    use axum::extract::{Path as AxumPath, State};
    use axum::http::StatusCode;
    use axum::Json;
    use dbx_core::connection::AppState;
    use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
    use dbx_core::storage::Storage;
    use tokio::sync::{Mutex, RwLock};
    use tokio_util::sync::CancellationToken;

    use super::{create_sql_file_batch, get_sql_file_batch, list_sql_file_batches, receive_next_batch_snapshot};
    use crate::auth;
    use crate::sql_file_batch::{
        run_sql_file_batch, CreateSqlFileBatchRequest, ProgressSink, SqlFileBatchExecutor, SqlFileBatchFuture,
        SqlFileBatchRegistry, SqlFileBatchSnapshot,
    };
    use crate::state::{LoginRateLimit, WebState};

    struct TestBatch {
        state: Arc<WebState>,
        snapshot: SqlFileBatchSnapshot,
        data_dir: std::path::PathBuf,
    }

    impl Drop for TestBatch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }

    #[tokio::test]
    async fn list_and_get_return_the_same_shared_snapshot() {
        let created = create_test_batch().await;
        let Json(listed) = list_sql_file_batches(State(created.state.clone())).await;
        let fetched =
            get_sql_file_batch(State(created.state.clone()), AxumPath(created.snapshot.batch_id.clone())).await;
        let Json(fetched) = match fetched {
            Ok(snapshot) => snapshot,
            Err(error) => panic!("{}", error.0),
        };
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
        let state = test_state().await;
        let result = create_test_batch_from_path(state.clone(), "/tmp/outside.sql").await;
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }

    #[tokio::test]
    async fn create_accepts_all_persisted_connection_ids_in_submission_order() {
        let state = test_state().await;
        persist_sqlite_connections(&state, &["saved-a", "saved-b"]).await;
        let file_path = uploaded_sql_file(&state, "ordered.sql");

        let snapshot = create_test_batch_from_path_with_ids(
            state.clone(),
            &file_path.to_string_lossy(),
            vec!["saved-b".to_string(), "saved-a".to_string()],
        )
        .await;
        let Json(snapshot) = match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => panic!("{}", error.0),
        };

        assert_eq!(
            snapshot.targets.iter().map(|target| target.connection_id.as_str()).collect::<Vec<_>>(),
            vec!["saved-b", "saved-a"]
        );
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }

    #[tokio::test]
    async fn create_rejects_unknown_or_runtime_only_connection_ids() {
        let state = test_state().await;
        persist_sqlite_connections(&state, &["saved-only"]).await;
        let file_path = uploaded_sql_file(&state, "saved-only.sql");

        assert!(create_test_batch_from_path_with_ids(
            state.clone(),
            &file_path.to_string_lossy(),
            vec!["unknown".to_string()],
        )
        .await
        .is_err());

        state
            .app
            .configs
            .write()
            .await
            .insert("runtime-only".to_string(), sqlite_config("runtime-only", "runtime-only.db"));
        assert!(create_test_batch_from_path_with_ids(
            state.clone(),
            &file_path.to_string_lossy(),
            vec!["runtime-only".to_string()],
        )
        .await
        .is_err());
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_stores_canonical_uploaded_path() {
        let state = test_state().await;
        persist_sqlite_connections(&state, &["saved-sqlite"]).await;
        let file_path = uploaded_sql_file(&state, "actual.sql");
        let alias_path = state.data_dir.join("tmp/alias.sql");
        std::os::unix::fs::symlink(&file_path, &alias_path).unwrap();

        let snapshot = create_test_batch_from_path(state.clone(), &alias_path.to_string_lossy()).await;
        let Json(snapshot) = match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => panic!("{}", error.0),
        };
        assert_eq!(
            state.sql_file_batches.test_file_path(&snapshot.batch_id).await.unwrap(),
            file_path.canonicalize().unwrap().to_string_lossy()
        );
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }

    #[tokio::test]
    async fn snapshot_receiver_continues_after_broadcast_lag() {
        let registry = SqlFileBatchRegistry::default();
        let mut snapshot = registry
            .create(CreateSqlFileBatchRequest {
                connection_ids: vec!["saved-sqlite".to_string()],
                database: String::new(),
                file_path: "/tmp/import.sql".to_string(),
                continue_on_error: false,
            })
            .await
            .unwrap();
        let (sender, mut receiver) = tokio::sync::broadcast::channel(2);
        for updated_at_ms in 1..=4 {
            snapshot.updated_at_ms = updated_at_ms;
            sender.send(snapshot.clone()).unwrap();
        }

        let first_retained = receive_next_batch_snapshot(&mut receiver).await.unwrap();
        let later_retained = receive_next_batch_snapshot(&mut receiver).await.unwrap();
        assert_eq!(first_retained.updated_at_ms, 3);
        assert_eq!(later_retained.updated_at_ms, 4);
    }

    #[tokio::test]
    async fn batch_api_requires_auth_when_password_is_enabled() {
        let state = test_state().await;
        *state.password_hash.write().await = Some("configured-password".to_string());
        let status = request_protected_batch_route_without_session(&state).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(&state.data_dir);
    }

    async fn create_test_batch() -> TestBatch {
        let state = test_state().await;
        let snapshot = state
            .sql_file_batches
            .create(CreateSqlFileBatchRequest {
                connection_ids: vec!["saved-sqlite".to_string()],
                database: String::new(),
                file_path: state.data_dir.join("tmp/import.sql").to_string_lossy().into_owned(),
                continue_on_error: false,
            })
            .await
            .unwrap();
        TestBatch { data_dir: state.data_dir.clone(), state, snapshot }
    }

    async fn create_terminal_test_batch() -> TestBatch {
        let mut created = create_test_batch().await;
        run_sql_file_batch(
            created.state.sql_file_batches.clone(),
            created.snapshot.batch_id.clone(),
            Arc::new(DoneExecutor),
        )
        .await;
        created.snapshot = created.state.sql_file_batches.get(&created.snapshot.batch_id).await.unwrap();
        created
    }

    async fn create_test_batch_from_path(
        state: Arc<WebState>,
        file_path: &str,
    ) -> Result<Json<SqlFileBatchSnapshot>, crate::error::AppError> {
        create_sql_file_batch(
            State(state),
            Json(CreateSqlFileBatchRequest {
                connection_ids: vec!["saved-sqlite".to_string()],
                database: String::new(),
                file_path: file_path.to_string(),
                continue_on_error: false,
            }),
        )
        .await
    }

    async fn create_test_batch_from_path_with_ids(
        state: Arc<WebState>,
        file_path: &str,
        connection_ids: Vec<String>,
    ) -> Result<Json<SqlFileBatchSnapshot>, crate::error::AppError> {
        create_sql_file_batch(
            State(state),
            Json(CreateSqlFileBatchRequest {
                connection_ids,
                database: String::new(),
                file_path: file_path.to_string(),
                continue_on_error: false,
            }),
        )
        .await
    }

    fn uploaded_sql_file(state: &WebState, name: &str) -> std::path::PathBuf {
        let file_path = state.data_dir.join("tmp").join(name);
        std::fs::write(&file_path, "select 1;").unwrap();
        file_path
    }

    async fn persist_sqlite_connections(state: &WebState, ids: &[&str]) {
        let configs: Vec<_> = ids.iter().map(|id| sqlite_config(id, &format!("{id}.db"))).collect();
        state.app.storage.save_connections(&configs).await.unwrap();
    }

    fn sqlite_config(id: &str, path: &str) -> dbx_core::models::connection::ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "db_type": "sqlite",
            "host": path,
            "port": 0,
            "username": "",
            "password": ""
        }))
        .unwrap()
    }

    async fn test_state() -> Arc<WebState> {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-batch-route-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(data_dir.join("tmp")).unwrap();
        let storage = Storage::open(&data_dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, data_dir.join("plugins")));
        Arc::new(WebState {
            app,
            data_dir,
            public_base_path: "/".to_string(),
            password_disabled: false,
            password_hash: RwLock::new(None),
            sessions: RwLock::new(HashSet::new()),
            sse_channels: RwLock::new(HashMap::new()),
            sql_file_executions: RwLock::new(HashMap::new()),
            sql_file_batches: Arc::new(SqlFileBatchRegistry::default()),
            login_rate_limit: Mutex::new(LoginRateLimit { fail_count: 0, locked_until: None }),
            export_files: RwLock::new(HashMap::new()),
        })
    }

    async fn request_protected_batch_route_without_session(state: &WebState) -> StatusCode {
        if auth::request_is_authorized(state, None).await {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        }
    }

    struct DoneExecutor;

    impl SqlFileBatchExecutor for DoneExecutor {
        fn execute(
            &self,
            request: SqlFileRequest,
            _token: CancellationToken,
            progress: ProgressSink,
        ) -> SqlFileBatchFuture {
            Box::pin(async move {
                progress(SqlFileProgress {
                    execution_id: request.execution_id,
                    status: SqlFileStatus::Done,
                    statement_index: 0,
                    success_count: 1,
                    failure_count: 0,
                    affected_rows: 0,
                    elapsed_ms: 0,
                    statement_summary: String::new(),
                    error: None,
                });
            })
        }
    }
}
