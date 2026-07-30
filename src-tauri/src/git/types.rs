use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitFileChange {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "untracked"
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
}
