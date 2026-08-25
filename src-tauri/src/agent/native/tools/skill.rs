//! The read-only `load_skill` tool: pulls a skill's full `SKILL.md` body (or
//! one of its supporting files) into the conversation on demand. This is the
//! "progressive disclosure" half of skills — the catalog in the system prompt
//! only carries names + descriptions.

use super::{arg_str, arg_str_opt, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;

/// Cap on total output characters.
const MAX_OUTPUT_CHARS: usize = 30_000;

pub struct LoadSkill;

#[async_trait::async_trait(?Send)]
impl Tool for LoadSkill {
    fn name(&self) -> &'static str {
        "load_skill"
    }
    fn description(&self) -> &'static str {
        "Load a skill's full instructions (from the skills catalog in your system prompt), \
         or one supporting file of a skill. Call it when the current task matches a skill, \
         then follow the loaded instructions."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "skill": { "type": "string", "description": "Skill name from the catalog." },
                "file": { "type": "string", "description": "Optional supporting file path relative to the skill directory (e.g. `references/api.md`). Omit to load the full SKILL.md instructions." }
            },
            "required": ["skill"],
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
        let skill = arg_str(&args, "skill")?;
        let file = arg_str_opt(&args, "file");
        let global = crate::agent::native::home::skills_dir();
        let content = match file {
            Some(rel) => crate::agent::native::skills::load_file_for_cwd(
                Some(&ctx.cwd),
                global.as_deref(),
                &skill,
                &rel,
            )?,
            None => crate::agent::native::skills::load_body_for_cwd(
                Some(&ctx.cwd),
                global.as_deref(),
                &skill,
            )?,
        };
        Ok(truncate_output(content, MAX_OUTPUT_CHARS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn make_ctx(cwd: &Path) -> ToolCtx {
        ToolCtx {
            cwd: cwd.to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: cwd.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                super::super::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
            graph: None,
        }
    }

    /// The tool is a thin shell over `skills::load_body`/`load_file` (which
    /// have their own thorough tests against temp roots); here we pin the
    /// argument handling and error surfacing against the real `~/.nex` root
    /// semantics without touching the user's actual skills.
    #[tokio::test(flavor = "current_thread")]
    async fn missing_skill_arg_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = make_ctx(tmp.path());
        let err = LoadSkill
            .execute(serde_json::json!({}), &ctx)
            .await
            .expect_err("missing skill arg must fail");
        assert!(err.contains("`skill`"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_skill_errors_clearly() {
        // Only meaningful when a home dir exists; an unknown name must produce
        // a readable error rather than a panic either way.
        let tmp = tempfile::tempdir().unwrap();
        let ctx = make_ctx(tmp.path());
        let result = LoadSkill
            .execute(
                serde_json::json!({ "skill": "definitely-not-a-real-skill-xyz" }),
                &ctx,
            )
            .await;
        match result {
            Err(e) => assert!(
                e.contains("not found") || e.contains("unavailable"),
                "unexpected error: {e}"
            ),
            Ok(_) => panic!("unknown skill must not load"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn loads_project_skill_from_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".nex/skills/demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: d\n---\nPROJECT SKILL BODY",
        )
        .unwrap();
        std::fs::write(skill_dir.join("ref.txt"), "project-ref").unwrap();
        let ctx = make_ctx(tmp.path());

        let body = LoadSkill
            .execute(serde_json::json!({ "skill": "demo" }), &ctx)
            .await
            .expect("project skill must load");
        assert!(body.contains("PROJECT SKILL BODY"));

        let file = LoadSkill
            .execute(
                serde_json::json!({ "skill": "demo", "file": "ref.txt" }),
                &ctx,
            )
            .await
            .expect("project supporting file must load");
        assert_eq!(file, "project-ref");
    }

    #[test]
    fn tool_metadata_is_read_only_search() {
        assert_eq!(LoadSkill.name(), "load_skill");
        assert!(LoadSkill.read_only());
        assert!(matches!(LoadSkill.kind(), acp::ToolKind::Search));
        let schema = LoadSkill.schema();
        assert_eq!(schema["required"][0], "skill");
    }
}
