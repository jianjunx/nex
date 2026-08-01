use crate::error::NexError;
use std::fs;
use std::path::{Path, PathBuf};

/// Move a file or directory to the OS trash / recycle bin.
pub fn delete_entry(path: &Path) -> Result<(), NexError> {
    trash::delete(path).map_err(|e| {
        NexError::FileSystem(format!("删除失败 '{}': {}", path.display(), e))
    })
}

/// Rename a file or directory in-place (same parent directory).
/// `new_name` is just the new name, not a full path.
pub fn rename_entry(path: &Path, new_name: &str) -> Result<(), NexError> {
    let parent = path
        .parent()
        .ok_or_else(|| NexError::FileSystem("无法获取父目录".into()))?;
    let new_path = parent.join(new_name);
    if new_path.exists() {
        return Err(NexError::FileSystem(format!(
            "目标已存在: {}",
            new_path.display()
        )));
    }
    fs::rename(path, &new_path)
        .map_err(|e| NexError::FileSystem(format!("重命名失败: {}", e)))
}

/// Recursively copy a file or directory to a target directory.
/// The target directory must exist. The entry keeps its original name.
pub fn copy_entry(source: &Path, target_dir: &Path) -> Result<(), NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = target_dir.join(name);
    if source.is_dir() {
        copy_dir_recursive(source, &dest)
    } else {
        fs::copy(source, &dest).map(|_| ()).map_err(|e| {
            NexError::FileSystem(format!("复制失败: {}", e))
        })
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), NexError> {
    if dst.exists() {
        return Err(NexError::FileSystem(format!(
            "目标已存在: {}",
            dst.display()
        )));
    }
    fs::create_dir(dst).map_err(|e| {
        NexError::FileSystem(format!("创建目录失败: {}", e))
    })?;
    for entry in
        fs::read_dir(src).map_err(|e| NexError::FileSystem(format!("读取目录失败: {}", e)))?
    {
        let entry = entry.map_err(|e| NexError::FileSystem(format!("读取条目失败: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map(|_| ()).map_err(|e| {
                NexError::FileSystem(format!("复制文件失败: {}", e))
            })?;
        }
    }
    Ok(())
}

/// Resolve a paste destination: if `dest_name` is provided, use it as the
/// target name in the destination directory; otherwise keep the source's name.
/// Returns the full destination path.
pub fn resolve_paste_path(source: &Path, dest_dir: &Path, dest_name: Option<&str>) -> PathBuf {
    if let Some(name) = dest_name {
        dest_dir.join(name)
    } else {
        let name = source
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("untitled"));
        dest_dir.join(name)
    }
}

/// Move an entry to a destination directory, keeping its original name.
pub fn move_entry(source: &Path, target_dir: &Path) -> Result<(), NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = target_dir.join(name);
    if dest.exists() {
        return Err(NexError::FileSystem(format!(
            "目标已存在: {}",
            dest.display()
        )));
    }
    fs::rename(source, &dest)
        .map_err(|e| NexError::FileSystem(format!("移动失败: {}", e)))
}

/// Copy an external file/dir into target_dir, handling name conflicts by
/// appending a numeric suffix: "file (1).txt", "file (2).txt", …
/// Returns the final destination path.
pub fn import_file(source: &Path, target_dir: &Path) -> Result<PathBuf, NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = resolve_unique_path(target_dir, name);
    if source.is_dir() {
        copy_dir_recursive(source, &dest)?;
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| NexError::FileSystem(format!("创建目录失败: {}", e)))?;
        }
        fs::copy(source, &dest).map_err(|e| {
            NexError::FileSystem(format!("复制文件失败: {}", e))
        })?;
    }
    Ok(dest)
}

/// Build a unique destination path: if `base` already exists, append
/// " (1)", " (2)", … before the extension until a free name is found.
fn resolve_unique_path(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let stem = name.to_string_lossy();
    let (stem_no_ext, ext) = match stem.rfind('.') {
        Some(dot) if dot > 0 => (&stem[..dot], stem[dot..].to_string()),
        _ => (stem.as_ref(), String::new()),
    };
    let mut counter = 1u32;
    loop {
        let candidate_name = format!("{stem_no_ext} ({counter}){ext}");
        let candidate = dir.join(&candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
        // Safety valve: 999 tries
        if counter > 999 {
            // Fallback with timestamp
            return dir.join(format!("{stem_no_ext}_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()));
        }
    }
}
