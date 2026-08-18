//! `code_graph` — structural code index (definitions, callers, impact).

use super::{arg_str, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

const MAX_OUTPUT_CHARS: usize = 20_000;

pub struct CodeGraph;

#[async_trait::async_trait(?Send)]
impl Tool for CodeGraph {
    fn name(&self) -> &'static str {
        "code_graph"
    }
    fn description(&self) -> &'static str {
        "Query the workspace code graph (definitions, callers, imports, \
         architecture, change impact). Prefer this over grep for structural \
         questions. Actions: `overview` (index snapshot), `search` (find \
         symbols by name; set `query`), `query` (set `pattern` + `target`: \
         callers_of, callees_of, imports_of, importers_of, tests_for, \
         children_of, file_summary), `impact` (blast radius of `files` or \
         git diff vs `base`, default HEAD~1). Returns `kind name path:line`."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["overview", "search", "query", "impact"],
                    "description": "Which graph operation to run."
                },
                "query": {
                    "type": "string",
                    "description": "Search string (action=search)."
                },
                "kind": {
                    "type": "string",
                    "enum": ["File", "Class", "Function", "Type", "Test"],
                    "description": "Optional node kind filter for search."
                },
                "pattern": {
                    "type": "string",
                    "enum": [
                        "callers_of",
                        "callees_of",
                        "imports_of",
                        "importers_of",
                        "tests_for",
                        "children_of",
                        "file_summary"
                    ],
                    "description": "Structural query (action=query)."
                },
                "target": {
                    "type": "string",
                    "description": "Symbol name, qualified name, or path (action=query)."
                },
                "files": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Changed files (action=impact). Omit to use git diff vs base."
                },
                "base": {
                    "type": "string",
                    "description": "Git ref for impact when `files` is omitted. Default HEAD~1."
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results. Default 20, cap 50."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Search
    }
    fn read_only(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let _ = arg_str(&args, "action")?;
        let cwd = ctx.cwd.clone();
        let handle = ctx.graph.clone().unwrap_or_default();
        let out = tokio::task::spawn_blocking(move || handle.query(&cwd, &args))
            .await
            .map_err(|e| format!("code_graph join: {e}"))??;
        Ok(truncate_output(out, MAX_OUTPUT_CHARS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::index;

    fn ctx(dir: &std::path::Path) -> ToolCtx {
        ToolCtx::for_tests(dir.to_path_buf())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn four_actions_on_fixture() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::write(
            cwd.join("src/lib.rs"),
            "pub fn target() {}\npub fn caller() { target(); }\n",
        )
        .unwrap();
        std::fs::write(
            cwd.join("src/other.ts"),
            "import { target } from './lib';\nexport function use() { target(); }\n",
        )
        .unwrap();
        index::build_project(cwd).unwrap();

        let c = ctx(cwd);
        let overview = CodeGraph
            .execute(serde_json::json!({"action": "overview"}), &c)
            .await
            .unwrap();
        assert!(overview.contains("files="), "{overview}");

        let search = CodeGraph
            .execute(
                serde_json::json!({"action": "search", "query": "caller"}),
                &c,
            )
            .await
            .unwrap();
        assert!(search.contains("caller"), "{search}");

        let callers = CodeGraph
            .execute(
                serde_json::json!({
                    "action": "query",
                    "pattern": "callers_of",
                    "target": "target"
                }),
                &c,
            )
            .await
            .unwrap();
        assert!(callers.contains("caller"), "{callers}");

        let impact = CodeGraph
            .execute(
                serde_json::json!({
                    "action": "impact",
                    "files": ["src/lib.rs"]
                }),
                &c,
            )
            .await
            .unwrap();
        assert!(impact.contains("src/lib.rs"), "{impact}");
        assert!(impact.contains("target") || impact.contains("caller"), "{impact}");
    }
}
