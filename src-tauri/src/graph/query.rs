//! Four `code_graph` actions rendered as compact text.

use std::path::Path;

use rusqlite::{params, Connection};

use super::index;
use super::store;

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;

#[derive(Debug, Clone)]
pub struct QueryReq {
    pub action: String,
    pub query: Option<String>,
    pub kind: Option<String>,
    pub pattern: Option<String>,
    pub target: Option<String>,
    pub files: Vec<String>,
    pub base: String,
    pub limit: usize,
}

impl QueryReq {
    pub fn from_args(args: &serde_json::Value) -> Result<Self, String> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if action.is_empty() {
            return Err("missing required argument `action`".into());
        }
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .filter(|n| *n > 0)
            .unwrap_or(DEFAULT_LIMIT)
            .min(MAX_LIMIT);
        let files = args
            .get("files")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            action,
            query: opt_str(args, "query"),
            kind: opt_str(args, "kind"),
            pattern: opt_str(args, "pattern"),
            target: opt_str(args, "target"),
            files,
            base: opt_str(args, "base").unwrap_or_else(|| "HEAD~1".into()),
            limit,
        })
    }
}

fn opt_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

pub fn execute(cwd: &Path, req: &QueryReq) -> Result<String, String> {
    let conn = store::open_read(cwd)?;
    match req.action.as_str() {
        "overview" => overview(&conn, cwd, req.limit),
        "search" => search(&conn, req),
        "query" => structural(&conn, req),
        "impact" => impact(&conn, cwd, req),
        other => Err(format!(
            "unknown action `{other}`; use overview | search | query | impact"
        )),
    }
}

fn overview(conn: &Connection, cwd: &Path, _limit: usize) -> Result<String, String> {
    let files: i64 = count(conn, "SELECT COUNT(*) FROM files")?;
    let nodes: i64 = count(conn, "SELECT COUNT(*) FROM nodes")?;
    let last = meta(conn, "last_build").unwrap_or_else(|| "never".into());
    let mut langs: Vec<(String, i64)> = query_pairs(
        conn,
        "SELECT language, COUNT(*) FROM files GROUP BY language ORDER BY COUNT(*) DESC",
    )?;
    let dirs = {
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| e.to_string())?;
        let mut counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let p = row.map_err(|e| e.to_string())?;
            let top = p.split('/').next().unwrap_or(&p).to_string();
            *counts.entry(top).or_insert(0) += 1;
        }
        let mut dirs: Vec<(String, i64)> = counts.into_iter().collect();
        dirs.sort_by_key(|b| std::cmp::Reverse(b.1));
        dirs.truncate(8);
        dirs
    };
    let mut out = String::new();
    out.push_str(&format!(
        "code graph  files={files}  symbols={nodes}  last_build={last}\n"
    ));
    out.push_str("languages:");
    if langs.is_empty() {
        out.push_str(" (none)");
    }
    for (l, n) in langs.drain(..) {
        out.push_str(&format!(" {l}={n}"));
    }
    out.push('\n');
    out.push_str("top dirs:");
    for (d, n) in &dirs {
        out.push_str(&format!(" {d}={n}"));
    }
    out.push('\n');
    out.push_str("next: code_graph action=search query=<name>  |  action=query pattern=callers_of target=<name>  |  action=impact\n");
    let _ = cwd;
    Ok(out)
}

fn search(conn: &Connection, req: &QueryReq) -> Result<String, String> {
    let q = req.query.as_deref().ok_or("search requires `query`")?;
    let like = format!("%{q}%");
    let order = " ORDER BY CASE kind WHEN 'Function' THEN 0 WHEN 'Class' THEN 1 WHEN 'Type' THEN 2 WHEN 'Test' THEN 3 ELSE 4 END, name LIMIT ";
    let rows = if let Some(kind) = &req.kind {
        let sql = format!(
            "SELECT kind, name, file, start_line FROM nodes
             WHERE (name LIKE ?1 COLLATE NOCASE OR qualified LIKE ?1 COLLATE NOCASE OR file LIKE ?1 COLLATE NOCASE)
               AND kind = ?2{order}?3"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![like, kind, req.limit as i64], row_hit)
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        let sql = format!(
            "SELECT kind, name, file, start_line FROM nodes
             WHERE (name LIKE ?1 COLLATE NOCASE OR qualified LIKE ?1 COLLATE NOCASE OR file LIKE ?1 COLLATE NOCASE)
             {order}?2"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![like, req.limit as i64], row_hit)
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(render_hits("search", &rows, req.limit))
}

fn structural(conn: &Connection, req: &QueryReq) -> Result<String, String> {
    let pattern = req
        .pattern
        .as_deref()
        .ok_or("query requires `pattern` (callers_of|callees_of|imports_of|importers_of|tests_for|children_of|file_summary)")?;
    let target = req
        .target
        .as_deref()
        .ok_or("query requires `target` (symbol name, qualified name, or path)")?;
    match pattern {
        "callers_of" => {
            let sql = "SELECT DISTINCT 'Function', COALESCE(src_name, src_file), src_file, 1
                       FROM facts WHERE kind = 'calls' AND dst_name = ?1 COLLATE NOCASE
                       LIMIT ?2";
            fact_hits(conn, sql, target, req.limit, "callers")
        }
        "callees_of" => {
            let sql = "SELECT DISTINCT 'Function', dst_name, src_file, 1
                       FROM facts WHERE kind = 'calls' AND (src_name = ?1 COLLATE NOCASE)
                       LIMIT ?2";
            fact_hits(conn, sql, target, req.limit, "callees")
        }
        "imports_of" => {
            let sql = "SELECT DISTINCT 'File', dst_name, src_file, 1
                       FROM facts WHERE kind = 'imports' AND src_file = ?1
                       LIMIT ?2";
            let file = resolve_file(conn, target).unwrap_or_else(|| target.to_string());
            fact_hits(conn, sql, &file, req.limit, "imports")
        }
        "importers_of" => {
            let file = resolve_file(conn, target).unwrap_or_else(|| target.to_string());
            let like = format!("%{file}%");
            let sql = "SELECT DISTINCT 'File', src_file, src_file, 1
                       FROM facts WHERE kind = 'imports' AND dst_name LIKE ?1
                       LIMIT ?2";
            fact_hits(conn, sql, &like, req.limit, "importers")
        }
        "tests_for" => {
            let sql = "SELECT kind, name, file, start_line FROM nodes
                       WHERE kind = 'Test' AND (
                         name LIKE ?1 COLLATE NOCASE
                         OR file LIKE ?1 COLLATE NOCASE
                         OR qualified LIKE ?1 COLLATE NOCASE
                       ) LIMIT ?2";
            let like = format!("%{target}%");
            named_hits(conn, sql, &like, req.limit, "tests")
        }
        "children_of" | "file_summary" => {
            let file = resolve_file(conn, target).unwrap_or_else(|| target.to_string());
            let sql = "SELECT kind, name, file, start_line FROM nodes
                       WHERE file = ?1 AND kind != 'File'
                       ORDER BY start_line LIMIT ?2";
            named_hits(conn, sql, &file, req.limit, "children")
        }
        other => Err(format!("unknown pattern `{other}`")),
    }
}

fn impact(conn: &Connection, cwd: &Path, req: &QueryReq) -> Result<String, String> {
    let files = if req.files.is_empty() {
        index::git_changed_files(cwd, &req.base)?
    } else {
        req.files.clone()
    };
    if files.is_empty() {
        return Ok("impact: no changed files\n".into());
    }
    let mut out = String::new();
    out.push_str(&format!("impact  files={}\n", files.len()));
    let mut shown = 0usize;
    let limit = req.limit;
    for file in files.iter().take(limit) {
        out.push_str(&format!("changed  {file}\n"));
        // Symbols in the file.
        let mut stmt = conn
            .prepare(
                "SELECT kind, name, start_line FROM nodes
                 WHERE file = ?1 AND kind != 'File' ORDER BY start_line LIMIT 12",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([file.as_str()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut names: Vec<String> = Vec::new();
        for row in rows {
            let (kind, name, line) = row.map_err(|e| e.to_string())?;
            names.push(name.clone());
            out.push_str(&format!("  {kind} {name}  {file}:{line}\n"));
            shown += 1;
        }
        // Direct callers of those symbols (depth 1) plus importers (depth 1).
        for name in names.iter().take(8) {
            let mut cstmt = conn
                .prepare(
                    "SELECT DISTINCT COALESCE(src_name, src_file), src_file
                     FROM facts WHERE kind = 'calls' AND dst_name = ?1 COLLATE NOCASE
                     LIMIT 6",
                )
                .map_err(|e| e.to_string())?;
            let callers = cstmt
                .query_map([name.as_str()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for c in callers {
                let (src, src_file) = c.map_err(|e| e.to_string())?;
                if src_file == *file {
                    continue;
                }
                out.push_str(&format!("  caller {src}  {src_file}  -> {name}\n"));
                shown += 1;
                if shown >= limit * 4 {
                    break;
                }
            }
        }
        let mut istmt = conn
            .prepare(
                "SELECT DISTINCT src_file FROM facts
                 WHERE kind = 'imports' AND dst_name LIKE ?1 LIMIT 8",
            )
            .map_err(|e| e.to_string())?;
        let like = format!("%{file}%");
        let imps = istmt
            .query_map([like.as_str()], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for imp in imps {
            let src = imp.map_err(|e| e.to_string())?;
            out.push_str(&format!("  importer  {src}\n"));
        }
        if shown >= limit * 4 {
            out.push_str("… truncated\n");
            break;
        }
    }
    Ok(out)
}

struct Hit {
    kind: String,
    name: String,
    file: String,
    line: i64,
}

fn row_hit(r: &rusqlite::Row<'_>) -> rusqlite::Result<Hit> {
    Ok(Hit {
        kind: r.get(0)?,
        name: r.get(1)?,
        file: r.get(2)?,
        line: r.get(3)?,
    })
}

fn fact_hits(
    conn: &Connection,
    sql: &str,
    bind: &str,
    limit: usize,
    title: &str,
) -> Result<String, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![bind, limit as i64], row_hit)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(render_hits(title, &rows, limit))
}

fn named_hits(
    conn: &Connection,
    sql: &str,
    bind: &str,
    limit: usize,
    title: &str,
) -> Result<String, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![bind, limit as i64], row_hit)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(render_hits(title, &rows, limit))
}

fn render_hits(title: &str, hits: &[Hit], limit: usize) -> String {
    if hits.is_empty() {
        return format!("{title}: 0 results\n");
    }
    let mut out = format!("{title}: {} result(s)\n", hits.len());
    for h in hits.iter().take(limit) {
        out.push_str(&format!(
            "{kind}  {name}  {file}:{line}\n",
            kind = h.kind,
            name = h.name,
            file = h.file,
            line = h.line
        ));
    }
    out
}

fn resolve_file(conn: &Connection, target: &str) -> Option<String> {
    if target.contains('/') || target.contains('.') {
        let found: Option<String> = conn
            .query_row(
                "SELECT path FROM files WHERE path = ?1 OR path LIKE ?2 LIMIT 1",
                params![target, format!("%{target}")],
                |r| r.get(0),
            )
            .ok();
        if found.is_some() {
            return found;
        }
    }
    conn.query_row(
        "SELECT file FROM nodes WHERE name = ?1 COLLATE NOCASE OR qualified = ?1 COLLATE NOCASE LIMIT 1",
        [target],
        |r| r.get(0),
    )
    .ok()
}

fn count(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

fn query_pairs(conn: &Connection, sql: &str) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
