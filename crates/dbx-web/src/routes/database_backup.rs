use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use percent_encoding::{percent_encode, NON_ALPHANUMERIC};
use tokio_util::io::ReaderStream;

use crate::database_backup::manager::WebDatabaseBackupError;
use crate::database_backup::model::{
    WebDatabaseBackupConfig, WebDatabaseBackupRun, WebDatabaseBackupRunTrigger, WebDatabaseBackupSchedule,
    WebDatabaseBackupScheduleInput,
};
use crate::error::AppError;
use crate::state::WebState;

pub async fn config(State(state): State<Arc<WebState>>) -> Json<WebDatabaseBackupConfig> {
    Json(state.database_backup.config())
}

pub async fn list_schedules(State(state): State<Arc<WebState>>) -> Json<Vec<WebDatabaseBackupSchedule>> {
    Json(state.database_backup.list_schedules().await)
}

pub async fn create_schedule(
    State(state): State<Arc<WebState>>,
    Json(input): Json<WebDatabaseBackupScheduleInput>,
) -> Result<(StatusCode, Json<WebDatabaseBackupSchedule>), AppError> {
    state
        .database_backup
        .create_schedule(input)
        .await
        .map(|schedule| (StatusCode::CREATED, Json(schedule)))
        .map_err(to_app_error)
}

pub async fn update_schedule(
    State(state): State<Arc<WebState>>,
    Path(schedule_id): Path<String>,
    Json(input): Json<WebDatabaseBackupScheduleInput>,
) -> Result<Json<WebDatabaseBackupSchedule>, AppError> {
    state.database_backup.update_schedule(&schedule_id, input).await.map(Json).map_err(to_app_error)
}

pub async fn delete_schedule(
    State(state): State<Arc<WebState>>,
    Path(schedule_id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.database_backup.delete_schedule(&schedule_id).await.map(|_| StatusCode::NO_CONTENT).map_err(to_app_error)
}

pub async fn list_runs(State(state): State<Arc<WebState>>) -> Json<Vec<WebDatabaseBackupRun>> {
    Json(state.database_backup.list_runs().await)
}

pub async fn run_schedule(
    State(state): State<Arc<WebState>>,
    Path(schedule_id): Path<String>,
) -> Result<(StatusCode, Json<WebDatabaseBackupRun>), AppError> {
    state
        .database_backup
        .start_run(&schedule_id, WebDatabaseBackupRunTrigger::Manual)
        .await
        .map(|run| (StatusCode::ACCEPTED, Json(run)))
        .map_err(to_app_error)
}

pub async fn cancel_run(
    State(state): State<Arc<WebState>>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.database_backup.cancel_run(&run_id).await.map(|_| StatusCode::ACCEPTED).map_err(to_app_error)
}

pub async fn delete_run(
    State(state): State<Arc<WebState>>,
    Path(run_id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.database_backup.delete_run(&run_id).await.map(|_| StatusCode::NO_CONTENT).map_err(to_app_error)
}

pub async fn download_run_file(
    State(state): State<Arc<WebState>>,
    Path((run_id, relative_path)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let (file, filename) =
        state.database_backup.open_run_file_for_download(&run_id, &relative_path).await.map_err(to_app_error)?;
    let encoded_filename = percent_encode(filename.as_bytes(), NON_ALPHANUMERIC);
    let content_disposition = format!("attachment; filename=\"backup.sql\"; filename*=UTF-8''{encoded_filename}");

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/sql; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, content_disposition)
        .body(Body::from_stream(ReaderStream::new(file)))
        .map_err(|error| AppError::internal(error.to_string()))
}

fn to_app_error(error: WebDatabaseBackupError) -> AppError {
    match error {
        WebDatabaseBackupError::Validation(message) => AppError::bad_request(message),
        WebDatabaseBackupError::NotFound(message) => AppError::not_found(message),
        WebDatabaseBackupError::Conflict(message) => AppError::conflict(message),
        WebDatabaseBackupError::Internal(message) => AppError::internal(message),
    }
}
