use crate::error::NexError;
use std::path::Path;

pub fn create_file(parent_dir: &Path, name: &str) -> Result<(), NexError> {
    let path = parent_dir.join(name);
    if path.exists() {
        return Err(NexError::FileSystem(format!("文件已存在: {name}")));
    }
    std::fs::File::create(&path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    Ok(())
}

pub fn create_dir(parent_dir: &Path, name: &str) -> Result<(), NexError> {
    let path = parent_dir.join(name);
    if path.exists() {
        return Err(NexError::FileSystem(format!("目录已存在: {name}")));
    }
    std::fs::create_dir(&path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    Ok(())
}
