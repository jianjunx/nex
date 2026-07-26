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
pub mod registry;
pub mod server;
pub mod types;

pub use server::{AgentSessionManager, CustomServer, ServerDescriptor, ServerKind, SessionTarget};
