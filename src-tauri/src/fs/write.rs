use crate::error::NexError;
use std::path::Path;

/// Writes `content` to `path` atomically: the bytes go to a temporary file
/// in the SAME directory first, then `rename` replaces the target, so a
/// crash or power loss mid-save can never leave the user's file partially
/// written (rename within a directory is atomic on every platform Nex
/// supports). The UTF-8 `String` payload round-trips cleanly with
/// `read_file`, which only ever returns UTF-8 text.
pub fn write_file(path: &Path, content: &str) -> Result<(), NexError> {
    let dir = path
        .parent()
        .ok_or_else(|| NexError::FileSystem("invalid path: no parent directory".into()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| NexError::FileSystem("invalid path: no file name".into()))?;
    let tmp = dir.join(format!(".{file_name}.nex-tmp"));

    std::fs::write(&tmp, content).map_err(|e| NexError::FileSystem(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        // Never leave a stray temp file behind on rename failure.
        let _ = std::fs::remove_file(&tmp);
        NexError::FileSystem(e.to_string())
    })?;
    Ok(())
}
