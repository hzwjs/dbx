use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, RwLock};

use super::connection::AppState;

const BIND_ADDR: &str = "127.0.0.1:0";
const DISCOVERY_FILE: &str = "agent-runtime.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeSnapshot {
    pub active_connection_id: Option<String>,
    pub active_connection_name: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub active_tab_id: Option<String>,
    pub active_tab_title: Option<String>,
    pub sql: Option<String>,
    pub selected_sql: Option<String>,
    pub selection: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
}

#[derive(Clone)]
pub struct AgentRuntimeState {
    pub token: String,
    pub snapshot: Arc<RwLock<AgentRuntimeSnapshot>>,
    pub handoffs: Arc<RwLock<Vec<dbx_core::handoff::HandoffItem>>>,
}

pub struct AgentRuntimeServer {
    state: AgentRuntimeState,
    discovery_path: PathBuf,
    shutdown: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl AgentRuntimeServer {
    pub fn state(&self) -> &AgentRuntimeState {
        &self.state
    }

    pub fn cleanup(&self) {
        if let Ok(mut shutdown) = self.shutdown.lock() {
            if let Some(tx) = shutdown.take() {
                let _ = tx.send(());
            }
        }
        cleanup_discovery_file(&self.discovery_path);
    }
}

impl Drop for AgentRuntimeServer {
    fn drop(&mut self) {
        if let Ok(mut shutdown) = self.shutdown.lock() {
            if let Some(tx) = shutdown.take() {
                let _ = tx.send(());
            }
        }
        cleanup_discovery_file(&self.discovery_path);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeResponse {
    status: &'static str,
    body: serde_json::Value,
}

#[tauri::command]
pub async fn agent_runtime_update_snapshot(
    runtime: tauri::State<'_, AgentRuntimeServer>,
    snapshot: AgentRuntimeSnapshot,
) -> Result<(), String> {
    *runtime.state().snapshot.write().await = snapshot;
    Ok(())
}

#[tauri::command]
pub async fn agent_runtime_load_handoffs(
    app_state: tauri::State<'_, Arc<AppState>>,
    runtime: tauri::State<'_, AgentRuntimeServer>,
) -> Result<Vec<dbx_core::handoff::HandoffItem>, String> {
    let mut items = app_state.storage.load_pending_handoffs().await?;
    items.extend(runtime.state().handoffs.read().await.iter().cloned());
    Ok(items)
}

pub fn start(app: AppHandle) -> AgentRuntimeServer {
    let token = uuid::Uuid::new_v4().to_string();
    let state = AgentRuntimeState {
        token: token.clone(),
        snapshot: Arc::new(RwLock::new(AgentRuntimeSnapshot::default())),
        handoffs: Arc::new(RwLock::new(Vec::new())),
    };
    let discovery_path =
        app.path().app_data_dir().map(|dir| dir.join(DISCOVERY_FILE)).unwrap_or_else(|_| PathBuf::from(DISCOVERY_FILE));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_state = state.clone();

    tauri::async_runtime::spawn(async move {
        run_server(app, server_state, shutdown_rx).await;
    });

    AgentRuntimeServer { state, discovery_path, shutdown: std::sync::Mutex::new(Some(shutdown_tx)) }
}

async fn run_server(app: AppHandle, state: AgentRuntimeState, mut shutdown: oneshot::Receiver<()>) {
    let listener = match TcpListener::bind(BIND_ADDR).await {
        Ok(listener) => listener,
        Err(err) => {
            log::warn!("Agent runtime failed to bind {BIND_ADDR}: {err}");
            return;
        }
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    let discovery_path = match app.path().app_data_dir() {
        Ok(dir) => match write_discovery_file(&dir, port, &state.token) {
            Ok(path) => Some(path),
            Err(err) => {
                log::warn!("Agent runtime discovery write failed: {err}");
                None
            }
        },
        Err(err) => {
            log::warn!("Agent runtime app data dir unavailable: {err}");
            None
        }
    };
    log::info!("Agent runtime listening on 127.0.0.1:{port}");

    loop {
        tokio::select! {
            _ = &mut shutdown => {
                if let Some(path) = discovery_path.as_deref() {
                    cleanup_discovery_file(path);
                }
                break;
            }
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let st = state.clone();
                tokio::spawn(async move {
                    handle_connection(stream, st).await;
                });
            }
        }
    }
}

async fn handle_connection(mut stream: TcpStream, state: AgentRuntimeState) {
    let mut buf = vec![0u8; 65536];
    let Ok(n) = stream.read(&mut buf).await else {
        return;
    };
    if n == 0 {
        return;
    }

    let request = String::from_utf8_lossy(&buf[..n]);
    if !is_authorized(&request, &state.token) {
        respond_json(&mut stream, "401 Unauthorized", serde_json::json!({"error": "unauthorized"})).await;
        return;
    }

    let first_line = request.lines().next().unwrap_or("");
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    let response = route_request(first_line, body, &state).await;
    respond_json(&mut stream, response.status, response.body).await;
}

fn is_authorized(request: &str, token: &str) -> bool {
    request.lines().any(|line| line.trim_end() == format!("Authorization: Bearer {token}"))
}

async fn route_request(first_line: &str, body: &str, state: &AgentRuntimeState) -> RuntimeResponse {
    if first_line.starts_with("GET /context ") || first_line.starts_with("GET /context?") {
        return RuntimeResponse {
            status: "200 OK",
            body: serde_json::to_value(&*state.snapshot.read().await).unwrap_or_else(|_| serde_json::json!({})),
        };
    }

    if first_line.starts_with("GET /selection ") || first_line.starts_with("GET /selection?") {
        let snapshot = state.snapshot.read().await;
        return RuntimeResponse {
            status: "200 OK",
            body: snapshot.selection.clone().unwrap_or_else(|| serde_json::json!({"type": "none"})),
        };
    }

    if first_line.starts_with("GET /result/current ") || first_line.starts_with("GET /result/current?") {
        let snapshot = state.snapshot.read().await;
        return RuntimeResponse {
            status: "200 OK",
            body: snapshot.result.clone().unwrap_or_else(|| serde_json::json!({"columns": [], "rows": []})),
        };
    }

    if first_line.starts_with("POST /handoff ") {
        let mut item = match serde_json::from_str::<dbx_core::handoff::HandoffItem>(body) {
            Ok(item) => item,
            Err(_) => {
                return RuntimeResponse {
                    status: "400 Bad Request",
                    body: serde_json::json!({"error": "invalid handoff"}),
                };
            }
        };
        item.status = dbx_core::handoff::HandoffStatus::Shown;
        let id = item.id.clone();
        state.handoffs.write().await.push(item);
        return RuntimeResponse { status: "200 OK", body: serde_json::json!({"id": id, "status": "shown"}) };
    }

    RuntimeResponse { status: "404 Not Found", body: serde_json::json!({"error": "not found"}) }
}

fn write_discovery_file(dir: &Path, port: u16, token: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let path = dir.join(DISCOVERY_FILE);
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            std::fs::remove_file(&path).map_err(|err| err.to_string())?;
        }
    }
    let payload = serde_json::json!({ "port": port, "token": token });
    let body = serde_json::to_vec(&payload).map_err(|err| err.to_string())?;

    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|err| err.to_string())?;
    file.write_all(&body).map_err(|err| err.to_string())?;
    file.sync_all().map_err(|err| err.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file.metadata().map_err(|err| err.to_string())?.permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&path, permissions).map_err(|err| err.to_string())?;
    }

    Ok(path)
}

fn cleanup_discovery_file(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

async fn respond_json(stream: &mut TcpStream, status: &str, body: serde_json::Value) {
    let body = serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string());
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_state() -> AgentRuntimeState {
        AgentRuntimeState {
            token: "secret-token".to_string(),
            snapshot: Arc::new(RwLock::new(AgentRuntimeSnapshot::default())),
            handoffs: Arc::new(RwLock::new(Vec::new())),
        }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn authorization_requires_exact_bearer_token() {
        assert!(is_authorized("GET /context HTTP/1.1\r\nAuthorization: Bearer secret-token\r\n\r\n", "secret-token",));
        assert!(!is_authorized("GET /context HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n", "secret-token",));
        assert!(!is_authorized("GET /context HTTP/1.1\r\n\r\n", "secret-token"));
    }

    #[tokio::test]
    async fn routes_context_selection_result_and_handoff_from_shared_state() {
        let state = runtime_state();
        *state.snapshot.write().await = AgentRuntimeSnapshot {
            active_connection_id: Some("conn-1".to_string()),
            active_connection_name: Some("Local".to_string()),
            selection: Some(serde_json::json!({"type": "grid-cells", "cells": [[1]]})),
            result: Some(serde_json::json!({"columns": ["id"], "rows": [[1]]})),
            ..AgentRuntimeSnapshot::default()
        };

        let context = route_request("GET /context HTTP/1.1", "", &state).await;
        assert_eq!(context.status, "200 OK");
        assert_eq!(context.body["activeConnectionId"], "conn-1");

        let selection = route_request("GET /selection HTTP/1.1", "", &state).await;
        assert_eq!(selection.status, "200 OK");
        assert_eq!(selection.body["type"], "grid-cells");

        let result = route_request("GET /result/current?limit=50 HTTP/1.1", "", &state).await;
        assert_eq!(result.status, "200 OK");
        assert_eq!(result.body["columns"][0], "id");

        let item = dbx_core::handoff::HandoffItem::queued(
            "conn-1".to_string(),
            "Local".to_string(),
            Some("main".to_string()),
            "Review SQL".to_string(),
            None,
            "update users set name = 'a'".to_string(),
            dbx_core::sql_safety::OperationClass::Write,
            dbx_core::sql_safety::RiskLevel::Medium,
            false,
        );
        let handoff = route_request("POST /handoff HTTP/1.1", &serde_json::to_string(&item).unwrap(), &state).await;
        assert_eq!(handoff.status, "200 OK");
        assert_eq!(handoff.body["id"], item.id);
        assert_eq!(state.handoffs.read().await.len(), 1);
    }

    #[test]
    fn discovery_file_is_owner_only_and_removed_on_cleanup() {
        let dir = std::env::temp_dir().join(format!("dbx-agent-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let path = write_discovery_file(&dir, 4321, "secret-token").unwrap();
        let payload: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(payload["port"], 4321);
        assert_eq!(payload["token"], "secret-token");
        #[cfg(unix)]
        assert_eq!(mode(&path), 0o600);

        cleanup_discovery_file(&path);
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_file_replaces_existing_symlink() {
        let dir = std::env::temp_dir().join(format!("dbx-agent-runtime-symlink-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.json");
        let link = dir.join(DISCOVERY_FILE);
        std::fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let path = write_discovery_file(&dir, 4321, "secret-token").unwrap();

        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(mode(&path), 0o600);

        let _ = std::fs::remove_dir_all(dir);
    }
}
