//! Private, session-scoped MCP transport. Tokens never appear in process arguments.
use super::{manager, ServiceContext, StartService};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

const MAX_MESSAGE: u64 = 64 * 1024;
pub const DESCRIPTION: &str = "Manage local development services in Nex. ALWAYS use this tool with action=start for dev servers and long-running local services instead of shell backgrounding/nohup. Nex shows status and logs and lets the user stop/restart services. Use action=list to check current status after user actions. Commands must run in the foreground (no &, nohup or daemon mode). Services survive conversation closure and are stopped when Nex exits.";

pub fn schema() -> Value {
    json!({"type":"object","properties":{
        "action":{"type":"string","enum":["start","list","stop","restart","logs"]},
        "name":{"type":"string","description":"Short service name, required for start"},
        "command":{"type":"string","description":"Foreground server command, required for start; e.g. npm run dev"},
        "cwd":{"type":"string","description":"Optional project-relative working directory"},
        "port":{"type":"integer","minimum":1,"maximum":65535,"description":"Optional local TCP port for reachability and open-in-browser"},
        "id":{"type":"string","description":"Service id, required for stop/restart/logs"}
    },"required":["action"],"additionalProperties":false})
}

pub async fn execute(context: ServiceContext, args: Value) -> Result<Value, String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or("缺少 action")?;
    if action == "list" {
        return serde_json::to_value(manager().list(&context.project).await?)
            .map_err(|e| e.to_string());
    }
    if action == "start" {
        let request: StartService = serde_json::from_value(json!({
            "name": args.get("name"), "command": args.get("command"),
            "cwd": args.get("cwd"), "port": args.get("port"),
        }))
        .map_err(|e| e.to_string())?;
        return serde_json::to_value(manager().start(context, request).await?)
            .map_err(|e| e.to_string());
    }
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or("缺少服务 id")?;
    match action {
        "logs" => Ok(json!({"output":manager().logs(&context.project, id)?})),
        "stop" | "restart" => {
            manager().action(&context.project, id, action).await?;
            Ok(json!({"services":manager().list(&context.project).await?}))
        }
        _ => Err("未知服务操作".into()),
    }
}

pub struct Scope(CancellationToken);
impl Drop for Scope {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub async fn server(context: ServiceContext) -> Result<(Value, Scope), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let secret = uuid::Uuid::new_v4().to_string();
    let config = json!({"name":"nex-local-services","command":executable,"args":["--service-mcp",address.to_string()],
        "env":[{"name":"NEX_SERVICE_MCP_TOKEN","value":secret}]});
    let cancellation = CancellationToken::new();
    let token = cancellation.clone();
    tauri::async_runtime::spawn(async move {
        let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            let connection = tokio::select! {
                _ = token.cancelled() => break,
                result = listener.accept() => match result { Ok((stream, _)) => stream, Err(_) => break },
            };
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let context = context.clone();
            let secret = secret.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ = connection_loop(connection, context, &secret, token).await;
            });
        }
    });
    Ok((config, Scope(cancellation)))
}

async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>, String> {
    use tokio::io::AsyncReadExt;
    let mut line = Vec::new();
    let n = reader
        .take(MAX_MESSAGE + 1)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    if n as u64 > MAX_MESSAGE || !line.ends_with(b"\n") {
        return Err("MCP message too large or incomplete".into());
    }
    Ok(Some(line))
}

async fn connection_loop(
    stream: tokio::net::TcpStream,
    context: ServiceContext,
    secret: &str,
    token: CancellationToken,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let auth = tokio::time::timeout(std::time::Duration::from_secs(5), read_line(&mut reader))
        .await
        .map_err(|e| e.to_string())??;
    if auth.as_deref() != Some(format!("{secret}\n").as_bytes()) {
        return Err("unauthorized".into());
    }
    loop {
        let line = tokio::select! { _ = token.cancelled() => break, result = read_line(&mut reader) => result? };
        let Some(line) = line else {
            break;
        };
        let request: Value = serde_json::from_slice(&line).map_err(|e| e.to_string())?;
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                json!({"protocolVersion":request.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2024-11-05"),
                "capabilities":{"tools":{}},"serverInfo":{"name":"nex-local-services","version":env!("CARGO_PKG_VERSION")},"instructions":DESCRIPTION})
            }
            Some("ping") => json!({}),
            Some("tools/list") => {
                json!({"tools":[{"name":"local_service","description":DESCRIPTION,"inputSchema":schema()}]})
            }
            Some("tools/call")
                if request.pointer("/params/name").and_then(Value::as_str)
                    == Some("local_service") =>
            {
                let args = request
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                let result = execute(context.clone(), args).await;
                match result {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                    Err(error) => json!({"isError":true,"content":[{"type":"text","text":error}]}),
                }
            }
            _ => {
                writer.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})).as_bytes()).await.map_err(|e| e.to_string())?;
                continue;
            }
        };
        writer
            .write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":id,"result":result})).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Entry point for the app binary used as an MCP stdio sidecar.
pub fn bridge(address: &str) -> Result<(), String> {
    let address: std::net::SocketAddr = address.parse().map_err(|_| "invalid MCP address")?;
    if !address.ip().is_loopback() {
        return Err("MCP address must be loopback".into());
    }
    let token = std::env::var("NEX_SERVICE_MCP_TOKEN").map_err(|_| "missing MCP token")?;
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?.block_on(async {
        let mut stream = tokio::net::TcpStream::connect(address).await.map_err(|e| e.to_string())?;
        stream.write_all(format!("{token}\n").as_bytes()).await.map_err(|e| e.to_string())?;
        let (mut reader, mut writer) = stream.into_split();
        let mut stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        tokio::select! {
            result = tokio::io::copy(&mut stdin, &mut writer) => result.map(|_| ()).map_err(|e| e.to_string()),
            result = tokio::io::copy(&mut reader, &mut stdout) => result.map(|_| ()).map_err(|e| e.to_string()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::native::config::ShellSandboxMode;

    #[tokio::test]
    async fn authenticates_scopes_and_exposes_service_tools_over_mcp() {
        let root = tempfile::tempdir().unwrap();
        let context = ServiceContext {
            project: root.path().into(),
            conversation_id: "test".into(),
            env: Default::default(),
            sandbox: ShellSandboxMode::ApprovalOnly,
        };
        let (config, scope) = server(context).await.unwrap();
        let address = config["args"][1].as_str().unwrap();
        let secret = config["env"][0]["value"].as_str().unwrap();
        assert!(!config["args"].to_string().contains(secret));
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);
        writer
            .write_all(format!("{secret}\n").as_bytes())
            .await
            .unwrap();
        writer
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n")
            .await
            .unwrap();
        let reply = read_line(&mut reader).await.unwrap().unwrap();
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply["result"]["tools"][0]["name"], "local_service");
        writer.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"local_service\",\"arguments\":{\"action\":\"start\",\"name\":\"MCP service\",\"command\":\"echo mcp-ready\"}}}\n").await.unwrap();
        let reply = read_line(&mut reader).await.unwrap().unwrap();
        let reply: Value = serde_json::from_slice(&reply).unwrap();
        assert!(reply["result"]["isError"].is_null());
        let service: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        let service_id = service["id"].as_str().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !manager()
                .logs(root.path(), service_id)
                .unwrap()
                .contains("mcp-ready")
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        drop(scope);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(2), read_line(&mut reader))
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        manager()
            .action(root.path(), service_id, "stop")
            .await
            .unwrap();
        manager()
            .action(root.path(), service_id, "remove")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn refuses_wrong_tokens_and_oversized_messages() {
        let root = tempfile::tempdir().unwrap();
        let (config, _scope) = server(ServiceContext {
            project: root.path().into(),
            conversation_id: "test".into(),
            env: Default::default(),
            sandbox: ShellSandboxMode::ApprovalOnly,
        })
        .await
        .unwrap();
        let mut stream = tokio::net::TcpStream::connect(config["args"][1].as_str().unwrap())
            .await
            .unwrap();
        stream.write_all(b"wrong-token\n").await.unwrap();
        assert!(read_line(&mut BufReader::new(stream))
            .await
            .unwrap()
            .is_none());
        let message = vec![b'x'; MAX_MESSAGE as usize + 2];
        assert!(read_line(&mut BufReader::new(message.as_slice()))
            .await
            .is_err());
    }
}
