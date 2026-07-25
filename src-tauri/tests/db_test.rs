// src-tauri/tests/db_test.rs
use nex_lib::db::Database;
use tempfile::tempdir;

#[test]
fn test_create_and_list_projects() {
    let dir = tempdir().unwrap();
    let db = Database::new(&dir.path().join("test.db")).unwrap();
    let p = db.create_project("Test", "/tmp/test").unwrap();
    assert_eq!(p.name, "Test");
    let list = db.list_projects().unwrap();
    assert_eq!(list.len(), 1);
}

#[test]
fn test_conversation_and_messages() {
    let dir = tempdir().unwrap();
    let db = Database::new(&dir.path().join("test.db")).unwrap();
    let p = db.create_project("Test", "/tmp/test").unwrap();
    let c = db.create_conversation(&p.id, "claude-code").unwrap();
    let m = db.append_message(&c.id, "user", "hello", None).unwrap();
    assert_eq!(m.sequence, 1);
    assert_eq!(m.role, "user");
    assert_eq!(m.content, "hello");
    let msgs = db.get_messages(&c.id, 10, 0).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].sequence, 1);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].content, "hello");
}
