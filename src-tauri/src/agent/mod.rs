//! Method-agnostic agent integration.
//!
//! Nex reuses the **open Agent Client Protocol registry** (the same public
//! endpoint Zed consumes) to discover agents and their launch commands, rather
//! than hardcoding them. See `registry` (discovery), `launch` (command
//! resolution + spawn), `acp_adapter` (the v1 ACP-over-stdio transport), and
//! `server` (the facade the Tauri commands call).

pub mod acp_adapter;
pub mod binary;
pub mod launch;
pub mod native;
pub mod node_runtime;
pub mod package_cache;
pub mod project_env;
pub mod registry;
pub mod server;
pub mod shell_env;
pub mod types;

pub use server::{AgentSessionManager, CustomServer, ServerDescriptor, ServerKind, SessionTarget};
pub use native::config::NativeAgentConfig;
pub use types::{CreateSessionResult, PromptBlock};
