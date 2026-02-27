use rusqlite::{params, Connection, Result};
use std::sync::Mutex;

use crate::Project;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(data_dir: &str) -> Result<Self> {
        let mut db_path = std::path::PathBuf::from(data_dir);
        db_path.push("sanhuoai.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).ok();
        let conn = Connection::open(&db_path)?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(include_str!("../../database/schema.sql"))
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, genre, description, status, \
             model_main, model_secondary, temperature, embedding_dim, word_target \
             FROM projects ORDER BY updated_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                genre: row.get(2)?,
                description: row.get(3)?,
                status: row.get(4)?,
                model_main: row.get(5)?,
                model_secondary: row.get(6)?,
                temperature: row.get(7)?,
                embedding_dim: row.get(8)?,
                word_target: row.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_project(&self, name: &str, genre: &str) -> Result<Project> {
        let conn = self.conn.lock().unwrap();
        let id: String = conn.query_row(
            "INSERT INTO projects (name, genre) VALUES (?1, ?2) RETURNING id",
            params![name, genre],
            |row| row.get(0),
        )?;
        drop(conn);
        let projects = self.list_projects()?;
        Ok(projects.into_iter().find(|p| p.id == id).unwrap())
    }
}
