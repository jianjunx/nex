use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::Database;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    pub last_opened: i64,
}

impl Database {
    pub fn create_project(&self, name: &str, path: &str) -> Result<Project, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            path: path.to_string(),
            created_at: now,
            last_opened: now,
        };
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project.id, project.name, project.path, project.created_at, project.last_opened],
        )?;
        Ok(project)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, path, created_at, last_opened FROM projects ORDER BY last_opened DESC")?;
        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                last_opened: row.get(4)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(projects)
    }

    pub fn update_project_last_opened(&self, id: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute("UPDATE projects SET last_opened = ?1 WHERE id = ?2", params![now, id])?;
        Ok(())
    }
}
