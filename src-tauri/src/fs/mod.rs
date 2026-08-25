pub mod create;
pub mod operations;
pub mod read;
pub mod search;
pub mod tree;
pub mod write;

use crate::error::NexError;

/// Validates a single file/directory name supplied by the frontend.
/// Rejects empty names, `.`/`..`, and anything containing path separators,
/// so a hostile or buggy name can never escape the parent directory
/// (path traversal / absolute-path injection).
pub fn validate_entry_name(name: &str) -> Result<(), NexError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|c| c.is_control())
    {
        return Err(NexError::FileSystem(format!("非法的文件/目录名: {name:?}")));
    }
    // Windows-reserved device names are also rejected so the same code
    // path is safe cross-platform.
    let upper = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&upper.as_str()) {
        return Err(NexError::FileSystem(format!(
            "非法的文件/目录名（保留设备名）: {name:?}"
        )));
    }
    Ok(())
}
