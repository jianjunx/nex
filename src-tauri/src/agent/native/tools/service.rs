use super::{Tool, ToolCtx};
use crate::services::{mcp, ServiceContext};

pub struct LocalService;
#[async_trait::async_trait(?Send)]
impl Tool for LocalService {
    fn name(&self) -> &'static str {
        "local_service"
    }
    fn description(&self) -> &'static str {
        mcp::DESCRIPTION
    }
    fn schema(&self) -> serde_json::Value {
        mcp::schema()
    }
    fn kind(&self) -> agent_client_protocol::ToolKind {
        agent_client_protocol::ToolKind::Execute
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        env.insert("PATH".into(), ctx.path_env.to_string_lossy().into_owned());
        #[cfg(windows)]
        env.insert("Path".into(), ctx.path_env.to_string_lossy().into_owned());
        let context = ServiceContext {
            project: ctx.cwd.clone(),
            conversation_id: ctx.session_id.clone().unwrap_or_default(),
            env,
            sandbox: ctx.shell_sandbox,
        };
        mcp::execute(context, args)
            .await
            .map(|value| value.to_string())
    }
}
