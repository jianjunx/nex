// src-tauri/tests/fs_test.rs
use nex_lib::fs::tree::read_tree;
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
