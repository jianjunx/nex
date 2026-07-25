// src-tauri/tests/fs_test.rs
use nex_lib::fs::tree::read_tree;
use nex_lib::fs::write::write_file;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_read_tree_respects_structure() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(dir.path().join("README.md"), "# Test").unwrap();

    let nodes = read_tree(dir.path(), 2).unwrap();
    assert!(nodes.len() >= 3); // src/, src/main.rs, README.md
    assert!(nodes.iter().any(|n| n.name == "src" && n.is_dir));
}

#[test]
fn test_write_file_atomic_round_trip() {
    let dir = tempdir().unwrap();
    let file_name = format!("nex-write-test-{}.txt", std::process::id());
    let path = dir.path().join(&file_name);
    let content = "你好\nworld\n";

    write_file(&path, content).unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    // The same-directory temp file must not linger after the rename.
    let tmp = dir.path().join(format!(".{file_name}.nex-tmp"));
    assert!(!tmp.exists());
    fs::remove_file(&path).unwrap();
}
