//! Tree-sitter extractors. One file in → symbols + call/import facts.

use std::path::Path;

use tree_sitter::{Node, Parser, Tree};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
    Java,
}

impl Lang {
    pub fn id(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
            Lang::JavaScript => "javascript",
            Lang::Python => "python",
            Lang::Go => "go",
            Lang::Java => "java",
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "rs" => Some(Lang::Rust),
            "ts" => Some(Lang::TypeScript),
            "tsx" => Some(Lang::Tsx),
            "js" | "jsx" | "mjs" | "cjs" => Some(Lang::JavaScript),
            "py" => Some(Lang::Python),
            "go" => Some(Lang::Go),
            "java" => Some(Lang::Java),
            _ => None,
        }
    }

    fn ts_language(self) -> tree_sitter::Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Class,
    Function,
    Type,
    Test,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeKind::Class => "Class",
            NodeKind::Function => "Function",
            NodeKind::Type => "Type",
            NodeKind::Test => "Test",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactKind {
    Calls,
    Imports,
}

impl FactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FactKind::Calls => "calls",
            FactKind::Imports => "imports",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExtractedNode {
    pub kind: NodeKind,
    pub name: String,
    pub qualified: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone)]
pub struct ExtractedFact {
    pub kind: FactKind,
    pub src_name: Option<String>,
    pub dst_name: String,
}

#[derive(Debug, Clone, Default)]
pub struct ExtractedFile {
    pub nodes: Vec<ExtractedNode>,
    pub facts: Vec<ExtractedFact>,
}

/// Parse `src` as `lang`. `rel` is the workspace-relative path (`/` separators).
pub fn extract(rel: &str, src: &str, lang: Lang) -> Result<ExtractedFile, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&lang.ts_language())
        .map_err(|e| format!("tree-sitter language: {e}"))?;
    let tree = parser
        .parse(src, None)
        .ok_or_else(|| format!("parse failed: {rel}"))?;
    Ok(walk(rel, src.as_bytes(), lang, &tree))
}

fn walk(rel: &str, src: &[u8], lang: Lang, tree: &Tree) -> ExtractedFile {
    let mut out = ExtractedFile::default();
    let mut scope: Vec<String> = Vec::new();
    visit(tree.root_node(), rel, src, lang, &mut scope, &mut out, 0);
    out
}

fn visit(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    lang: Lang,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    depth: u32,
) {
    if depth > 256 {
        return;
    }
    let kind = node.kind();
    let mut pushed = false;

    match lang {
        Lang::Rust => visit_rust(node, rel, src, kind, scope, out, &mut pushed),
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            visit_js(node, rel, src, kind, scope, out, &mut pushed, lang)
        }
        Lang::Python => visit_python(node, rel, src, kind, scope, out, &mut pushed),
        Lang::Go => visit_go(node, rel, src, kind, scope, out, &mut pushed),
        Lang::Java => visit_java(node, rel, src, kind, scope, out, &mut pushed),
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, rel, src, lang, scope, out, depth + 1);
    }
    if pushed {
        scope.pop();
    }
}

fn visit_rust(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    kind: &str,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    pushed: &mut bool,
) {
    match kind {
        "function_item" | "function_signature_item" => {
            if let Some(name) = field_text(node, src, "name") {
                let is_test = rust_is_test(node, src, rel, &name);
                push_symbol(
                    out,
                    scope,
                    rel,
                    name,
                    if is_test {
                        NodeKind::Test
                    } else {
                        NodeKind::Function
                    },
                    node,
                    pushed,
                );
            }
        }
        "struct_item" | "enum_item" | "trait_item" | "type_item" | "union_item" => {
            if let Some(name) = field_text(node, src, "name") {
                let nk = if kind == "trait_item" || kind == "struct_item" {
                    NodeKind::Class
                } else {
                    NodeKind::Type
                };
                push_symbol(out, scope, rel, name, nk, node, pushed);
            }
        }
        "impl_item" => {
            if let Some(name) = field_text(node, src, "type").or_else(|| field_text(node, src, "trait"))
            {
                scope.push(strip_generics(&name));
                *pushed = true;
            }
        }
        "mod_item" => {
            if let Some(name) = field_text(node, src, "name") {
                push_symbol(out, scope, rel, name, NodeKind::Type, node, pushed);
            }
        }
        "use_declaration" => {
            if let Some(path) = rust_use_path(node, src) {
                out.facts.push(ExtractedFact {
                    kind: FactKind::Imports,
                    src_name: None,
                    dst_name: path,
                });
            }
        }
        "call_expression" => push_call(node, src, scope, out, "function"),
        _ => {}
    }
}

fn rust_is_test(node: Node<'_>, src: &[u8], rel: &str, name: &str) -> bool {
    if rel.contains("/tests/") || rel.starts_with("tests/") {
        return true;
    }
    if name.starts_with("test_") {
        return true;
    }
    if let Some(parent) = node.parent() {
        let mut cursor = parent.walk();
        let mut trailing = String::new();
        for child in parent.children(&mut cursor) {
            if child.id() == node.id() {
                break;
            }
            if child.kind() == "attribute_item" {
                if let Ok(t) = child.utf8_text(src) {
                    trailing.push_str(t);
                }
            } else {
                trailing.clear();
            }
        }
        if trailing.contains("#[test") || trailing.contains("#[tokio::test") {
            return true;
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "attribute_item" {
            if let Ok(t) = child.utf8_text(src) {
                if t.contains("#[test") || t.contains("#[tokio::test") {
                    return true;
                }
            }
        }
    }
    false
}

fn rust_use_path(node: Node<'_>, src: &[u8]) -> Option<String> {
    let text = node.utf8_text(src).ok()?.trim();
    let rest = text
        .trim_start_matches("pub")
        .trim_start()
        .trim_start_matches("use")
        .trim()
        .trim_end_matches(';')
        .trim();
    if rest.is_empty() {
        return None;
    }
    Some(rest.split_whitespace().next().unwrap_or(rest).to_string())
}

#[allow(clippy::too_many_arguments)]
fn visit_js(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    kind: &str,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    pushed: &mut bool,
    lang: Lang,
) {
    match kind {
        "function_declaration"
        | "generator_function_declaration"
        | "function_signature"
        | "method_definition"
        | "method_signature"
        | "abstract_method_signature" => {
            if let Some(name) = field_text(node, src, "name") {
                let is_test = js_is_test(rel, &name);
                push_symbol(
                    out,
                    scope,
                    rel,
                    name,
                    if is_test {
                        NodeKind::Test
                    } else {
                        NodeKind::Function
                    },
                    node,
                    pushed,
                );
            }
        }
        "class_declaration" | "abstract_class_declaration" => {
            if let Some(name) = field_text(node, src, "name") {
                push_symbol(out, scope, rel, name, NodeKind::Class, node, pushed);
            }
        }
        "interface_declaration" | "type_alias_declaration" | "enum_declaration" => {
            if let Some(name) = field_text(node, src, "name") {
                push_symbol(out, scope, rel, name, NodeKind::Type, node, pushed);
            }
        }
        "import_statement" | "import_clause" => {
            if kind == "import_statement" {
                for q in quoted_strings(node, src) {
                    out.facts.push(ExtractedFact {
                        kind: FactKind::Imports,
                        src_name: None,
                        dst_name: resolve_js_import(rel, &q, lang),
                    });
                }
            }
        }
        "call_expression" => {
            if let Some(fn_node) = node.child_by_field_name("function") {
                if fn_node.kind() == "identifier" {
                    if let Ok("require") = fn_node.utf8_text(src) {
                        for q in quoted_strings(node, src) {
                            out.facts.push(ExtractedFact {
                                kind: FactKind::Imports,
                                src_name: None,
                                dst_name: resolve_js_import(rel, &q, lang),
                            });
                        }
                    }
                }
            }
            push_call(node, src, scope, out, "function");
        }
        _ => {}
    }
}

fn js_is_test(rel: &str, name: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("/__tests__/")
        || name.starts_with("test")
}

fn resolve_js_import(from_rel: &str, spec: &str, lang: Lang) -> String {
    if !spec.starts_with('.') {
        return spec.to_string();
    }
    let parent = Path::new(from_rel).parent().unwrap_or(Path::new(""));
    let joined = parent.join(spec);
    let mut parts: Vec<String> = Vec::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            _ => {}
        }
    }
    let mut path = parts.join("/");
    let has_ext = Path::new(&path).extension().is_some();
    if !has_ext {
        let ext = match lang {
            Lang::Tsx => ".tsx",
            Lang::TypeScript => ".ts",
            _ => ".js",
        };
        path.push_str(ext);
    }
    path
}

fn visit_python(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    kind: &str,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    pushed: &mut bool,
) {
    match kind {
        "function_definition" => {
            if let Some(name) = field_text(node, src, "name") {
                let is_test = python_is_test(rel, &name);
                push_symbol(
                    out,
                    scope,
                    rel,
                    name,
                    if is_test {
                        NodeKind::Test
                    } else {
                        NodeKind::Function
                    },
                    node,
                    pushed,
                );
            }
        }
        "class_definition" => {
            if let Some(name) = field_text(node, src, "name") {
                push_symbol(out, scope, rel, name, NodeKind::Class, node, pushed);
            }
        }
        "import_statement" | "import_from_statement" => {
            if let Ok(text) = node.utf8_text(src) {
                for dst in python_import_targets(text) {
                    out.facts.push(ExtractedFact {
                        kind: FactKind::Imports,
                        src_name: None,
                        dst_name: dst,
                    });
                }
            }
        }
        "call" => push_call(node, src, scope, out, "function"),
        _ => {}
    }
}

fn python_is_test(rel: &str, name: &str) -> bool {
    let file = Path::new(rel)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.starts_with("test_") || file.starts_with("test_") || file.ends_with("_test.py")
}

fn python_import_targets(text: &str) -> Vec<String> {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("from ") {
        let modname = rest.split_whitespace().next().unwrap_or("").trim();
        if modname.is_empty() {
            Vec::new()
        } else {
            vec![modname.replace('.', "/") + ".py"]
        }
    } else if let Some(rest) = t.strip_prefix("import ") {
        rest.split(',')
            .map(|s| {
                let m = s.split_whitespace().next().unwrap_or("").trim();
                m.replace('.', "/") + ".py"
            })
            .filter(|s| s != ".py")
            .collect()
    } else {
        Vec::new()
    }
}

fn visit_go(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    kind: &str,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    pushed: &mut bool,
) {
    match kind {
        "function_declaration" | "method_declaration" => {
            if let Some(name) = field_text(node, src, "name") {
                let is_test = rel.ends_with("_test.go") || name.starts_with("Test");
                push_symbol(
                    out,
                    scope,
                    rel,
                    name,
                    if is_test {
                        NodeKind::Test
                    } else {
                        NodeKind::Function
                    },
                    node,
                    pushed,
                );
            }
        }
        "type_declaration" | "type_spec" => {
            if kind == "type_spec" {
                if let Some(name) = field_text(node, src, "name") {
                    push_symbol(out, scope, rel, name, NodeKind::Type, node, pushed);
                }
            }
        }
        "import_spec" | "import_declaration" => {
            if kind == "import_spec" || kind == "import_declaration" {
                for q in quoted_strings(node, src) {
                    out.facts.push(ExtractedFact {
                        kind: FactKind::Imports,
                        src_name: None,
                        dst_name: q,
                    });
                }
            }
        }
        "call_expression" => push_call(node, src, scope, out, "function"),
        _ => {}
    }
}

fn visit_java(
    node: Node<'_>,
    rel: &str,
    src: &[u8],
    kind: &str,
    scope: &mut Vec<String>,
    out: &mut ExtractedFile,
    pushed: &mut bool,
) {
    match kind {
        "method_declaration" | "constructor_declaration" => {
            if let Some(name) = field_text(node, src, "name") {
                let is_test = rel.ends_with("Test.java") || name.starts_with("test");
                push_symbol(
                    out,
                    scope,
                    rel,
                    name,
                    if is_test {
                        NodeKind::Test
                    } else {
                        NodeKind::Function
                    },
                    node,
                    pushed,
                );
            }
        }
        "class_declaration" | "interface_declaration" | "enum_declaration" | "record_declaration" => {
            if let Some(name) = field_text(node, src, "name") {
                let nk = if kind == "class_declaration" || kind == "record_declaration" {
                    NodeKind::Class
                } else {
                    NodeKind::Type
                };
                push_symbol(out, scope, rel, name, nk, node, pushed);
            }
        }
        "import_declaration" => {
            if let Ok(text) = node.utf8_text(src) {
                let rest = text
                    .trim()
                    .trim_start_matches("import")
                    .trim()
                    .trim_start_matches("static")
                    .trim()
                    .trim_end_matches(';')
                    .trim();
                if !rest.is_empty() {
                    out.facts.push(ExtractedFact {
                        kind: FactKind::Imports,
                        src_name: None,
                        dst_name: rest.replace('.', "/") + ".java",
                    });
                }
            }
        }
        "method_invocation" => {
            if let Some(name) = field_text(node, src, "name") {
                if is_ident(&name) {
                    out.facts.push(ExtractedFact {
                        kind: FactKind::Calls,
                        src_name: scope.last().cloned(),
                        dst_name: name,
                    });
                }
            }
        }
        _ => {}
    }
}

fn push_symbol(
    out: &mut ExtractedFile,
    scope: &mut Vec<String>,
    rel: &str,
    name: String,
    kind: NodeKind,
    node: Node<'_>,
    pushed: &mut bool,
) {
    if !is_ident(&name) {
        return;
    }
    let qualified = qualify(rel, scope, &name);
    out.nodes.push(ExtractedNode {
        kind,
        name: name.clone(),
        qualified,
        start_line: node.start_position().row as u32 + 1,
        end_line: node.end_position().row as u32 + 1,
    });
    scope.push(name);
    *pushed = true;
}

fn push_call(
    node: Node<'_>,
    src: &[u8],
    scope: &[String],
    out: &mut ExtractedFile,
    field: &str,
) {
    let Some(fn_node) = node.child_by_field_name(field) else {
        return;
    };
    let Some(name) = call_name(fn_node, src) else {
        return;
    };
    if !is_ident(&name) {
        return;
    }
    out.facts.push(ExtractedFact {
        kind: FactKind::Calls,
        src_name: scope.last().cloned(),
        dst_name: name,
    });
}

fn call_name(node: Node<'_>, src: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "property_identifier" | "field_identifier" | "type_identifier" => {
            node.utf8_text(src).ok().map(|s| s.to_string())
        }
        "member_expression" | "field_expression" | "selector_expression" => {
            field_text(node, src, "property")
                .or_else(|| field_text(node, src, "field"))
                .or_else(|| field_text(node, src, "name"))
                .or_else(|| {
                    node.named_child(node.named_child_count().saturating_sub(1))
                        .and_then(|n| n.utf8_text(src).ok().map(|s| s.to_string()))
                })
        }
        "scoped_identifier" => field_text(node, src, "name"),
        _ => None,
    }
}

fn field_text(node: Node<'_>, src: &[u8], field: &str) -> Option<String> {
    let n = node.child_by_field_name(field)?;
    let t = n.utf8_text(src).ok()?.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn quoted_strings(node: Node<'_>, src: &[u8]) -> Vec<String> {
    let Ok(text) = node.utf8_text(src) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let quote = bytes[i];
        if quote == b'\'' || quote == b'"' || quote == b'`' {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote {
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            if i <= bytes.len() {
                if let Ok(s) = std::str::from_utf8(&bytes[start..i.min(bytes.len())]) {
                    if !s.is_empty() {
                        out.push(s.to_string());
                    }
                }
            }
        }
        i += 1;
    }
    out
}

fn qualify(rel: &str, scope: &[String], name: &str) -> String {
    if scope.is_empty() {
        format!("{rel}::{name}")
    } else {
        format!("{rel}::{}::{name}", scope.join("::"))
    }
}

fn strip_generics(name: &str) -> String {
    name.split('<').next().unwrap_or(name).trim().to_string()
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_extracts_fn_and_call() {
        let src = r#"
            pub fn target() {}
            pub fn caller() { target(); }
            #[test]
            fn test_it() { target(); }
        "#;
        let out = extract("src/lib.rs", src, Lang::Rust).unwrap();
        let names: Vec<_> = out.nodes.iter().map(|n| (n.name.as_str(), n.kind)).collect();
        assert!(names.contains(&("target", NodeKind::Function)));
        assert!(names.contains(&("caller", NodeKind::Function)));
        assert!(names.contains(&("test_it", NodeKind::Test)));
        assert!(out.facts.iter().any(|f| f.kind == FactKind::Calls && f.dst_name == "target"));
    }

    #[test]
    fn ts_extracts_import_and_class() {
        let src = r#"
            import { Foo } from './foo';
            export class Bar { run() { Foo(); } }
        "#;
        let out = extract("src/bar.ts", src, Lang::TypeScript).unwrap();
        assert!(out.nodes.iter().any(|n| n.name == "Bar" && n.kind == NodeKind::Class));
        assert!(out.nodes.iter().any(|n| n.name == "run" && n.kind == NodeKind::Function));
        assert!(out
            .facts
            .iter()
            .any(|f| f.kind == FactKind::Imports && f.dst_name.contains("foo")));
    }

    #[test]
    fn python_extracts_class() {
        let src = "class Greeter:\n    def hello(self):\n        print(1)\n";
        let out = extract("app.py", src, Lang::Python).unwrap();
        assert!(out.nodes.iter().any(|n| n.name == "Greeter" && n.kind == NodeKind::Class));
        assert!(out.nodes.iter().any(|n| n.name == "hello"));
    }
}
