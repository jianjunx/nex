use crate::error::NexError;
use crate::fs::validate_entry_name;
use std::fs;
use std::path::{Path, PathBuf};

/// Move a file or directory to the OS trash / recycle bin.
pub fn delete_entry(path: &Path) -> Result<(), NexError> {
    trash::delete(path)
        .map_err(|e| NexError::FileSystem(format!("删除失败 '{}': {}", path.display(), e)))
}

/// Rename a file or directory in-place (same parent directory).
/// `new_name` is just the new name, not a full path.
pub fn rename_entry(path: &Path, new_name: &str) -> Result<(), NexError> {
    validate_entry_name(new_name)?;
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
    fs::rename(path, &new_path).map_err(|e| NexError::FileSystem(format!("重命名失败: {}", e)))
}

/// True when `path` is `ancestor` or lives under it (component-wise).
/// Prefer canonicalized inputs so symlink / `..` aliases are caught.
fn is_same_or_descendant(path: &Path, ancestor: &Path) -> bool {
    path == ancestor || path.starts_with(ancestor)
}

/// Resolve an existing path for containment checks. Falls back to the
/// original path when canonicalize fails (e.g. broken symlink source).
fn try_canonicalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Refuse to copy/move a directory into itself or a descendant — that
/// yields `src/src/src/...` nesting as `read_dir` observes the newly
/// created destination mid-walk.
fn reject_into_self(source: &Path, dest: &Path) -> Result<(), NexError> {
    // Follow symlinks: a dir symlink into its own target tree has the
    // same nesting hazard as a plain directory.
    if !source.is_dir() {
        return Ok(());
    }
    let source_canon = try_canonicalize(source);
    // `dest` usually does not exist yet; resolve via its parent + name.
    let dest_canon = match dest.parent() {
        Some(parent) if parent.exists() => try_canonicalize(parent).join(
            dest.file_name()
                .ok_or_else(|| NexError::FileSystem("无效的目标路径".into()))?,
        ),
        _ => dest.to_path_buf(),
    };
    if is_same_or_descendant(&dest_canon, &source_canon) {
        return Err(NexError::FileSystem(format!(
            "不能将目录复制/移动到自身或其子目录内: {} → {}",
            source.display(),
            dest.display()
        )));
    }
    Ok(())
}

/// Recursively copy a file or directory to a target directory.
/// On name conflict a numeric suffix is appended ("file (1).txt") so an
/// in-place paste never overwrites/truncates the source (OS file-manager
/// semantics). Returns the final destination path.
pub fn copy_entry(source: &Path, target_dir: &Path) -> Result<PathBuf, NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = resolve_unique_path(target_dir, name);
    reject_into_self(source, &dest)?;
    if source.is_dir() {
        copy_dir_recursive(source, &dest)?;
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| NexError::FileSystem(format!("创建目录失败: {}", e)))?;
        }
        fs::copy(source, &dest)
            .map(|_| ())
            .map_err(|e| NexError::FileSystem(format!("复制失败: {}", e)))?
    }
    Ok(dest)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), NexError> {
    if dst.exists() {
        return Err(NexError::FileSystem(format!(
            "目标已存在: {}",
            dst.display()
        )));
    }
    // Snapshot entries *before* creating `dst`. If `dst` somehow lands
    // under `src`, a live `read_dir` would see the new folder and nest
    // forever (`src/src/src/...`).
    let entries: Vec<_> = fs::read_dir(src)
        .map_err(|e| NexError::FileSystem(format!("读取目录失败: {}", e)))?
        .collect();
    fs::create_dir(dst).map_err(|e| NexError::FileSystem(format!("创建目录失败: {}", e)))?;
    for entry in entries {
        let entry = entry.map_err(|e| NexError::FileSystem(format!("读取条目失败: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        // Use the entry's own file type (does NOT follow symlinks): a
        // symlink pointing at an ancestor would otherwise recurse forever
        // and blow the stack. Symlinks are copied as symlinks.
        let file_type = entry
            .file_type()
            .map_err(|e| NexError::FileSystem(format!("读取条目类型失败: {}", e)))?;
        if file_type.is_symlink() {
            copy_symlink(&src_path, &dst_path)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map(|_| ())
                .map_err(|e| NexError::FileSystem(format!("复制文件失败: {}", e)))?;
        }
    }
    Ok(())
}

/// Copies a symlink by recreating it with the same target (never follows it).
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), NexError> {
    let target =
        fs::read_link(src).map_err(|e| NexError::FileSystem(format!("读取符号链接失败: {}", e)))?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, dst)
            .map_err(|e| NexError::FileSystem(format!("复制符号链接失败: {}", e)))
    }
    #[cfg(windows)]
    {
        // Best effort on Windows: symlink creation may require privileges,
        // fall back to copying the referenced file's contents.
        if let Ok(meta) = fs::metadata(src) {
            if meta.is_dir() {
                return std::os::windows::fs::symlink_dir(&target, dst)
                    .map_err(|e| NexError::FileSystem(format!("复制目录符号链接失败: {}", e)));
            }
        }
        std::os::windows::fs::symlink_file(&target, dst)
            .or_else(|_| fs::copy(src, dst).map(|_| ()))
            .map_err(|e| NexError::FileSystem(format!("复制符号链接失败: {}", e)))
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| NexError::FileSystem(format!("复制符号链接失败: {}", e)))
    }
}

/// Resolve a paste destination: if `dest_name` is provided, use it as the
/// target name in the destination directory; otherwise keep the source's name.
/// Returns the full destination path.
pub fn resolve_paste_path(source: &Path, dest_dir: &Path, dest_name: Option<&str>) -> PathBuf {
    if let Some(name) = dest_name {
        // Defense in depth: an invalid name falls back to the source name
        // instead of escaping dest_dir.
        if validate_entry_name(name).is_ok() {
            return dest_dir.join(name);
        }
    }
    let name = source
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("untitled"));
    dest_dir.join(name)
}

/// Move an entry to a destination directory, keeping its original name.
/// Falls back to copy+delete when source and target live on different
/// filesystems (`fs::rename` fails with CrossesDevices there).
pub fn move_entry(source: &Path, target_dir: &Path) -> Result<(), NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = target_dir.join(name);
    reject_into_self(source, &dest)?;
    if dest.exists() {
        return Err(NexError::FileSystem(format!(
            "目标已存在: {}",
            dest.display()
        )));
    }
    match fs::rename(source, &dest) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(EXDEV) => {
            move_cross_device(source, &dest)?;
            Ok(())
        }
        Err(e) => Err(NexError::FileSystem(format!("移动失败: {}", e))),
    }
}

/// EXDEV (cross-device link) is errno 18 on all unix platforms we target,
/// and Windows maps ERROR_NOT_SAME_DEVICE to the same errno value.
const EXDEV: i32 = 18;

fn move_cross_device(source: &Path, dest: &Path) -> Result<(), NexError> {
    let meta = fs::symlink_metadata(source)
        .map_err(|e| NexError::FileSystem(format!("读取源失败: {}", e)))?;
    if meta.is_dir() {
        copy_dir_recursive(source, dest)?;
        fs::remove_dir_all(source)
            .map_err(|e| NexError::FileSystem(format!("跨盘移动后删除源目录失败: {}", e)))?;
    } else {
        fs::copy(source, dest).map_err(|e| NexError::FileSystem(format!("跨盘复制失败: {}", e)))?;
        fs::remove_file(source)
            .map_err(|e| NexError::FileSystem(format!("跨盘移动后删除源文件失败: {}", e)))?;
    }
    Ok(())
}

/// Copy an external file/dir into target_dir, handling name conflicts by
/// appending a numeric suffix: "file (1).txt", "file (2).txt", …
/// Returns the final destination path.
pub fn import_file(source: &Path, target_dir: &Path) -> Result<PathBuf, NexError> {
    let name = source
        .file_name()
        .ok_or_else(|| NexError::FileSystem("无效的源路径".into()))?;
    let dest = resolve_unique_path(target_dir, name);
    reject_into_self(source, &dest)?;
    if source.is_dir() {
        copy_dir_recursive(source, &dest)?;
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| NexError::FileSystem(format!("创建目录失败: {}", e)))?;
        }
        fs::copy(source, &dest)
            .map_err(|e| NexError::FileSystem(format!("复制文件失败: {}", e)))?;
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
            return dir.join(format!(
                "{stem_no_ext}_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            ));
        }
    }
}
