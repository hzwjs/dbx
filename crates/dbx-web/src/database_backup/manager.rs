use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Local;
use dbx_core::database_export::{
    begin_database_backup_snapshot_core, clear_export_cancelled, database_export_client_session_id,
    export_database_sql_core, set_export_cancelled, DatabaseExportRequest,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::model::{
    WebDatabaseBackupConfig, WebDatabaseBackupFile, WebDatabaseBackupRun, WebDatabaseBackupRunStatus,
    WebDatabaseBackupRunTrigger, WebDatabaseBackupSchedule, WebDatabaseBackupScheduleInput,
    WebDatabaseBackupTableFilterMode,
};
use super::store::{managed_backup_file_path, WebDatabaseBackupStore};

const BACKUP_NAME_SEGMENT_MAX_BYTES: usize = 100;
const BACKUP_RUN_ID_SEGMENT_MAX_BYTES: usize = 8;

#[derive(Debug)]
pub enum WebDatabaseBackupError {
    Validation(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}

impl From<String> for WebDatabaseBackupError {
    fn from(value: String) -> Self {
        Self::Internal(value)
    }
}

#[derive(Debug, Clone)]
struct ActiveRun {
    run_id: String,
    schedule_id: String,
    cancellation_requested: bool,
    current_export_id: Option<String>,
}

pub struct WebDatabaseBackupManager {
    app: Arc<dbx_core::connection::AppState>,
    store: Arc<WebDatabaseBackupStore>,
    backup_root: PathBuf,
    active_run: Mutex<Option<ActiveRun>>,
}

impl WebDatabaseBackupManager {
    pub async fn initialize(
        app: Arc<dbx_core::connection::AppState>,
        data_dir: &Path,
        configured_backup_dir: Option<String>,
    ) -> Result<Arc<Self>, String> {
        let requested_root = configured_backup_dir.map(PathBuf::from).unwrap_or_else(|| data_dir.join("backups"));
        tokio::fs::create_dir_all(&requested_root).await.map_err(|error| {
            format!("Failed to create Web database backup directory {}: {error}", requested_root.display())
        })?;
        let backup_root = tokio::fs::canonicalize(&requested_root).await.map_err(|error| {
            format!("Failed to resolve Web database backup directory {}: {error}", requested_root.display())
        })?;
        verify_directory_writable(&backup_root).await?;

        let store = Arc::new(WebDatabaseBackupStore::open(data_dir.join("web-database-backups.json")).await?);
        store.initialize().await?;
        let manager = Arc::new(Self { app, store, backup_root, active_run: Mutex::new(None) });

        // 服务重启后先清理已知的部分文件，再把遗留 running 记录固定收敛为 failed。
        let interrupted = manager.store.recover_interrupted_runs().await?;
        for run in interrupted {
            if let Err(error) = manager.delete_files(&run.files).await {
                tracing::warn!(run_id = %run.id, "Failed to clean interrupted backup files: {error}");
            } else if !run.files.is_empty() {
                manager.store.clear_run_files(&run.id).await?;
            }
        }
        Ok(manager)
    }

    pub fn config(&self) -> WebDatabaseBackupConfig {
        WebDatabaseBackupConfig {
            available: true,
            backup_directory: self.backup_root.to_string_lossy().to_string(),
            server_timezone: Local::now().offset().to_string(),
        }
    }

    pub async fn list_schedules(&self) -> Vec<WebDatabaseBackupSchedule> {
        self.store.list_schedules().await
    }

    pub async fn create_schedule(
        &self,
        input: WebDatabaseBackupScheduleInput,
    ) -> Result<WebDatabaseBackupSchedule, WebDatabaseBackupError> {
        let input = input.validate_and_normalize().map_err(WebDatabaseBackupError::Validation)?;
        self.ensure_saved_connection_supported(&input.connection_id).await?;
        self.store.create_schedule(input).await.map_err(Into::into)
    }

    pub async fn update_schedule(
        &self,
        schedule_id: &str,
        input: WebDatabaseBackupScheduleInput,
    ) -> Result<WebDatabaseBackupSchedule, WebDatabaseBackupError> {
        if self.active_schedule_id().await.as_deref() == Some(schedule_id) {
            return Err(WebDatabaseBackupError::Conflict("A running backup schedule cannot be edited".to_string()));
        }
        let input = input.validate_and_normalize().map_err(WebDatabaseBackupError::Validation)?;
        self.ensure_saved_connection_supported(&input.connection_id).await?;
        self.store
            .update_schedule(schedule_id, input)
            .await?
            .ok_or_else(|| WebDatabaseBackupError::NotFound("Backup schedule not found".to_string()))
    }

    pub async fn delete_schedule(&self, schedule_id: &str) -> Result<(), WebDatabaseBackupError> {
        if self.active_schedule_id().await.as_deref() == Some(schedule_id) {
            return Err(WebDatabaseBackupError::Conflict("A running backup schedule cannot be deleted".to_string()));
        }
        if !self.store.delete_schedule(schedule_id).await? {
            return Err(WebDatabaseBackupError::NotFound("Backup schedule not found".to_string()));
        }
        Ok(())
    }

    pub async fn list_runs(&self) -> Vec<WebDatabaseBackupRun> {
        self.store.list_runs().await
    }

    pub async fn delete_run(&self, run_id: &str) -> Result<(), WebDatabaseBackupError> {
        if self.active_run.lock().await.as_ref().is_some_and(|active| active.run_id == run_id) {
            return Err(WebDatabaseBackupError::Conflict("A running backup cannot be deleted".to_string()));
        }
        let run = self
            .store
            .get_run(run_id)
            .await
            .ok_or_else(|| WebDatabaseBackupError::NotFound("Backup run not found".to_string()))?;
        self.delete_files(&run.files).await?;
        self.store.delete_run(run_id).await?;
        Ok(())
    }

    pub async fn open_run_file_for_download(
        &self,
        run_id: &str,
        relative_path: &str,
    ) -> Result<(tokio::fs::File, String), WebDatabaseBackupError> {
        let run = self
            .store
            .get_run(run_id)
            .await
            .ok_or_else(|| WebDatabaseBackupError::NotFound("Backup run not found".to_string()))?;
        let file = run
            .files
            .iter()
            .find(|file| file.relative_path == relative_path)
            .ok_or_else(|| WebDatabaseBackupError::NotFound("Backup file not found in this run".to_string()))?;
        let path = managed_backup_file_path(&self.backup_root, &file.relative_path)?;
        let handle = tokio::fs::File::open(path).await.map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                WebDatabaseBackupError::NotFound("Backup file no longer exists".to_string())
            }
            _ => WebDatabaseBackupError::Internal(format!("Failed to open backup file: {error}")),
        })?;
        Ok((handle, file.relative_path.clone()))
    }

    pub async fn start_run(
        self: &Arc<Self>,
        schedule_id: &str,
        trigger: WebDatabaseBackupRunTrigger,
    ) -> Result<WebDatabaseBackupRun, WebDatabaseBackupError> {
        let mut active = self.active_run.lock().await;
        if active.is_some() {
            return Err(WebDatabaseBackupError::Conflict("Another Web database backup is already running".to_string()));
        }
        let schedule = self
            .store
            .get_schedule(schedule_id)
            .await
            .ok_or_else(|| WebDatabaseBackupError::NotFound("Backup schedule not found".to_string()))?;
        let connection = self.saved_connection(&schedule.input.connection_id).await?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let run = WebDatabaseBackupRun {
            id: run_id.clone(),
            schedule_id: schedule.id.clone(),
            schedule_name: schedule.input.name.clone(),
            connection_id: schedule.input.connection_id.clone(),
            connection_name: connection.name.clone(),
            trigger,
            status: WebDatabaseBackupRunStatus::Running,
            started_at: Local::now().to_rfc3339(),
            completed_at: None,
            files: Vec::new(),
            error: None,
        };
        self.store.upsert_run(run.clone()).await?;
        *active = Some(ActiveRun {
            run_id: run_id.clone(),
            schedule_id: schedule.id.clone(),
            cancellation_requested: false,
            current_export_id: None,
        });
        drop(active);

        let manager = self.clone();
        tokio::spawn(Box::pin(async move {
            manager.execute_run(schedule, run_id, connection).await;
        }));
        Ok(run)
    }

    pub async fn cancel_run(&self, run_id: &str) -> Result<(), WebDatabaseBackupError> {
        let export_id = {
            let mut active = self.active_run.lock().await;
            let active = active
                .as_mut()
                .filter(|active| active.run_id == run_id)
                .ok_or_else(|| WebDatabaseBackupError::NotFound("Active backup run not found".to_string()))?;
            active.cancellation_requested = true;
            active.current_export_id.clone()
        };
        if let Some(export_id) = export_id {
            set_export_cancelled(&export_id).await;
        }
        Ok(())
    }

    pub async fn run_due_schedule(self: &Arc<Self>) -> Result<bool, WebDatabaseBackupError> {
        if self.active_run.lock().await.is_some() {
            return Ok(false);
        }
        let due = self.store.due_schedule_ids(Local::now().fixed_offset()).await;
        let Some(schedule_id) = due.first() else {
            return Ok(false);
        };
        self.start_run(schedule_id, WebDatabaseBackupRunTrigger::Scheduled).await?;
        Ok(true)
    }

    async fn execute_run(
        self: Arc<Self>,
        schedule: WebDatabaseBackupSchedule,
        run_id: String,
        connection: ConnectionConfig,
    ) {
        let result = self.execute_run_inner(&schedule, &run_id, &connection).await;
        let cancelled = self.is_cancelled(&run_id).await;
        let (status, error) = match result {
            Ok(()) if cancelled => (WebDatabaseBackupRunStatus::Cancelled, None),
            Ok(()) => (WebDatabaseBackupRunStatus::Success, None),
            Err(error) if cancelled || error.to_ascii_lowercase().contains("cancelled") => {
                (WebDatabaseBackupRunStatus::Cancelled, None)
            }
            Err(error) => (WebDatabaseBackupRunStatus::Failed, Some(error)),
        };

        let run_files = self.store.get_run(&run_id).await.map(|run| run.files).unwrap_or_default();
        let mut completion_error = error;
        if status != WebDatabaseBackupRunStatus::Success && !run_files.is_empty() {
            match self.delete_files(&run_files).await {
                Ok(()) => {
                    if let Err(error) = self.store.clear_run_files(&run_id).await {
                        completion_error = append_error(completion_error, error);
                    }
                }
                Err(error) => completion_error = append_error(completion_error, error),
            }
        }

        if let Err(error) = self.store.complete_run(&run_id, status, completion_error).await {
            tracing::error!(run_id = %run_id, "Failed to persist backup completion: {error}");
        }
        if status == WebDatabaseBackupRunStatus::Success {
            if let Err(error) = self.prune_schedule_runs(&schedule).await {
                tracing::warn!(schedule_id = %schedule.id, "Failed to prune backup history: {error}");
            }
        }
        // 全局历史清理必须经过文件生命周期边界，元数据只有在受管文件删除成功后才会移除。
        if let Err(error) = self.prune_global_run_history().await {
            tracing::warn!(run_id = %run_id, "Failed to prune global backup history: {error}");
        }
        let mut active = self.active_run.lock().await;
        if active.as_ref().is_some_and(|active| active.run_id == run_id) {
            *active = None;
        }
    }

    async fn execute_run_inner(
        &self,
        schedule: &WebDatabaseBackupSchedule,
        run_id: &str,
        connection: &ConnectionConfig,
    ) -> Result<(), String> {
        // 服务端计划始终以持久化连接为唯一来源，确保页面关闭后仍能独立建连。
        self.app.configs.write().await.insert(connection.id.clone(), connection.clone());
        let table_names_case_sensitive = self.table_names_are_case_sensitive(connection).await;

        let available = dbx_core::schema::list_databases_core(&self.app, &connection.id).await?;
        let databases = resolve_database_targets(
            &schedule.input.databases,
            available.into_iter().map(|database| database.name).collect(),
            connection.db_type,
        )?;
        if databases.is_empty() {
            return Err("No databases are available for this backup schedule".to_string());
        }

        let started_at = Local::now();
        let mut export_index = 0usize;
        let mut matched_table_count = 0usize;
        for database in databases {
            if self.is_cancelled(run_id).await {
                return Err("Backup cancelled".to_string());
            }
            let snapshot = begin_database_backup_snapshot_core(&self.app, &connection.id, &database).await?;
            let snapshot_result = async {
                for schema in &snapshot.schemas {
                    if self.is_cancelled(run_id).await {
                        return Err("Backup cancelled".to_string());
                    }
                    let (selected_tables, excluded_tables, included_count) = self
                        .resolve_table_scope(
                            schedule,
                            &connection.id,
                            &database,
                            schema,
                            table_names_case_sensitive,
                        )
                        .await?;
                    matched_table_count += included_count;
                    if schedule.input.table_filter_mode != WebDatabaseBackupTableFilterMode::All && included_count == 0
                    {
                        continue;
                    }

                    export_index += 1;
                    let export_id = format!("{run_id}-{export_index}");
                    let file_stem = if connection.db_type == DatabaseType::Postgres {
                        format!("{database}__{schema}")
                    } else {
                        database.clone()
                    };
                    let relative_path = backup_file_name(&schedule.input.name, &file_stem, started_at, run_id);
                    let file_path = managed_backup_file_path(&self.backup_root, &relative_path)?;
                    let file = WebDatabaseBackupFile {
                        database: database.clone(),
                        schema: schema.clone(),
                        display_name: if database == *schema {
                            database.clone()
                        } else {
                            format!("{database} / {schema}")
                        },
                        relative_path,
                    };
                    // 导出前先持久化文件记录，服务异常退出后才能准确清理部分文件。
                    self.store.add_run_file(run_id, file).await?;
                    self.set_current_export(run_id, Some(export_id.clone())).await;
                    // 取消请求可能恰好发生在子导出 ID 发布之前，发布后必须再检查一次。
                    if self.is_cancelled(run_id).await {
                        set_export_cancelled(&export_id).await;
                    }
                    let request = DatabaseExportRequest {
                        export_id: export_id.clone(),
                        connection_id: connection.id.clone(),
                        database: database.clone(),
                        schema: schema.clone(),
                        file_path: file_path.to_string_lossy().to_string(),
                        selected_tables,
                        excluded_tables,
                        include_structure: schedule.input.include_structure,
                        include_data: schedule.input.include_data,
                        include_objects: schedule.input.include_objects,
                        drop_table_if_exists: schedule.input.drop_table_if_exists,
                        omit_auto_increment: false,
                        fail_on_error: true,
                        snapshot_session_id: Some(snapshot.session_id.clone()),
                        batch_size: 1000,
                    };
                    let export_result = export_database_sql_core(&self.app, &request, |_| {}).await;
                    let client_session_id = database_export_client_session_id(&export_id);
                    if let Err(error) = self
                        .app
                        .close_client_session_pool(&connection.id, Some(&database), &client_session_id)
                        .await
                    {
                        tracing::warn!(export_id = %export_id, "Failed to close database export client session: {error}");
                    }
                    clear_export_cancelled(&export_id).await;
                    self.set_current_export(run_id, None).await;
                    // 子导出结果只能在会话池清理完成后向上传播。
                    export_result?;
                }
                Ok::<(), String>(())
            }
            .await;

            let rollback_result = dbx_core::query::rollback_manual_transaction(&self.app, &snapshot.session_id).await;
            match (snapshot_result, rollback_result) {
                (Err(error), _) => return Err(error),
                (Ok(()), Err(error)) => return Err(format!("Failed to release backup snapshot: {error}")),
                (Ok(()), Ok(_)) => {}
            }
        }
        if schedule.input.table_filter_mode != WebDatabaseBackupTableFilterMode::All && matched_table_count == 0 {
            return Err(format!(
                "No tables matched the configured {:?} backup rules",
                schedule.input.table_filter_mode
            ));
        }
        Ok(())
    }

    async fn resolve_table_scope(
        &self,
        schedule: &WebDatabaseBackupSchedule,
        connection_id: &str,
        database: &str,
        schema: &str,
        case_sensitive: bool,
    ) -> Result<(Vec<String>, Vec<String>, usize), String> {
        if schedule.input.table_filter_mode == WebDatabaseBackupTableFilterMode::All {
            return Ok((Vec::new(), Vec::new(), 0));
        }
        let tables =
            dbx_core::schema::list_tables_core(&self.app, connection_id, database, schema, None, None, None, None)
                .await?
                .into_iter()
                .map(|table| table.name)
                .collect::<Vec<_>>();
        let matching = tables
            .iter()
            .filter(|table| {
                schedule
                    .input
                    .table_patterns
                    .iter()
                    .any(|pattern| table_matches_pattern(table, database, schema, pattern, case_sensitive))
            })
            .cloned()
            .collect::<Vec<_>>();
        match schedule.input.table_filter_mode {
            WebDatabaseBackupTableFilterMode::Include => {
                let count = matching.len();
                Ok((matching, Vec::new(), count))
            }
            WebDatabaseBackupTableFilterMode::Exclude => {
                let included_count = tables.len().saturating_sub(matching.len());
                Ok((Vec::new(), matching, included_count))
            }
            WebDatabaseBackupTableFilterMode::All => unreachable!(),
        }
    }

    async fn table_names_are_case_sensitive(&self, connection: &ConnectionConfig) -> bool {
        if connection.db_type != DatabaseType::Mysql {
            return true;
        }
        match dbx_core::query::execute_sql_statement(
            &self.app,
            &connection.id,
            "",
            "SHOW VARIABLES LIKE 'lower_case_table_names'",
            None,
            None,
        )
        .await
        {
            Ok(result) => mysql_lower_case_table_names_are_case_sensitive(
                result.rows.first().and_then(|row| row.get(1).or_else(|| row.first())),
            ),
            Err(error) => {
                tracing::warn!(connection_id = %connection.id, "Failed to detect MySQL lower_case_table_names: {error}");
                true
            }
        }
    }

    async fn prune_schedule_runs(&self, schedule: &WebDatabaseBackupSchedule) -> Result<(), String> {
        let stale = self.store.successful_runs_to_prune(&schedule.id, schedule.input.retention_count).await;
        for run in stale {
            self.delete_files(&run.files).await?;
            self.store.delete_run(&run.id).await?;
        }
        Ok(())
    }

    async fn prune_global_run_history(&self) -> Result<(), String> {
        let stale = self.store.runs_exceeding_history_limit().await;
        for run in stale {
            self.delete_files(&run.files).await?;
            self.store.delete_run(&run.id).await?;
        }
        Ok(())
    }

    async fn delete_files(&self, files: &[WebDatabaseBackupFile]) -> Result<(), String> {
        for file in files {
            let path = managed_backup_file_path(&self.backup_root, &file.relative_path)?;
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Failed to delete managed backup file {}: {error}", path.display())),
            }
        }
        Ok(())
    }

    async fn saved_connection(
        &self,
        connection_id: &str,
    ) -> Result<dbx_core::models::connection::ConnectionConfig, WebDatabaseBackupError> {
        let connections = self.app.storage.load_connections().await.map_err(WebDatabaseBackupError::Internal)?;
        let connection = connections
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .ok_or_else(|| WebDatabaseBackupError::Validation("The backup connection is unavailable".to_string()))?;
        if !matches!(connection.db_type, DatabaseType::Mysql | DatabaseType::Postgres) {
            return Err(WebDatabaseBackupError::Validation(
                "Web database backups support only MySQL and PostgreSQL".to_string(),
            ));
        }
        Ok(connection)
    }

    async fn ensure_saved_connection_supported(&self, connection_id: &str) -> Result<(), WebDatabaseBackupError> {
        self.saved_connection(connection_id).await.map(|_| ())
    }

    async fn active_schedule_id(&self) -> Option<String> {
        self.active_run.lock().await.as_ref().map(|active| active.schedule_id.clone())
    }

    async fn is_cancelled(&self, run_id: &str) -> bool {
        self.active_run
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.run_id == run_id && active.cancellation_requested)
    }

    async fn set_current_export(&self, run_id: &str, export_id: Option<String>) {
        let mut active = self.active_run.lock().await;
        if let Some(active) = active.as_mut().filter(|active| active.run_id == run_id) {
            active.current_export_id = export_id;
        }
    }
}

async fn verify_directory_writable(root: &Path) -> Result<(), String> {
    let probe = root.join(format!(".dbx-write-probe-{}", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .await
        .map_err(|error| format!("Web database backup directory {} is not writable: {error}", root.display()))?;
    file.write_all(b"dbx")
        .await
        .map_err(|error| format!("Web database backup directory {} is not writable: {error}", root.display()))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Web database backup directory {} is not writable: {error}", root.display()))?;
    drop(file);
    tokio::fs::remove_file(&probe)
        .await
        .map_err(|error| format!("Failed to remove Web database backup write probe {}: {error}", probe.display()))?;
    Ok(())
}

fn resolve_database_targets(
    configured: &[String],
    available: Vec<String>,
    database_type: DatabaseType,
) -> Result<Vec<String>, String> {
    if configured.is_empty() {
        return Ok(available.into_iter().filter(|database| !is_system_database(database_type, database)).collect());
    }
    let missing = configured.iter().filter(|database| !available.contains(database)).cloned().collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!("Configured backup databases are unavailable: {}", missing.join(", ")));
    }
    Ok(configured.to_vec())
}

fn is_system_database(database_type: DatabaseType, database: &str) -> bool {
    match database_type {
        DatabaseType::Mysql => matches!(
            database.to_ascii_lowercase().as_str(),
            "information_schema" | "mysql" | "performance_schema" | "sys"
        ),
        DatabaseType::Postgres => matches!(database.to_ascii_lowercase().as_str(), "template0" | "template1"),
        _ => false,
    }
}

fn table_matches_pattern(table: &str, database: &str, schema: &str, pattern: &str, case_sensitive: bool) -> bool {
    let candidates = [table.to_string(), format!("{schema}.{table}"), format!("{database}.{schema}.{table}")];
    candidates.iter().any(|candidate| wildcard_matches(pattern, candidate, case_sensitive))
}

fn wildcard_matches(pattern: &str, value: &str, case_sensitive: bool) -> bool {
    let pattern = if case_sensitive { pattern.to_string() } else { pattern.to_lowercase() };
    let value = if case_sensitive { value.to_string() } else { value.to_lowercase() };
    let pattern = pattern.chars().collect::<Vec<_>>();
    let value = value.chars().collect::<Vec<_>>();
    let mut matches = vec![vec![false; value.len() + 1]; pattern.len() + 1];
    matches[0][0] = true;
    for index in 1..=pattern.len() {
        if pattern[index - 1] == '*' {
            matches[index][0] = matches[index - 1][0];
        }
    }
    for pattern_index in 1..=pattern.len() {
        for value_index in 1..=value.len() {
            matches[pattern_index][value_index] = match pattern[pattern_index - 1] {
                '*' => matches[pattern_index - 1][value_index] || matches[pattern_index][value_index - 1],
                '?' => matches[pattern_index - 1][value_index - 1],
                character => character == value[value_index - 1] && matches[pattern_index - 1][value_index - 1],
            };
        }
    }
    matches[pattern.len()][value.len()]
}

fn backup_file_name(schedule_name: &str, file_stem: &str, started_at: chrono::DateTime<Local>, run_id: &str) -> String {
    let name = format!(
        "dbx-backup__{}__{}__{}__{}.sql",
        bounded_file_segment(schedule_name, BACKUP_NAME_SEGMENT_MAX_BYTES),
        started_at.format("%Y%m%d-%H%M%S"),
        bounded_file_segment(file_stem, BACKUP_NAME_SEGMENT_MAX_BYTES),
        bounded_file_segment(run_id, BACKUP_RUN_ID_SEGMENT_MAX_BYTES)
    );
    debug_assert!(name.len() <= 255);
    name
}

fn bounded_file_segment(value: &str, max_bytes: usize) -> String {
    let sanitized = sanitize_file_segment(value);
    if sanitized.len() <= max_bytes {
        return sanitized;
    }
    let mut end = max_bytes;
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    sanitized[..end].to_string()
}

fn sanitize_file_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .to_string();
    if sanitized.is_empty() {
        "database".to_string()
    } else {
        sanitized
    }
}

fn append_error(current: Option<String>, next: String) -> Option<String> {
    Some(match current {
        Some(current) => format!("{current}; {next}"),
        None => next,
    })
}

fn mysql_lower_case_table_names_are_case_sensitive(value: Option<&serde_json::Value>) -> bool {
    let value = value.and_then(|value| match value {
        serde_json::Value::String(value) => value.trim().parse::<u8>().ok(),
        serde_json::Value::Number(value) => value.as_u64().and_then(|value| u8::try_from(value).ok()),
        _ => None,
    });
    !matches!(value, Some(1 | 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_resolution_excludes_only_implicit_system_databases() {
        assert_eq!(
            resolve_database_targets(
                &[],
                vec!["mysql".to_string(), "app".to_string(), "sys".to_string()],
                DatabaseType::Mysql,
            )
            .unwrap(),
            vec!["app"]
        );
        assert_eq!(
            resolve_database_targets(
                &["mysql".to_string()],
                vec!["mysql".to_string(), "app".to_string()],
                DatabaseType::Mysql,
            )
            .unwrap(),
            vec!["mysql"]
        );
    }

    #[test]
    fn target_resolution_rejects_removed_database() {
        assert!(resolve_database_targets(
            &["app".to_string(), "renamed".to_string()],
            vec!["app".to_string()],
            DatabaseType::Postgres,
        )
        .is_err());
    }

    #[test]
    fn table_patterns_support_qualified_wildcards_and_case_rules() {
        assert!(table_matches_pattern("events", "app", "public", "public.*", true));
        assert!(table_matches_pattern("audit_log", "app", "public", "audit_?og", true));
        assert!(!table_matches_pattern("Orders", "app", "public", "orders", true));
        assert!(table_matches_pattern("Orders", "app", "public", "orders", false));
    }

    #[test]
    fn interprets_mysql_lower_case_table_names_like_desktop() {
        assert!(mysql_lower_case_table_names_are_case_sensitive(Some(&serde_json::json!(0))));
        assert!(!mysql_lower_case_table_names_are_case_sensitive(Some(&serde_json::json!(1))));
        assert!(!mysql_lower_case_table_names_are_case_sensitive(Some(&serde_json::json!("2"))));
        assert!(mysql_lower_case_table_names_are_case_sensitive(Some(&serde_json::json!("invalid"))));
        assert!(mysql_lower_case_table_names_are_case_sensitive(None));
    }

    #[test]
    fn generated_backup_names_are_single_safe_sql_files() {
        let started = chrono::TimeZone::with_ymd_and_hms(&Local, 2026, 7, 22, 2, 3, 4).single().unwrap();
        let name = backup_file_name("Nightly: prod", "app/private", started, "12345678-abcd");
        assert_eq!(name, "dbx-backup__Nightly_ prod__20260722-020304__app_private__12345678.sql");
        assert_eq!(Path::new(&name).components().count(), 1);
    }

    #[test]
    fn generated_backup_names_truncate_long_unicode_segments_by_utf8_bytes() {
        let started = chrono::TimeZone::with_ymd_and_hms(&Local, 2026, 7, 22, 2, 3, 4).single().unwrap();
        let name =
            backup_file_name(&"夜间数据库备份".repeat(80), &"生产数据库_公共模式".repeat(80), started, "12345678-abcd");

        assert!(name.len() <= 255);
        assert!(name.starts_with("dbx-backup__"));
        assert!(name.ends_with("__12345678.sql"));
        assert_eq!(Path::new(&name).components().count(), 1);
    }
}
