//! App-owned development services, independent of agent session lifetimes.
pub mod mcp;
use crate::agent::native::config::ShellSandboxMode;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

const LOG_LIMIT: usize = 128 * 1024;
const SERVICE_LIMIT: usize = 64;

#[derive(Clone)]
pub struct ServiceContext {
    pub project: PathBuf,
    pub conversation_id: String,
    pub env: HashMap<String, String>,
    pub sandbox: ShellSandboxMode,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartService {
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub cwd: String,
    pub project_path: String,
    pub conversation_id: String,
    pub status: String,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub listening: bool,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

struct Service {
    info: Mutex<ServiceInfo>,
    context: ServiceContext,
    log: Mutex<VecDeque<u8>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    busy: AtomicBool,
}

#[derive(Default)]
pub struct ServiceManager {
    services: Mutex<HashMap<String, Arc<Service>>>,
    shutting_down: AtomicBool,
}

pub fn manager() -> &'static ServiceManager {
    static INSTANCE: OnceLock<ServiceManager> = OnceLock::new();
    INSTANCE.get_or_init(ServiceManager::default)
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Service {
    fn operation(&self) -> Result<Operation<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "服务正在执行其他操作".to_string())?;
        Ok(Operation(&self.busy))
    }

    async fn launch(self: &Arc<Self>) -> Result<ServiceInfo, String> {
        let (ready_tx, ready_rx) = oneshot::channel();
        let (stop_tx, stop_rx) = oneshot::channel();
        *self.stop.lock().unwrap() = Some(stop_tx);
        {
            let mut info = self.info.lock().unwrap();
            info.status = "starting".into();
            info.error = None;
            info.exit_code = None;
            info.listening = false;
        }
        self.log.lock().unwrap().clear();
        let service = Arc::clone(self);
        // Use the app runtime: closing an agent session must not abort services.
        tauri::async_runtime::spawn(async move {
            let info = service.info.lock().unwrap().clone();
            let result = crate::agent::native::tools::sandboxed_shell_command(
                &info.command,
                &service.context.project,
                service.context.sandbox,
            )
            .and_then(|mut cmd| {
                cmd.current_dir(&info.cwd)
                    .envs(&service.context.env)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                crate::agent::process_tree::configure_new_group(&mut cmd);
                cmd.spawn().map_err(|e| e.to_string())
            });
            let mut child = match result {
                Ok(child) => child,
                Err(error) => {
                    let mut info = service.info.lock().unwrap();
                    info.status = "failed".into();
                    info.error = Some(error.clone());
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            {
                let mut info = service.info.lock().unwrap();
                info.pid = child.id();
                info.status = "running".into();
            }
            let group_pid = child.id();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let output = service.clone();
            let mut stdout_task = tauri::async_runtime::spawn(async move {
                if let Some(stdout) = stdout {
                    drain(stdout, output).await;
                }
            });
            let output = service.clone();
            let mut stderr_task = tauri::async_runtime::spawn(async move {
                if let Some(stderr) = stderr {
                    drain(stderr, output).await;
                }
            });
            let _ = ready_tx.send(Ok(service.info.lock().unwrap().clone()));
            let (stopped, result) = tokio::select! {
                _ = stop_rx => {
                    terminate(&mut child).await;
                    (true, child.wait().await)
                }
                result = child.wait() => (false, result),
            };
            // A wrapper can exit before descendants close the output pipes.
            #[cfg(unix)]
            if let Some(pid) = group_pid {
                unsafe {
                    libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            let _ = group_pid;
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(200), &mut stdout_task).await;
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(200), &mut stderr_task).await;
            stdout_task.abort();
            stderr_task.abort();
            let mut info = service.info.lock().unwrap();
            info.pid = None;
            info.listening = false;
            info.exit_code = result.as_ref().ok().and_then(|s| s.code());
            info.status = if stopped || result.as_ref().is_ok_and(|s| s.success()) {
                "stopped"
            } else {
                "failed"
            }
            .into();
            info.error = result.err().map(|e| e.to_string());
        });
        ready_rx
            .await
            .map_err(|_| "服务启动任务已退出".to_string())?
    }

    async fn stop(&self) -> Result<(), String> {
        let tx = self.stop.lock().unwrap().take();
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
        while {
            let info = self.info.lock().unwrap();
            info.pid.is_some() || info.status == "starting"
        } {
            if tokio::time::Instant::now() >= deadline {
                return Err("等待服务停止超时".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        Ok(())
    }
}

async fn drain<R: tokio::io::AsyncRead + Unpin>(mut reader: R, service: Arc<Service>) {
    let mut buf = [0; 4096];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut log = service.log.lock().unwrap();
        log.extend(&buf[..n]);
        let excess = log.len().saturating_sub(LOG_LIMIT);
        log.drain(..excess);
    }
}

async fn terminate(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
        }
        if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
            .await
            .is_ok()
        {
            // Children may still be alive even when the shell has exited.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
            return;
        }
    }
    crate::agent::process_tree::kill_tree(child).await;
}

impl ServiceManager {
    pub async fn start(
        &self,
        context: ServiceContext,
        request: StartService,
    ) -> Result<ServiceInfo, String> {
        if request.name.trim().is_empty()
            || request.name.len() > 120
            || request.command.trim().is_empty()
            || request.command.len() > 8192
            || request.port == Some(0)
        {
            return Err("服务名称、启动命令或端口无效".into());
        }
        let project = context.project.canonicalize().map_err(|e| e.to_string())?;
        let cwd = match request.cwd.as_deref() {
            Some(path) => project.join(path),
            None => project.clone(),
        }
        .canonicalize()
        .map_err(|e| e.to_string())?;
        if !cwd.starts_with(&project) || !cwd.is_dir() {
            return Err("服务目录必须位于当前项目内".into());
        }
        let info = ServiceInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name: request.name.trim().into(),
            command: request.command,
            cwd: cwd.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            conversation_id: context.conversation_id.clone(),
            status: "starting".into(),
            pid: None,
            port: request.port,
            listening: false,
            exit_code: None,
            error: None,
        };
        let service = Arc::new(Service {
            info: Mutex::new(info.clone()),
            context,
            log: Mutex::new(VecDeque::new()),
            stop: Mutex::new(None),
            busy: AtomicBool::new(true),
        });
        {
            let mut services = self.services.lock().unwrap();
            if self.shutting_down.load(Ordering::Acquire) {
                return Err("Nex 正在退出".into());
            }
            if services.len() >= SERVICE_LIMIT {
                return Err("服务数量已达上限，请移除已停止的服务".into());
            }
            if services.values().any(|s| {
                let existing = s.info.lock().unwrap();
                existing.project_path == info.project_path && existing.name == info.name
            }) {
                return Err("同项目已有同名服务，请使用现有服务的重启操作".into());
            }
            services.insert(info.id, service.clone());
        }
        let _operation = Operation(&service.busy);
        service.launch().await
    }

    fn get(&self, id: &str, project: &Path) -> Result<Arc<Service>, String> {
        let project = project.canonicalize().map_err(|e| e.to_string())?;
        let service = self
            .services
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("服务不存在")?;
        if Path::new(&service.info.lock().unwrap().project_path) != project {
            return Err("服务不属于当前项目".into());
        }
        Ok(service)
    }

    pub async fn list(&self, project: &Path) -> Result<Vec<ServiceInfo>, String> {
        let project = project.canonicalize().map_err(|e| e.to_string())?;
        let mut result: Vec<_> = self
            .services
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| {
                let info = s.info.lock().unwrap();
                (Path::new(&info.project_path) == project).then(|| info.clone())
            })
            .collect();
        futures::future::join_all(result.iter_mut().map(|info| async move {
            if let Some(port) = info.port.filter(|_| info.status == "running") {
                info.listening = tokio::time::timeout(
                    std::time::Duration::from_millis(150),
                    tokio::net::TcpStream::connect(("localhost", port)),
                )
                .await
                .is_ok_and(|r| r.is_ok());
            }
        }))
        .await;
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    }

    pub async fn action(&self, project: &Path, id: &str, action: &str) -> Result<(), String> {
        let service = self.get(id, project)?;
        let _operation = service.operation()?;
        match action {
            "stop" => service.stop().await,
            "restart" => {
                service.stop().await?;
                if self.shutting_down.load(Ordering::Acquire) {
                    return Err("Nex 正在退出".into());
                }
                service.launch().await.map(|_| ())
            }
            "remove" => {
                if service.info.lock().unwrap().pid.is_some() {
                    return Err("请先停止服务".into());
                }
                self.services.lock().unwrap().remove(id);
                Ok(())
            }
            _ => Err("未知服务操作".into()),
        }
    }

    pub fn logs(&self, project: &Path, id: &str) -> Result<String, String> {
        let service = self.get(id, project)?;
        let bytes: Vec<_> = service.log.lock().unwrap().iter().copied().collect();
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn needs_shutdown(&self) -> bool {
        if self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        self.services.lock().unwrap().values().any(|service| {
            let info = service.info.lock().unwrap();
            info.pid.is_some() || info.status == "starting"
        })
    }

    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let services: Vec<_> = self.services.lock().unwrap().values().cloned().collect();
        futures::future::join_all(services.iter().map(|service| async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while service.busy.load(Ordering::Acquire) {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                let _ = service.stop().await;
            })
            .await;
        }))
        .await;
        self.stop_all();
    }

    pub fn stop_all(&self) {
        self.shutting_down.store(true, Ordering::Release);
        for service in self.services.lock().unwrap().values() {
            if let Some(tx) = service.stop.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(path: &Path) -> ServiceContext {
        ServiceContext {
            project: path.into(),
            conversation_id: "conversation-1".into(),
            env: HashMap::new(),
            sandbox: ShellSandboxMode::ApprovalOnly,
        }
    }
    fn request(command: &str) -> StartService {
        StartService {
            name: "Web".into(),
            command: command.into(),
            cwd: None,
            port: None,
        }
    }
    fn long_command() -> &'static str {
        if cfg!(windows) {
            "echo ready & ping -t 127.0.0.1 >NUL"
        } else {
            "printf 'ready\\n'; while :; do sleep 1; done"
        }
    }
    async fn wait_status(manager: &ServiceManager, root: &Path, expected: &str) -> ServiceInfo {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let info = manager.list(root).await.unwrap().remove(0);
                if info.status == expected {
                    return info;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("service status did not converge")
    }

    #[tokio::test]
    async fn starts_stops_restarts_and_retains_logs_without_an_agent_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ServiceManager::default();
        let service = manager
            .start(context(dir.path()), request(long_command()))
            .await
            .unwrap();
        assert_eq!(service.status, "running");
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !manager
                .logs(dir.path(), &service.id)
                .unwrap()
                .contains("ready")
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        manager
            .action(dir.path(), &service.id, "stop")
            .await
            .unwrap();
        assert_eq!(wait_status(&manager, dir.path(), "stopped").await.pid, None);
        manager
            .action(dir.path(), &service.id, "restart")
            .await
            .unwrap();
        assert_eq!(manager.list(dir.path()).await.unwrap()[0].id, service.id);
        manager
            .action(dir.path(), &service.id, "stop")
            .await
            .unwrap();
        manager
            .action(dir.path(), &service.id, "remove")
            .await
            .unwrap();
        assert!(manager.list(dir.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn records_early_failure_and_its_output() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ServiceManager::default();
        let command = if cfg!(windows) {
            "echo broken & exit 7"
        } else {
            "echo broken; exit 7"
        };
        let service = manager
            .start(context(dir.path()), request(command))
            .await
            .unwrap();
        let info = wait_status(&manager, dir.path(), "failed").await;
        assert_eq!(info.exit_code, Some(7));
        assert!(manager
            .logs(dir.path(), &service.id)
            .unwrap()
            .contains("broken"));
    }

    #[tokio::test]
    async fn rejects_cross_project_operations_and_duplicate_starts() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let manager = ServiceManager::default();
        let service = manager
            .start(context(a.path()), request(long_command()))
            .await
            .unwrap();
        assert!(manager
            .start(context(a.path()), request(long_command()))
            .await
            .is_err());
        assert!(manager.action(b.path(), &service.id, "stop").await.is_err());
        assert!(manager.logs(b.path(), &service.id).is_err());
        assert!(manager
            .action(a.path(), &service.id, "remove")
            .await
            .is_err());
        let mut outside = request("echo should-not-run");
        outside.cwd = Some(b.path().to_string_lossy().into_owned());
        assert!(manager.start(context(a.path()), outside).await.is_err());
        manager.action(a.path(), &service.id, "stop").await.unwrap();
    }

    #[tokio::test]
    async fn probes_localhost_for_ipv4_and_ipv6_services() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ServiceManager::default();
        for address in ["127.0.0.1", "::1"] {
            let Ok(listener) = tokio::net::TcpListener::bind((address, 0)).await else {
                continue;
            };
            let mut spec = request(long_command());
            spec.port = Some(listener.local_addr().unwrap().port());
            let service = manager.start(context(dir.path()), spec).await.unwrap();
            assert!(manager.list(dir.path()).await.unwrap()[0].listening);
            manager
                .action(dir.path(), &service.id, "stop")
                .await
                .unwrap();
            manager
                .action(dir.path(), &service.id, "remove")
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn bounds_output_and_cleans_up_on_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ServiceManager::default();
        let service = manager
            .start(context(dir.path()), request(long_command()))
            .await
            .unwrap();
        let handle = manager.get(&service.id, dir.path()).unwrap();
        drain(&vec![b'a'; LOG_LIMIT * 2][..], handle.clone()).await;
        assert_eq!(handle.log.lock().unwrap().len(), LOG_LIMIT);
        manager.stop_all();
        wait_status(&manager, dir.path(), "stopped").await;
    }
}
