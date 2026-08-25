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
fn test_read_tree_paths_are_unique() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join(".gitignore"), "target\n").unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/.gitignore"), "*.o\n").unwrap();
    fs::write(dir.path().join("src/App.tsx"), "export {}\n").unwrap();

    let nodes = read_tree(dir.path(), 2).unwrap();
    let mut paths = nodes.iter().map(|n| n.path.as_str()).collect::<Vec<_>>();
    paths.sort();
    let mut deduped = paths.clone();
    deduped.dedup();
    assert_eq!(
        paths, deduped,
        "file tree must not emit duplicate paths: {paths:?}"
    );
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

// ---- Plan 5: search options -----------------------------------------
use nex_lib::fs::search::{search, SearchOptions};

fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> SearchOptions {
    SearchOptions {
        case_sensitive,
        whole_word,
        regex,
    }
}

fn search_fixture(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(
        dir.join("src/app.ts"),
        "const Foo = 1;\nlet foo = 2;\nlet food = 3;\n",
    )
    .unwrap();
    fs::write(dir.join("notes.txt"), "foo cat concat\nFoo Cat\n").unwrap();
    fs::write(dir.join("foo.md"), "readme\n").unwrap();
}

#[test]
fn test_search_default_is_case_insensitive_substring() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "foo", None).unwrap();
    // foo.md 名称命中（line=None）；app.ts 3 行内容命中；notes.txt 2 行。
    assert!(results
        .iter()
        .any(|m| m.name == "foo.md" && m.line.is_none()));
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    assert_eq!(content_hits.len(), 5);
}

#[test]
fn test_search_case_sensitive() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "Foo", Some(opts(true, false, false))).unwrap();
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    // app.ts "const Foo = 1;" + notes.txt "Foo Cat"
    assert_eq!(content_hits.len(), 2);
    // 小写文件名 foo.md 不得命中大小写敏感的 "Foo"
    assert!(!results.iter().any(|m| m.name == "foo.md"));
}

#[test]
fn test_search_whole_word_excludes_substrings() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let results = search(dir.path(), "cat", Some(opts(false, true, false))).unwrap();
    let texts: Vec<_> = results
        .iter()
        .filter_map(|m| m.line.map(|_| m.text.clone()))
        .collect();
    // "foo cat concat"（独立词 cat）与 "Foo Cat"（大小写不敏感）；concat 内的 cat 不算
    assert_eq!(texts.len(), 2);
    assert!(texts.iter().all(|t| t.to_lowercase().contains(" cat")));
}

#[test]
fn test_search_regex_mode() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    // 大小写敏感正则：仅 "const Foo = 1;"（"let foo = 2;" 小写不中，"food" 其后非空白不中）
    let results = search(dir.path(), r"Foo\s*=\s*\d", Some(opts(true, false, true))).unwrap();
    let texts: Vec<_> = results
        .iter()
        .filter_map(|m| m.line.map(|_| m.text.clone()))
        .collect();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("const Foo = 1;"));
}

#[test]
fn test_search_options_combine() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    // 大小写敏感 + 全词 "Foo"：仅 "const Foo = 1;" 与 "Foo Cat"
    let results = search(dir.path(), "Foo", Some(opts(true, true, false))).unwrap();
    let content_hits: Vec<_> = results.iter().filter(|m| m.line.is_some()).collect();
    assert_eq!(content_hits.len(), 2);
}

#[test]
fn test_search_fuzzy_filename_matches_abbreviation() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("components.json"), "{}\n").unwrap();
    fs::write(dir.path().join("compose.js"), "console.log('x');\n").unwrap();

    let results = search(dir.path(), "cmpjs", None).unwrap();
    assert!(results
        .iter()
        .any(|m| m.name == "components.json" && m.line.is_none()));
}

#[test]
fn test_search_filename_hits_rank_before_content_hits() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("components.json"), "{}\n").unwrap();
    fs::write(dir.path().join("notes.txt"), "cmpjs appears in content\n").unwrap();

    let results = search(dir.path(), "cmpjs", None).unwrap();
    assert_eq!(
        results.first().map(|m| (m.name.as_str(), m.line)),
        Some(("components.json", None))
    );
    assert!(results
        .iter()
        .any(|m| m.name == "notes.txt" && m.line == Some(1)));
}

#[test]
fn test_search_prefers_stronger_filename_match_ordering() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("components.json"), "{}\n").unwrap();
    fs::write(dir.path().join("my-components.json.backup"), "{}\n").unwrap();

    let results = search(dir.path(), "components.json", None).unwrap();
    assert_eq!(
        results.first().map(|m| m.name.as_str()),
        Some("components.json")
    );
}

use nex_lib::fs::search::{apply_replace, search_replace};

#[test]
fn test_search_replace_preview_counts_without_writing() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let preview = search_replace(dir.path(), "foo", "bar", None).unwrap();
    // app.ts: Foo/foo/food = 3; notes.txt: foo/Foo = 2; foo.md 名称命中不计
    assert_eq!(preview.total, 5);
    assert!(!preview.truncated);
    assert_eq!(preview.files.len(), 2);
    let app = preview
        .files
        .iter()
        .find(|f| f.path.ends_with("app.ts"))
        .unwrap();
    assert_eq!(app.count, 3);
    // 预览不得写盘
    assert!(fs::read_to_string(dir.path().join("src/app.ts"))
        .unwrap()
        .contains("const Foo = 1;"));
}

#[test]
fn test_apply_replace_writes_all_matches() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let result = apply_replace(dir.path(), "foo", "bar", None, None, None).unwrap();
    assert_eq!(result.files_changed, 2);
    assert_eq!(result.replacements, 5);
    let app = fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
    assert!(app.contains("const bar = 1;"));
    assert!(app.contains("let bar = 2;"));
    assert!(app.contains("let bard = 3;"));
    let notes = fs::read_to_string(dir.path().join("notes.txt")).unwrap();
    assert!(notes.contains("bar cat concat"));
    assert!(notes.contains("bar Cat"));
    // foo.md 仅名称命中，内容不得被改
    assert_eq!(
        fs::read_to_string(dir.path().join("foo.md")).unwrap(),
        "readme\n"
    );
}

#[test]
fn test_apply_replace_single_file_scope() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let only = dir.path().join("notes.txt").to_string_lossy().to_string();
    let result = apply_replace(dir.path(), "foo", "bar", None, Some(vec![only]), None).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 2);
    assert!(fs::read_to_string(dir.path().join("src/app.ts"))
        .unwrap()
        .contains("const Foo = 1;"));
}

#[test]
fn test_apply_replace_limit_per_file_replaces_first_only() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    // 注意：join 单段再 join 文件名，确保路径分隔符与 walker 产出一致（Windows 为 \）
    let only = dir
        .path()
        .join("src")
        .join("app.ts")
        .to_string_lossy()
        .to_string();
    let result = apply_replace(dir.path(), "foo", "bar", None, Some(vec![only]), Some(1)).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 1);
    let app = fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
    // 首个匹配（第 1 行 "Foo"）被替换，其余保留
    assert!(app.contains("const bar = 1;"));
    assert!(app.contains("let foo = 2;"));
    assert!(app.contains("let food = 3;"));
}

#[test]
fn test_apply_replace_supports_capture_groups() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("users.txt"), "alice@corp bob@corp\n").unwrap();
    let result = apply_replace(
        dir.path(),
        r"(\w+)@(\w+)",
        "$2/$1",
        Some(opts(false, false, true)),
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 2);
    assert_eq!(
        fs::read_to_string(dir.path().join("users.txt")).unwrap(),
        "corp/alice corp/bob\n"
    );
}

#[test]
fn test_replace_honors_max_results_budget() {
    let dir = tempdir().unwrap();
    // 单文件 250 行命中 → 上限 200，truncated
    let body: String = (0..250).map(|i| format!("needle line {i}\n")).collect();
    fs::write(dir.path().join("big.txt"), body).unwrap();

    let preview = search_replace(dir.path(), "needle", "hit", None).unwrap();
    assert_eq!(preview.total, 200);
    assert!(preview.truncated);
    assert_eq!(preview.files[0].count, 200);

    // 写盘受同一预算约束：恰好替换前 200 处
    let result = apply_replace(dir.path(), "needle", "hit", None, None, None).unwrap();
    assert_eq!(result.files_changed, 1);
    assert_eq!(result.replacements, 200);
    let content = fs::read_to_string(dir.path().join("big.txt")).unwrap();
    assert_eq!(
        content
            .lines()
            .filter(|l| l.starts_with("hit line"))
            .count(),
        200
    );
    assert_eq!(
        content
            .lines()
            .filter(|l| l.starts_with("needle line"))
            .count(),
        50
    );
}

#[test]
fn test_apply_replace_invalid_regex_is_validation_error() {
    let dir = tempdir().unwrap();
    search_fixture(dir.path());
    let err = apply_replace(
        dir.path(),
        "(broken",
        "x",
        Some(opts(false, false, true)),
        None,
        None,
    )
    .unwrap_err();
    assert!(format!("{err}").contains("无效的正则表达式"));
    let err =
        search_replace(dir.path(), "(broken", "x", Some(opts(false, false, true))).unwrap_err();
    assert!(format!("{err}").contains("无效的正则表达式"));
}

// ---- copy / move into-self guards -----------------------------------
use nex_lib::fs::operations::{copy_entry, import_file, move_entry};

#[test]
fn copy_entry_rejects_directory_into_itself() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("src");
    fs::create_dir_all(src.join("a")).unwrap();
    fs::write(src.join("a/f.txt"), "hello").unwrap();

    let err = copy_entry(&src, &src).unwrap_err();
    assert!(
        format!("{err}").contains("自身或其子目录"),
        "unexpected: {err}"
    );
    // Must not have created src/src
    assert!(!src.join("src").exists());
}

#[test]
fn copy_entry_rejects_directory_into_descendant() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("src");
    let nested = src.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(src.join("f.txt"), "x").unwrap();

    let err = copy_entry(&src, &nested).unwrap_err();
    assert!(
        format!("{err}").contains("自身或其子目录"),
        "unexpected: {err}"
    );
    assert!(!nested.join("src").exists());
}

#[test]
fn copy_entry_to_sibling_parent_succeeds() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("src");
    let other = dir.path().join("other");
    fs::create_dir_all(src.join("a")).unwrap();
    fs::write(src.join("a/f.txt"), "hello").unwrap();
    fs::create_dir(&other).unwrap();

    copy_entry(&src, &other).unwrap();
    assert_eq!(
        fs::read_to_string(other.join("src/a/f.txt")).unwrap(),
        "hello"
    );
}

#[test]
fn import_file_rejects_directory_into_itself() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("src");
    fs::create_dir_all(src.join("a")).unwrap();

    let err = import_file(&src, &src).unwrap_err();
    assert!(
        format!("{err}").contains("自身或其子目录"),
        "unexpected: {err}"
    );
}

#[test]
fn move_entry_rejects_directory_into_descendant() {
    let dir = tempdir().unwrap();
    let src = dir.path().join("src");
    let nested = src.join("nested");
    fs::create_dir_all(&nested).unwrap();

    let err = move_entry(&src, &nested).unwrap_err();
    assert!(
        format!("{err}").contains("自身或其子目录"),
        "unexpected: {err}"
    );
    assert!(src.exists());
}
