use serde::Serialize;
use std::path::Path;
use crate::error::NexError;

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub is_text: bool,
    pub content: Option<String>,
    pub size: u64,
}

const MAX_TEXT_SIZE: u64 = 1_000_000; // 1MB

pub fn read_file(path: &Path) -> Result<FileContent, NexError> {
    let metadata = std::fs::metadata(path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    let size = metadata.len();

    if size > MAX_TEXT_SIZE {
        return Ok(FileContent { is_text: false, content: None, size });
    }

    let bytes = std::fs::read(path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    // content_inspector 0.2 has no TEXT variant; UTF-8 (with/without BOM) is what
    // from_utf8_lossy can decode into a previewable string.
    let is_text = matches!(
        content_inspector::inspect(&bytes),
        content_inspector::ContentType::UTF_8 | content_inspector::ContentType::UTF_8_BOM
    );

    let content = if is_text {
        Some(String::from_utf8_lossy(&bytes).to_string())
    } else {
        None
    };

    Ok(FileContent { is_text, content, size })
}
