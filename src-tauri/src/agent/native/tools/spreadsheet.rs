//! Spreadsheet tool: `read_spreadsheet` — reads Excel (.xlsx/.xls/.xlsb),
//! LibreOffice (.ods) and CSV/TSV files into a structured row/column grid for
//! the model.
//!
//! Binary formats go through `calamine` (pure Rust, no system deps). CSV/TSV
//! are parsed in-process (RFC-4180 subset: quoted fields, escaped quotes,
//! embedded separators/newlines, UTF-8 with optional BOM) because calamine
//! 0.30 no longer ships a CSV reader. Output is capped per dimension and by
//! total chars so huge sheets can't blow up the context.

use super::{arg_str, arg_str_opt, arg_usize, resolve_within, truncate_output, Tool, ToolCtx};
use agent_client_protocol as acp;
use calamine::Reader as _;

/// Default max rows rendered per call.
const MAX_ROWS: usize = 100;
/// Default max columns rendered per call.
const MAX_COLS: usize = 20;
/// Cap on total output characters (same budget as the other read tools).
const MAX_OUTPUT_CHARS: usize = 20_000;

/// Extensions handed to calamine's binary readers.
const BINARY_EXTS: [&str; 6] = ["xlsx", "xlsm", "xlam", "xls", "xlsb", "ods"];

pub struct ReadSpreadsheet;

#[async_trait::async_trait(?Send)]
impl Tool for ReadSpreadsheet {
    fn name(&self) -> &'static str {
        "read_spreadsheet"
    }
    fn description(&self) -> &'static str {
        "Read a spreadsheet (Excel .xlsx/.xls/.xlsb, LibreOffice .ods, or UTF-8 \
         CSV/TSV) and return the cell values as a structured grid. Use `sheet` to \
         pick a worksheet (default: the first one); `max_rows` / `max_cols` cap \
         the output."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (absolute or workspace-relative)." },
                "sheet": { "type": "string", "description": "Worksheet name; defaults to the first sheet (CSV has a single `Sheet1`)." },
                "max_rows": { "type": "integer", "description": "Maximum rows to return. Default 100." },
                "max_cols": { "type": "integer", "description": "Maximum columns to return. Default 20." }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }
    fn kind(&self) -> acp::ToolKind {
        acp::ToolKind::Read
    }
    fn read_only(&self) -> bool {
        true
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolCtx) -> Result<String, String> {
        let path = resolve_within(&ctx.cwd, &arg_str(&args, "path")?)?;
        let sheet = arg_str_opt(&args, "sheet");
        let max_rows = arg_usize(&args, "max_rows", MAX_ROWS).min(MAX_ROWS);
        let max_cols = arg_usize(&args, "max_cols", MAX_COLS).min(MAX_COLS);

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());

        let grid: Vec<Vec<String>> = if BINARY_EXTS.iter().any(|b| ext.as_deref() == Some(*b)) {
            // Excel / ODS: read the selected worksheet through calamine.
            let mut wb = calamine::open_workbook_auto(&path).map_err(|e| {
                format!("failed to open `{}` as a spreadsheet: {e}", path.display())
            })?;
            let names = wb.sheet_names();
            if names.is_empty() {
                return Err(format!("`{}` contains no worksheets", path.display()));
            }
            let target = pick_sheet(&names, sheet.as_deref())?;
            let range = wb
                .worksheet_range(&target)
                .map_err(|e| format!("failed to read worksheet `{target}`: {e}"))?;
            range
                .rows()
                .map(|row| row.iter().map(cell_text).collect())
                .collect()
        } else {
            // CSV / TSV (and unknown text extensions): parse in-process.
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("failed to read `{}`: {e}", path.display()))?;
            let delim = if ext.as_deref() == Some("tsv") {
                '\t'
            } else {
                ','
            };
            let target = pick_sheet(&["Sheet1".to_string()], sheet.as_deref())?;
            let _ = target; // CSV has a single sheet; name kept for symmetry.
            parse_csv(&text, delim)
        };

        Ok(format_grid(
            sheet.as_deref().unwrap_or("Sheet1"),
            &grid,
            max_rows,
            max_cols,
        ))
    }
}

/// Resolve `requested` against the available sheet names; defaults to the
/// first one. Errors name the available sheets so the model can retry.
fn pick_sheet(names: &[String], requested: Option<&str>) -> Result<String, String> {
    match requested {
        Some(name) => names
            .iter()
            .find(|n| n.as_str() == name)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "worksheet `{name}` not found; available: {}",
                    names.join(", ")
                )
            }),
        None => Ok(names[0].clone()),
    }
}

/// Render a grid as a compact, line-stable table: one line per row,
/// ` | `-separated cells, newlines inside cells flattened.
fn format_grid(sheet: &str, grid: &[Vec<String>], max_rows: usize, max_cols: usize) -> String {
    let height = grid.len();
    let width = grid.iter().map(|r| r.len()).max().unwrap_or(0);
    if height == 0 || width == 0 {
        return format!("[sheet: {sheet}] is empty");
    }
    let mut out = format!(
        "[sheet: {sheet}] {height} rows × {width} cols (showing first {max_rows} rows × {max_cols} cols)\n"
    );
    for (r, row) in grid.iter().take(max_rows).enumerate() {
        let cells: Vec<String> = row
            .iter()
            .take(max_cols)
            .map(|s| s.replace(['\n', '\r'], "⏎"))
            .collect();
        out.push_str(&format!("{:>4}: {}\n", r + 1, cells.join(" | ")));
    }
    if height > max_rows {
        out.push_str(&format!(
            "… [{} more rows; pass a larger `max_rows` to see them]\n",
            height - max_rows
        ));
    }
    if width > max_cols {
        out.push_str(&format!(
            "… [{} more cols; pass a larger `max_cols` to see them]\n",
            width - max_cols
        ));
    }
    truncate_output(out, MAX_OUTPUT_CHARS)
}

/// Render a calamine cell for the model: empty cells stay empty, floats that
/// are whole numbers drop the `.0`, errors are bracketed.
fn cell_text(data: &calamine::Data) -> String {
    match data {
        calamine::Data::Empty => String::new(),
        calamine::Data::String(s) => s.clone(),
        calamine::Data::Int(i) => i.to_string(),
        calamine::Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        calamine::Data::Bool(b) => b.to_string(),
        calamine::Data::DateTime(dt) => dt.to_string(),
        calamine::Data::DateTimeIso(s) => s.clone(),
        calamine::Data::DurationIso(s) => s.clone(),
        calamine::Data::Error(e) => format!("<{e:?}>"),
    }
}

/// RFC-4180 subset parser: quoted fields (with `""` escapes), embedded
/// separators and newlines, CRLF/LF line endings, optional UTF-8 BOM.
fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;

    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                c if c == delim => {
                    row.push(std::mem::take(&mut field));
                }
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                '\r' => {} // CRLF: the following \n terminates the record
                _ => field.push(c),
            }
        }
    }
    // A final record without a trailing newline.
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn ctx(dir: &Path) -> ToolCtx {
        ToolCtx {
            cwd: dir.to_path_buf(),
            bash_timeout: std::time::Duration::from_secs(10),
            shell_sandbox: crate::agent::native::config::ShellSandboxMode::ApprovalOnly,
            path_env: std::env::var_os("PATH").unwrap_or_default(),
            archive_dir: dir.join(".nex-archive"),
            jobs: std::rc::Rc::new(std::cell::RefCell::new(
                crate::agent::native::tools::jobs::JobTable::default(),
            )),
            harness: None,
            mutations: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            mode_id: None,
            memory: super::super::test_memory_handle(),
            graph: None,
            conn: None,
            session_id: None,
        }
    }

    fn write(tmp: &tempfile::TempDir, name: &str, body: &str) {
        std::fs::write(tmp.path().join(name), body).unwrap();
    }

    #[test]
    fn csv_parser_handles_quotes_escapes_and_crlf() {
        let rows = parse_csv(
            "a,b\n\"x,y\",\"say \"\"hi\"\"\"\n1,\"multi\nline\"\r\n",
            ',',
        );
        assert_eq!(
            rows,
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["x,y".to_string(), "say \"hi\"".to_string()],
                vec!["1".to_string(), "multi\nline".to_string()],
            ]
        );
        // BOM is stripped.
        let rows = parse_csv("\u{feff}h1,h2\n1,2\n", ',');
        assert_eq!(rows[0], vec!["h1".to_string(), "h2".to_string()]);
        // Final record without trailing newline is kept.
        let rows = parse_csv("a,b\n1,2", ',');
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reads_csv_with_quotes_and_empty_cells() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp,
            "data.csv",
            "name,age,city\n\"Alice, A.\",30,\"New York\"\nBob,,Paris\n",
        );
        let out = ReadSpreadsheet
            .execute(serde_json::json!({"path": "data.csv"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("[sheet: Sheet1] 3 rows × 3 cols"), "{out}");
        assert!(out.contains("1: name | age | city"), "{out}");
        assert!(out.contains("2: Alice, A. | 30 | New York"), "{out}");
        assert!(out.contains("3: Bob |  | Paris"), "{out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sheet_selection_and_errors() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp, "s.csv", "a,b\n1,2\n");
        // Unknown sheet names the available ones (CSV has a single `Sheet1`).
        let err = ReadSpreadsheet
            .execute(
                serde_json::json!({"path": "s.csv", "sheet": "nope"}),
                &ctx(tmp.path()),
            )
            .await
            .unwrap_err();
        assert!(err.contains("not found") && err.contains("Sheet1"), "{err}");
        // Explicit `Sheet1` is accepted.
        let out = ReadSpreadsheet
            .execute(
                serde_json::json!({"path": "s.csv", "sheet": "Sheet1"}),
                &ctx(tmp.path()),
            )
            .await
            .unwrap();
        assert!(out.contains("1: a | b"), "{out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn respects_row_and_col_limits() {
        let tmp = tempfile::tempdir().unwrap();
        let mut body = String::from("c1,c2,c3,c4,c5\n");
        for i in 1..=200 {
            body.push_str(&format!("r{i},v,v,v,v\n"));
        }
        write(&tmp, "big.csv", &body);
        let out = ReadSpreadsheet
            .execute(
                serde_json::json!({"path": "big.csv", "max_rows": 3, "max_cols": 2}),
                &ctx(tmp.path()),
            )
            .await
            .unwrap();
        assert!(out.contains("201 rows × 5 cols"), "{out}");
        assert!(out.contains("1: c1 | c2"), "{out}");
        assert!(out.contains("3: r2 | v"), "{out}");
        assert!(out.contains("198 more rows"), "{out}");
        assert!(out.contains("3 more cols"), "{out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reads_tsv_with_tab_delimiter() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp, "data.tsv", "name\tage\nAlice\t30\n");
        let out = ReadSpreadsheet
            .execute(serde_json::json!({"path": "data.tsv"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("1: name | age"), "{out}");
        assert!(out.contains("2: Alice | 30"), "{out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reads_minimal_xlsx() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_minimal_xlsx(&tmp);
        let out = ReadSpreadsheet
            .execute(
                serde_json::json!({"path": p.file_name().unwrap().to_string_lossy()}),
                &ctx(tmp.path()),
            )
            .await
            .unwrap();
        assert!(out.contains("[sheet: Sheet1] 2 rows × 2 cols"), "{out}");
        assert!(out.contains("1: name | age"), "{out}");
        assert!(out.contains("2: Alice | 30"), "{out}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn non_spreadsheet_errors_clearly() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp, "notdata.txt", "just text\n");
        // Unknown extension falls back to CSV parsing — plain text yields a
        // single-cell grid rather than an error, which is still useful.
        let out = ReadSpreadsheet
            .execute(serde_json::json!({"path": "notdata.txt"}), &ctx(tmp.path()))
            .await
            .unwrap();
        assert!(out.contains("1: just text"), "{out}");
        // A real binary that is not a spreadsheet fails on the calamine path.
        write(&tmp, "fake.xlsx", "not a zip at all");
        let err = ReadSpreadsheet
            .execute(serde_json::json!({"path": "fake.xlsx"}), &ctx(tmp.path()))
            .await
            .unwrap_err();
        assert!(err.contains("failed to open"), "{err}");
    }

    /// Builds a minimal valid .xlsx (zip with the four OOXML parts) using the
    /// `zip` crate already in the dependency tree.
    fn write_minimal_xlsx(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        let path = tmp.path().join("book.xlsx");
        let file = std::fs::File::create(&path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        let mut add = |name: &str, body: &str| {
            zw.start_file(name, opts).unwrap();
            use std::io::Write;
            zw.write_all(body.as_bytes()).unwrap();
        };

        add(
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        );
        add(
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        );
        add(
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        );
        add(
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        );
        add(
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>age</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Alice</t></is></c><c r="B2"><v>30</v></c></row>
</sheetData>
</worksheet>"#,
        );

        zw.finish().unwrap();
        path
    }
}
