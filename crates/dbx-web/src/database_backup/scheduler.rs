use std::sync::Arc;
use std::time::Duration;

use super::manager::{WebDatabaseBackupError, WebDatabaseBackupManager};

const WEB_DATABASE_BACKUP_SCHEDULER_INTERVAL: Duration = Duration::from_secs(30);

pub fn start_web_database_backup_scheduler(manager: Arc<WebDatabaseBackupManager>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(WEB_DATABASE_BACKUP_SCHEDULER_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match manager.run_due_schedule().await {
                Ok(_) => {}
                Err(WebDatabaseBackupError::Conflict(_)) => {}
                Err(error) => tracing::error!("Web database backup scheduler failed: {error:?}"),
            }
        }
    });
}
