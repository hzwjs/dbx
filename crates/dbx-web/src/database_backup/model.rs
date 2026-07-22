use std::collections::HashSet;

use chrono::{DateTime, Datelike, Duration, Local, Timelike};
use serde::{Deserialize, Serialize};

pub const WEB_DATABASE_BACKUP_METADATA_VERSION: u32 = 1;
pub const MAX_WEB_DATABASE_BACKUP_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WebDatabaseBackupFrequency {
    Hourly,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WebDatabaseBackupTableFilterMode {
    All,
    Include,
    Exclude,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WebDatabaseBackupRunTrigger {
    Manual,
    Scheduled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WebDatabaseBackupRunStatus {
    Running,
    Success,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupScheduleInput {
    pub name: String,
    pub enabled: bool,
    pub connection_id: String,
    #[serde(default)]
    pub databases: Vec<String>,
    pub table_filter_mode: WebDatabaseBackupTableFilterMode,
    #[serde(default)]
    pub table_patterns: Vec<String>,
    pub frequency: WebDatabaseBackupFrequency,
    pub interval_hours: u32,
    pub time_of_day: String,
    pub weekday: u32,
    pub include_structure: bool,
    pub include_data: bool,
    pub include_objects: bool,
    pub drop_table_if_exists: bool,
    pub retention_count: usize,
}

impl WebDatabaseBackupScheduleInput {
    pub fn validate_and_normalize(mut self) -> Result<Self, String> {
        self.name = self.name.trim().to_string();
        self.connection_id = self.connection_id.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 100 {
            return Err("Backup schedule name must contain 1 to 100 characters".to_string());
        }
        if self.connection_id.is_empty() {
            return Err("Backup connection is required".to_string());
        }
        if !(1..=168).contains(&self.interval_hours) {
            return Err("Backup interval must be between 1 and 168 hours".to_string());
        }
        if self.weekday > 6 {
            return Err("Backup weekday must be between 0 and 6".to_string());
        }
        if parse_time_of_day(&self.time_of_day).is_none() {
            return Err("Backup time must use HH:mm format".to_string());
        }
        if !(1..=100).contains(&self.retention_count) {
            return Err("Backup retention count must be between 1 and 100".to_string());
        }
        if !self.include_structure && !self.include_data && !self.include_objects {
            return Err("At least one backup content option must be enabled".to_string());
        }

        self.databases = unique_trimmed(self.databases, 100, 128, "database")?;
        self.table_patterns = unique_trimmed(self.table_patterns, 100, 256, "table pattern")?;
        match self.table_filter_mode {
            WebDatabaseBackupTableFilterMode::All => self.table_patterns.clear(),
            WebDatabaseBackupTableFilterMode::Include | WebDatabaseBackupTableFilterMode::Exclude
                if self.table_patterns.is_empty() =>
            {
                return Err("Filtered backups require at least one table pattern".to_string());
            }
            _ => {}
        }
        Ok(self)
    }
}

fn unique_trimmed(
    values: Vec<String>,
    max_count: usize,
    max_length: usize,
    label: &str,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > max_length {
            return Err(format!("Backup {label} is too long"));
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    if normalized.len() > max_count {
        return Err(format!("Too many backup {label} values"));
    }
    Ok(normalized)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupSchedule {
    pub id: String,
    #[serde(flatten)]
    pub input: WebDatabaseBackupScheduleInput,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<WebDatabaseBackupRunStatus>,
}

impl WebDatabaseBackupSchedule {
    pub fn new(id: String, input: WebDatabaseBackupScheduleInput, now: DateTime<Local>) -> Self {
        let now_iso = now.to_rfc3339();
        let next_run_at = next_web_database_backup_run_at(&input, now).to_rfc3339();
        Self {
            id,
            input,
            created_at: now_iso.clone(),
            updated_at: now_iso,
            next_run_at,
            last_run_at: None,
            last_run_status: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupFile {
    pub database: String,
    pub schema: String,
    pub display_name: String,
    /// 始终是备份根目录下的单层相对文件名，绝不保存客户端路径。
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupRun {
    pub id: String,
    pub schedule_id: String,
    pub schedule_name: String,
    pub connection_id: String,
    pub connection_name: String,
    pub trigger: WebDatabaseBackupRunTrigger,
    pub status: WebDatabaseBackupRunStatus,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub files: Vec<WebDatabaseBackupFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupMetadata {
    pub version: u32,
    #[serde(default)]
    pub schedules: Vec<WebDatabaseBackupSchedule>,
    #[serde(default)]
    pub runs: Vec<WebDatabaseBackupRun>,
}

impl Default for WebDatabaseBackupMetadata {
    fn default() -> Self {
        Self { version: WEB_DATABASE_BACKUP_METADATA_VERSION, schedules: Vec::new(), runs: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDatabaseBackupConfig {
    pub available: bool,
    pub backup_directory: String,
    pub server_timezone: String,
}

pub fn next_web_database_backup_run_at(
    input: &WebDatabaseBackupScheduleInput,
    after: DateTime<Local>,
) -> DateTime<Local> {
    if input.frequency == WebDatabaseBackupFrequency::Hourly {
        return after + Duration::hours(i64::from(input.interval_hours));
    }

    let (hour, minute) = parse_time_of_day(&input.time_of_day).expect("validated backup time");
    let mut next = after
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .and_then(|value| value.with_hour(hour))
        .and_then(|value| value.with_minute(minute))
        .expect("valid local backup time");

    if input.frequency == WebDatabaseBackupFrequency::Daily {
        if next <= after {
            next += Duration::days(1);
        }
        return next;
    }

    let current_weekday = next.weekday().num_days_from_sunday();
    let mut days_ahead = (input.weekday + 7 - current_weekday) % 7;
    if days_ahead == 0 && next <= after {
        days_ahead = 7;
    }
    next + Duration::days(i64::from(days_ahead))
}

fn parse_time_of_day(value: &str) -> Option<(u32, u32)> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2
        || minute.len() != 2
        || !hour.bytes().all(|value| value.is_ascii_digit())
        || !minute.bytes().all(|value| value.is_ascii_digit())
    {
        return None;
    }
    let hour = hour.parse::<u32>().ok()?;
    let minute = minute.parse::<u32>().ok()?;
    (hour < 24 && minute < 60).then_some((hour, minute))
}

#[cfg(test)]
mod tests {
    use chrono::{Local, TimeZone};

    use super::*;

    fn input(frequency: WebDatabaseBackupFrequency) -> WebDatabaseBackupScheduleInput {
        WebDatabaseBackupScheduleInput {
            name: "Nightly".to_string(),
            enabled: true,
            connection_id: "connection-1".to_string(),
            databases: Vec::new(),
            table_filter_mode: WebDatabaseBackupTableFilterMode::All,
            table_patterns: Vec::new(),
            frequency,
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

    #[test]
    fn validation_rejects_empty_content_and_filtered_schedule_without_patterns() {
        let mut value = input(WebDatabaseBackupFrequency::Daily);
        value.include_structure = false;
        value.include_data = false;
        value.include_objects = false;
        assert!(value.validate_and_normalize().is_err());

        let mut value = input(WebDatabaseBackupFrequency::Daily);
        value.table_filter_mode = WebDatabaseBackupTableFilterMode::Include;
        assert!(value.validate_and_normalize().is_err());
    }

    #[test]
    fn validation_deduplicates_server_owned_scope_values() {
        let mut value = input(WebDatabaseBackupFrequency::Daily);
        value.databases = vec![" app ".to_string(), "app".to_string(), "audit".to_string()];
        value.table_filter_mode = WebDatabaseBackupTableFilterMode::Exclude;
        value.table_patterns = vec![" tmp_* ".to_string(), "tmp_*".to_string()];
        let value = value.validate_and_normalize().unwrap();
        assert_eq!(value.databases, vec!["app", "audit"]);
        assert_eq!(value.table_patterns, vec!["tmp_*"]);
    }

    #[test]
    fn daily_and_weekly_schedules_advance_from_server_local_time() {
        let after = Local.with_ymd_and_hms(2026, 7, 16, 3, 30, 0).single().unwrap();
        let daily = next_web_database_backup_run_at(&input(WebDatabaseBackupFrequency::Daily), after);
        assert_eq!((daily.day(), daily.hour(), daily.minute()), (17, 2, 0));

        let weekly = next_web_database_backup_run_at(&input(WebDatabaseBackupFrequency::Weekly), after);
        assert_eq!(weekly.weekday().num_days_from_sunday(), 1);
        assert!(weekly > after);
    }
}
