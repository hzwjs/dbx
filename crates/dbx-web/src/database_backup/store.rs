use std::path::{Path, PathBuf};

use chrono::Local;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::model::{
    next_web_database_backup_run_at, WebDatabaseBackupFile, WebDatabaseBackupMetadata, WebDatabaseBackupRun,
    WebDatabaseBackupRunStatus, WebDatabaseBackupSchedule, WebDatabaseBackupScheduleInput,
    MAX_WEB_DATABASE_BACKUP_HISTORY, WEB_DATABASE_BACKUP_METADATA_VERSION,
};

pub struct WebDatabaseBackupStore {
    path: PathBuf,
    metadata: Mutex<WebDatabaseBackupMetadata>,
}

impl WebDatabaseBackupStore {
    pub async fn open(path: PathBuf) -> Result<Self, String> {
        let metadata = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let metadata: WebDatabaseBackupMetadata = serde_json::from_slice(&bytes).map_err(|error| {
                    format!("Failed to parse Web database backup metadata {}: {error}", path.display())
                })?;
                if metadata.version != WEB_DATABASE_BACKUP_METADATA_VERSION {
                    return Err(format!(
                        "Unsupported Web database backup metadata version {} in {}",
                        metadata.version,
                        path.display()
                    ));
                }
                metadata
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => WebDatabaseBackupMetadata::default(),
            Err(error) => {
                return Err(format!("Failed to read Web database backup metadata {}: {error}", path.display()))
            }
        };
        Ok(Self { path, metadata: Mutex::new(metadata) })
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let metadata = self.metadata.lock().await;
        if tokio::fs::try_exists(&self.path).await.map_err(|error| error.to_string())? {
            return Ok(());
        }
        self.persist_locked(&metadata).await
    }

    pub async fn list_schedules(&self) -> Vec<WebDatabaseBackupSchedule> {
        let mut schedules = self.metadata.lock().await.schedules.clone();
        schedules.sort_by(|left, right| left.input.name.cmp(&right.input.name));
        schedules
    }

    pub async fn get_schedule(&self, schedule_id: &str) -> Option<WebDatabaseBackupSchedule> {
        self.metadata.lock().await.schedules.iter().find(|schedule| schedule.id == schedule_id).cloned()
    }

    pub async fn create_schedule(
        &self,
        input: WebDatabaseBackupScheduleInput,
    ) -> Result<WebDatabaseBackupSchedule, String> {
        let schedule = WebDatabaseBackupSchedule::new(uuid::Uuid::new_v4().to_string(), input, Local::now());
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        candidate.schedules.push(schedule.clone());
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(schedule)
    }

    pub async fn update_schedule(
        &self,
        schedule_id: &str,
        input: WebDatabaseBackupScheduleInput,
    ) -> Result<Option<WebDatabaseBackupSchedule>, String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let Some(index) = candidate.schedules.iter().position(|schedule| schedule.id == schedule_id) else {
            return Ok(None);
        };
        let previous = &candidate.schedules[index];
        let now = Local::now();
        let timing_changed = previous.input.frequency != input.frequency
            || previous.input.interval_hours != input.interval_hours
            || previous.input.time_of_day != input.time_of_day
            || previous.input.weekday != input.weekday
            || (!previous.input.enabled && input.enabled);
        let next_run_at = if timing_changed {
            next_web_database_backup_run_at(&input, now).to_rfc3339()
        } else {
            previous.next_run_at.clone()
        };
        let updated = WebDatabaseBackupSchedule {
            id: previous.id.clone(),
            input,
            created_at: previous.created_at.clone(),
            updated_at: now.to_rfc3339(),
            next_run_at,
            last_run_at: previous.last_run_at.clone(),
            last_run_status: previous.last_run_status,
        };
        candidate.schedules[index] = updated.clone();
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(Some(updated))
    }

    pub async fn delete_schedule(&self, schedule_id: &str) -> Result<bool, String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let previous_len = candidate.schedules.len();
        candidate.schedules.retain(|schedule| schedule.id != schedule_id);
        if previous_len == candidate.schedules.len() {
            return Ok(false);
        }
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(true)
    }

    pub async fn list_runs(&self) -> Vec<WebDatabaseBackupRun> {
        let mut runs = self.metadata.lock().await.runs.clone();
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        runs
    }

    pub async fn get_run(&self, run_id: &str) -> Option<WebDatabaseBackupRun> {
        self.metadata.lock().await.runs.iter().find(|run| run.id == run_id).cloned()
    }

    pub async fn upsert_run(&self, run: WebDatabaseBackupRun) -> Result<(), String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        if let Some(existing) = candidate.runs.iter_mut().find(|existing| existing.id == run.id) {
            *existing = run;
        } else {
            candidate.runs.push(run);
        }
        candidate.runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(())
    }

    pub async fn add_run_file(&self, run_id: &str, file: WebDatabaseBackupFile) -> Result<(), String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let run =
            candidate.runs.iter_mut().find(|run| run.id == run_id).ok_or_else(|| "Backup run not found".to_string())?;
        run.files.push(file);
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(())
    }

    pub async fn complete_run(
        &self,
        run_id: &str,
        status: WebDatabaseBackupRunStatus,
        error: Option<String>,
    ) -> Result<Option<WebDatabaseBackupRun>, String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let now = Local::now();
        let completed_at = now.to_rfc3339();
        let Some(run_index) = candidate.runs.iter().position(|run| run.id == run_id) else {
            return Ok(None);
        };
        let schedule_id = candidate.runs[run_index].schedule_id.clone();
        candidate.runs[run_index].status = status;
        candidate.runs[run_index].completed_at = Some(completed_at.clone());
        candidate.runs[run_index].error = error;
        let trigger = candidate.runs[run_index].trigger;

        if let Some(schedule) = candidate.schedules.iter_mut().find(|schedule| schedule.id == schedule_id) {
            schedule.last_run_at = Some(completed_at);
            schedule.last_run_status = Some(status);
            let next_is_due = chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at)
                .map(|next| next <= now.fixed_offset())
                .unwrap_or(true);
            if trigger == super::model::WebDatabaseBackupRunTrigger::Scheduled || next_is_due {
                schedule.next_run_at = next_web_database_backup_run_at(&schedule.input, now).to_rfc3339();
            }
            schedule.updated_at = now.to_rfc3339();
        }

        let completed = candidate.runs[run_index].clone();
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(Some(completed))
    }

    pub async fn clear_run_files(&self, run_id: &str) -> Result<(), String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let run =
            candidate.runs.iter_mut().find(|run| run.id == run_id).ok_or_else(|| "Backup run not found".to_string())?;
        run.files.clear();
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(())
    }

    pub async fn delete_run(&self, run_id: &str) -> Result<bool, String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let previous_len = candidate.runs.len();
        candidate.runs.retain(|run| run.id != run_id);
        if previous_len == candidate.runs.len() {
            return Ok(false);
        }
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(true)
    }

    pub async fn due_schedule_ids(&self, now: chrono::DateTime<chrono::FixedOffset>) -> Vec<String> {
        let metadata = self.metadata.lock().await;
        let mut due = metadata
            .schedules
            .iter()
            .filter(|schedule| {
                schedule.input.enabled
                    && chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at).is_ok_and(|next| next <= now)
            })
            .collect::<Vec<_>>();
        due.sort_by(|left, right| {
            left.next_run_at.cmp(&right.next_run_at).then_with(|| left.input.name.cmp(&right.input.name))
        });
        due.into_iter().map(|schedule| schedule.id.clone()).collect()
    }

    pub async fn successful_runs_to_prune(
        &self,
        schedule_id: &str,
        retention_count: usize,
    ) -> Vec<WebDatabaseBackupRun> {
        let metadata = self.metadata.lock().await;
        let mut runs = metadata
            .runs
            .iter()
            .filter(|run| run.schedule_id == schedule_id && run.status == WebDatabaseBackupRunStatus::Success)
            .cloned()
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        runs.into_iter().skip(retention_count).collect()
    }

    pub async fn runs_exceeding_history_limit(&self) -> Vec<WebDatabaseBackupRun> {
        let metadata = self.metadata.lock().await;
        let mut runs = metadata.runs.clone();
        runs.sort_by(|left, right| right.started_at.cmp(&left.started_at).then_with(|| right.id.cmp(&left.id)));
        runs.into_iter().skip(MAX_WEB_DATABASE_BACKUP_HISTORY).collect()
    }

    pub async fn recover_interrupted_runs(&self) -> Result<Vec<WebDatabaseBackupRun>, String> {
        let mut metadata = self.metadata.lock().await;
        let mut candidate = metadata.clone();
        let now = Local::now().to_rfc3339();
        let mut recovered = Vec::new();
        for run in &mut candidate.runs {
            if run.status == WebDatabaseBackupRunStatus::Running {
                run.status = WebDatabaseBackupRunStatus::Failed;
                run.completed_at = Some(now.clone());
                run.error = Some("Web service restarted while the backup was running".to_string());
                recovered.push(run.clone());
            }
        }
        if recovered.is_empty() {
            return Ok(recovered);
        }
        self.persist_locked(&candidate).await?;
        *metadata = candidate;
        Ok(recovered)
    }

    async fn persist_locked(&self, metadata: &WebDatabaseBackupMetadata) -> Result<(), String> {
        let parent = self.path.parent().ok_or_else(|| "Backup metadata path has no parent directory".to_string())?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create backup metadata directory: {error}"))?;
        let temp_path = parent.join(format!(".web-database-backups-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await
            .map_err(|error| format!("Failed to create backup metadata temp file: {error}"))?;
        let write_result = file.write_all(&bytes).await;
        let write_result = match write_result {
            Ok(()) => file.sync_all().await,
            Err(error) => Err(error),
        };
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!("Failed to write backup metadata: {error}"));
        }
        drop(file);
        if let Err(error) = tokio::fs::rename(&temp_path, &self.path).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(format!("Failed to atomically replace backup metadata: {error}"));
        }
        Ok(())
    }
}

pub fn managed_backup_file_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    // 第一版只生成根目录下的单层 SQL 文件，直接拒绝任何目录分量，消除路径逃逸入口。
    if relative.is_absolute()
        || relative.components().count() != 1
        || relative.extension().and_then(|value| value.to_str()) != Some("sql")
        || !relative_path.starts_with("dbx-backup__")
    {
        return Err("Invalid managed backup file path".to_string());
    }
    Ok(root.join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database_backup::model::{
        WebDatabaseBackupFrequency, WebDatabaseBackupRunTrigger, WebDatabaseBackupTableFilterMode,
    };

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!("dbx-web-backup-store-{}", uuid::Uuid::new_v4()))
    }

    fn input() -> WebDatabaseBackupScheduleInput {
        WebDatabaseBackupScheduleInput {
            name: "Nightly".to_string(),
            enabled: true,
            connection_id: "connection-1".to_string(),
            databases: Vec::new(),
            table_filter_mode: WebDatabaseBackupTableFilterMode::All,
            table_patterns: Vec::new(),
            frequency: WebDatabaseBackupFrequency::Daily,
            interval_hours: 6,
            time_of_day: "02:00".to_string(),
            weekday: 1,
            include_structure: true,
            include_data: true,
            include_objects: true,
            drop_table_if_exists: false,
            retention_count: 10,
        }
    }

    fn run(id: usize, started_at: String) -> WebDatabaseBackupRun {
        WebDatabaseBackupRun {
            id: format!("run-{id:03}"),
            schedule_id: "schedule-1".to_string(),
            schedule_name: "Nightly".to_string(),
            connection_id: "connection-1".to_string(),
            connection_name: "Postgres".to_string(),
            trigger: WebDatabaseBackupRunTrigger::Scheduled,
            status: WebDatabaseBackupRunStatus::Success,
            started_at,
            completed_at: Some(Local::now().to_rfc3339()),
            files: Vec::new(),
            error: None,
        }
    }

    #[tokio::test]
    async fn metadata_round_trips_and_running_runs_recover_as_failed() {
        let directory = test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join("metadata.json");
        let store = WebDatabaseBackupStore::open(path.clone()).await.unwrap();
        store.initialize().await.unwrap();
        let schedule = store.create_schedule(input()).await.unwrap();
        store
            .upsert_run(WebDatabaseBackupRun {
                id: "run-1".to_string(),
                schedule_id: schedule.id,
                schedule_name: schedule.input.name,
                connection_id: schedule.input.connection_id,
                connection_name: "Postgres".to_string(),
                trigger: WebDatabaseBackupRunTrigger::Scheduled,
                status: WebDatabaseBackupRunStatus::Running,
                started_at: Local::now().to_rfc3339(),
                completed_at: None,
                files: Vec::new(),
                error: None,
            })
            .await
            .unwrap();

        let reopened = WebDatabaseBackupStore::open(path).await.unwrap();
        assert_eq!(reopened.list_schedules().await.len(), 1);
        assert_eq!(reopened.recover_interrupted_runs().await.unwrap().len(), 1);
        assert_eq!(reopened.list_runs().await[0].status, WebDatabaseBackupRunStatus::Failed);
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn damaged_metadata_is_not_silently_replaced() {
        let directory = test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join("metadata.json");
        tokio::fs::write(&path, b"not-json").await.unwrap();
        assert!(WebDatabaseBackupStore::open(path).await.is_err());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn failed_persistence_does_not_mutate_in_memory_metadata() {
        let directory = test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        // 目标路径故意指向现有目录，使原子 rename 稳定失败。
        let store = WebDatabaseBackupStore {
            path: directory.clone(),
            metadata: Mutex::new(WebDatabaseBackupMetadata::default()),
        };

        assert!(store.create_schedule(input()).await.is_err());
        assert!(store.list_schedules().await.is_empty());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn upsert_preserves_overflow_for_manager_file_cleanup() {
        let directory = test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let started_at = chrono::DateTime::parse_from_rfc3339("2026-07-22T00:00:00+00:00").unwrap();
        let existing_runs = (0..MAX_WEB_DATABASE_BACKUP_HISTORY)
            .map(|index| run(index, (started_at + chrono::Duration::seconds(index as i64)).to_rfc3339()))
            .collect();
        let store = WebDatabaseBackupStore {
            path: directory.join("metadata.json"),
            metadata: Mutex::new(WebDatabaseBackupMetadata {
                version: WEB_DATABASE_BACKUP_METADATA_VERSION,
                schedules: Vec::new(),
                runs: existing_runs,
            }),
        };

        store
            .upsert_run(run(
                MAX_WEB_DATABASE_BACKUP_HISTORY,
                (started_at + chrono::Duration::seconds(MAX_WEB_DATABASE_BACKUP_HISTORY as i64)).to_rfc3339(),
            ))
            .await
            .unwrap();

        assert_eq!(store.list_runs().await.len(), MAX_WEB_DATABASE_BACKUP_HISTORY + 1);
        let candidates = store.runs_exceeding_history_limit().await;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "run-000");
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[test]
    fn managed_paths_reject_absolute_and_nested_values() {
        let root = Path::new("/tmp/backups");
        assert!(managed_backup_file_path(root, "dbx-backup__managed.sql").is_ok());
        assert!(managed_backup_file_path(root, "foreign.sql").is_err());
        assert!(managed_backup_file_path(root, "../escape.sql").is_err());
        assert!(managed_backup_file_path(root, "/tmp/escape.sql").is_err());
        assert!(managed_backup_file_path(root, "nested/escape.sql").is_err());
        assert!(managed_backup_file_path(root, "backup.txt").is_err());
    }
}
