//! Optional `<cwd>/.nex/graph.toml`. Missing/invalid files mean defaults.

use std::path::Path;

use serde::Deserialize;

use super::paths;

/// Per-project graph indexer settings. All fields optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct GraphConfig {
    /// Language ids to skip (`rust`, `typescript`, `tsx`, `javascript`,
    /// `python`, `go`, `java`). Unlisted languages stay enabled.
    pub disabled_languages: Vec<String>,
    /// Extra directory prefixes to skip, relative to the workspace
    /// (`vendor/`, `third_party/`).
    pub extra_exclude: Vec<String>,
}

impl GraphConfig {
    pub fn load(cwd: &Path) -> Self {
        let path = paths::config_path(cwd);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        toml::from_str(&raw).unwrap_or_else(|e| {
            log::warn!("ignoring invalid {}: {e}", path.display());
            Self::default()
        })
    }

    pub fn language_enabled(&self, lang: &str) -> bool {
        !self
            .disabled_languages
            .iter()
            .any(|d| d.eq_ignore_ascii_case(lang))
    }

    /// True when `rel` (workspace-relative, `/` separators) should be skipped.
    pub fn is_excluded(&self, rel: &str) -> bool {
        self.extra_exclude.iter().any(|prefix| {
            let p = prefix.trim_start_matches("./").trim_end_matches('/');
            if p.is_empty() {
                return false;
            }
            rel == p || rel.starts_with(&format!("{p}/"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_default() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = GraphConfig::load(tmp.path());
        assert!(cfg.disabled_languages.is_empty());
        assert!(cfg.language_enabled("rust"));
    }

    #[test]
    fn parses_excludes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".nex")).unwrap();
        std::fs::write(
            tmp.path().join(".nex/graph.toml"),
            "disabled_languages = [\"java\"]\nextra_exclude = [\"vendor/\"]\n",
        )
        .unwrap();
        let cfg = GraphConfig::load(tmp.path());
        assert!(!cfg.language_enabled("java"));
        assert!(cfg.language_enabled("rust"));
        assert!(cfg.is_excluded("vendor/foo.rs"));
        assert!(!cfg.is_excluded("src/foo.rs"));
    }
}
