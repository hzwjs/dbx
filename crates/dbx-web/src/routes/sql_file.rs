use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Multipart, Path as AxumPath, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::sql;
use dbx_core::sql::{SqlFileProgress, SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::{
    execute_sql_file_content, sql_file_error_progress, sql_file_progress as build_sql_file_progress,
};
use futures::stream::Stream;
use serde::Deserialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileExecuteWrapper {
    pub request: SqlFileRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSqlFileRequest {
    pub execution_id: String,
}

pub async fn preview_sql_file(
    State(state): State<Arc<WebState>>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let tmp_dir = state.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| AppError(e.to_string()))?;

    if let Some(field) = multipart.next_field().await.map_err(|e| AppError(e.to_string()))? {
        let file_name = field.file_name().unwrap_or("upload.sql").to_string();
        let data = field.bytes().await.map_err(|e| AppError(e.to_string()))?;

        let file_path = safe_uploaded_sql_path(&tmp_dir, &file_name)?;
        std::fs::write(&file_path, &data).map_err(|e| AppError(e.to_string()))?;

        let size_bytes = data.len() as u64;
        let content = sql::decode_sql_file_bytes(&data).map_err(AppError)?;
        let preview: String = content.chars().take(20_000).collect();

        return Ok(Json(serde_json::json!({
            "fileName": file_name,
            "filePath": file_path.to_string_lossy(),
            "sizeBytes": size_bytes,
            "preview": preview,
            "canExecuteWithoutSelectedDatabase": dbx_core::sql_file_import::mysql_like_sql_file_can_execute_without_selected_database(&content),
        })));
    }

    Err(AppError("No file uploaded".to_string()))
}

pub async fn execute_sql_file(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SqlFileExecuteWrapper>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;

    // Fast-fail: reject early if the connection is read-only (individual statements are also checked in do_execute)
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.connection_id).await {
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. SQL file execution blocked.",
            name
        )));
    }

    let execution_id = req.execution_id.clone();
    validated_uploaded_sql_path(&state.data_dir, &req.file_path)?;
    let token = CancellationToken::new();

    {
        let mut executions = state.sql_file_executions.write().await;
        if executions.contains_key(&execution_id) {
            return Err(AppError(format!("SQL file execution '{execution_id}' already exists")));
        }
        executions.insert(execution_id.clone(), token.clone());
    }
    let (tx, _) = tokio::sync::broadcast::channel::<String>(256);
    state.sse_channels.write().await.insert(execution_id.clone(), tx.clone());

    let state_clone = state.clone();

    tokio::spawn(async move {
        run_validated_sql_file_request(&state_clone.app, &state_clone.data_dir, &req, token, |progress| {
            send_sql_file_progress(&tx, progress);
        })
        .await;

        cleanup_sql_file_execution(&state_clone, &req.execution_id).await;
    });

    Ok(Json(serde_json::json!({ "executionId": execution_id })))
}

pub(crate) async fn run_validated_sql_file_request(
    app: &Arc<dbx_core::connection::AppState>,
    data_dir: &Path,
    request: &SqlFileRequest,
    token: CancellationToken,
    progress: impl Fn(SqlFileProgress) + Send + Sync,
) {
    let started_at = std::time::Instant::now();
    let file_path = match validated_uploaded_sql_path(data_dir, &request.file_path) {
        Ok(path) => path,
        Err(error) => {
            progress(sql_file_error_progress(&request.execution_id, started_at, error.0));
            return;
        }
    };

    match std::fs::metadata(&file_path) {
        Ok(meta) if meta.len() > 200 * 1024 * 1024 => {
            progress(sql_file_error_progress(
                &request.execution_id,
                started_at,
                format!("File too large: {} bytes (max {} bytes)", meta.len(), 200 * 1024 * 1024),
            ));
            return;
        }
        Err(error) => {
            progress(sql_file_error_progress(&request.execution_id, started_at, error.to_string()));
            return;
        }
        _ => {}
    }

    let file_content = match std::fs::read(&file_path).and_then(|bytes| {
        sql::decode_sql_file_bytes(&bytes)
            .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidData, message))
    }) {
        Ok(content) => content,
        Err(error) => {
            progress(sql_file_error_progress(&request.execution_id, started_at, error.to_string()));
            return;
        }
    };

    progress(build_sql_file_progress(&request.execution_id, SqlFileStatus::Started, 0, 0, 0, 0, started_at, "", None));

    let _ = execute_sql_file_content(app, request, &file_content, token, started_at, progress).await;
}

fn send_sql_file_progress(tx: &broadcast::Sender<String>, progress: SqlFileProgress) {
    if let Ok(json) = serde_json::to_string(&progress) {
        let _ = tx.send(json);
    }
}

async fn cleanup_sql_file_execution(state: &WebState, execution_id: &str) {
    state.remove_sse_channel(execution_id).await;
    state.sql_file_executions.write().await.remove(execution_id);
}

fn safe_uploaded_sql_path(tmp_dir: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    let base_name = file_name.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("upload.sql").trim();
    if base_name.is_empty() || base_name == "." || base_name == ".." {
        return Err(AppError("Invalid SQL file name".to_string()));
    }
    Ok(tmp_dir.join(base_name))
}

pub(crate) fn validated_uploaded_sql_path(data_dir: &Path, file_path: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err(AppError("File path must be absolute".to_string()));
    }

    let tmp_dir = data_dir.join("tmp").canonicalize().map_err(|e| AppError(e.to_string()))?;
    let canonical_path = path.canonicalize().map_err(|e| AppError(e.to_string()))?;
    if !canonical_path.starts_with(&tmp_dir) {
        return Err(AppError("File path must be inside the uploaded SQL directory".to_string()));
    }
    Ok(canonical_path)
}

pub async fn sql_file_progress(
    State(state): State<Arc<WebState>>,
    AxumPath(execution_id): AxumPath<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.sse_channels.read().await;
    let tx = channels.get(&execution_id).ok_or_else(|| AppError("Execution not found".to_string()))?;
    let rx = tx.subscribe();
    drop(channels);
    Ok(crate::sse::sse_from_channel(rx))
}

pub async fn cancel_sql_file(
    State(state): State<Arc<WebState>>,
    Json(req): Json<CancelSqlFileRequest>,
) -> Json<serde_json::Value> {
    let executions = state.sql_file_executions.read().await;
    if let Some(token) = executions.get(&req.execution_id) {
        token.cancel();
        Json(serde_json::json!({ "cancelled": true }))
    } else {
        Json(serde_json::json!({ "cancelled": false }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use dbx_core::connection::AppState;
    use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
    use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
    use dbx_core::storage::Storage;
    use tokio_util::sync::CancellationToken;

    use super::{run_validated_sql_file_request, safe_uploaded_sql_path, validated_uploaded_sql_path};

    #[test]
    fn uploaded_sql_path_uses_only_the_file_name() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");

        let path = match safe_uploaded_sql_path(&tmp_dir, "../outside.sql") {
            Ok(path) => path,
            Err(error) => panic!("{}", error.0),
        };

        assert_eq!(path, tmp_dir.join("outside.sql"));
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn execution_path_must_stay_inside_uploaded_tmp_dir() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let outside = data_dir.join("outside.sql");
        std::fs::write(&outside, "select 1;").unwrap();

        let result = validated_uploaded_sql_path(&data_dir, &outside.to_string_lossy());

        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn shared_executor_emits_started_then_terminal_status_for_sqlite_target() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let storage = Storage::open(&data_dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, data_dir.join("plugins")));
        let connection_id = "saved-sqlite".to_string();
        let config = sqlite_config(&connection_id, &data_dir.join("target.db").to_string_lossy());
        app.storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        app.configs.write().await.insert(connection_id.clone(), config);
        let file_path = tmp_dir.join("import.sql");
        std::fs::write(&file_path, "select 1;").unwrap();
        let request = SqlFileRequest {
            execution_id: "single-target".to_string(),
            connection_id,
            database: String::new(),
            file_path: file_path.to_string_lossy().into_owned(),
            continue_on_error: false,
        };
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let observed = statuses.clone();

        run_validated_sql_file_request(&app, &data_dir, &request, CancellationToken::new(), move |progress| {
            observed.lock().unwrap().push(progress.status);
        })
        .await;

        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses.first(), Some(&SqlFileStatus::Started));
        assert!(matches!(statuses.last(), Some(SqlFileStatus::Done | SqlFileStatus::Error | SqlFileStatus::Cancelled)));
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn shared_executor_emits_one_terminal_error_for_failing_sql() {
        let data_dir = std::env::temp_dir().join(format!("dbx-web-sql-file-test-{}", uuid::Uuid::new_v4()));
        let tmp_dir = data_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir).unwrap();
        let storage = Storage::open(&data_dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, data_dir.join("plugins")));
        let connection_id = "saved-sqlite".to_string();
        let config = sqlite_config(&connection_id, &data_dir.join("target.db").to_string_lossy());
        app.storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        app.configs.write().await.insert(connection_id.clone(), config);
        let file_path = tmp_dir.join("failing.sql");
        std::fs::write(&file_path, "not valid sqlite;").unwrap();
        let request = SqlFileRequest {
            execution_id: "single-target-failure".to_string(),
            connection_id,
            database: String::new(),
            file_path: file_path.to_string_lossy().into_owned(),
            continue_on_error: false,
        };
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let observed = statuses.clone();

        run_validated_sql_file_request(&app, &data_dir, &request, CancellationToken::new(), move |progress| {
            observed.lock().unwrap().push(progress.status);
        })
        .await;

        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses.first(), Some(&SqlFileStatus::Started));
        assert_eq!(statuses.iter().filter(|status| **status == SqlFileStatus::Error).count(), 1);
        let _ = std::fs::remove_dir_all(data_dir);
    }

    fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "SQLite".to_string(),
            db_type: DatabaseType::Sqlite,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: path.to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: dbx_core::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: dbx_core::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: dbx_core::models::connection::default_idle_timeout_secs(),
            keepalive_interval_secs: dbx_core::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }
}
