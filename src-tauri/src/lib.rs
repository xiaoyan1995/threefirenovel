mod db;

use db::Database;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "windows"))]
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

const AGENT_PORT: u16 = 8765;

pub struct AppState {
    pub db: Database,
    pub agent_process: Mutex<Option<Child>>,
    pub data_dir: String,
}

#[derive(Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub genre: String,
    pub description: Option<String>,
    pub status: String,
    pub model_main: String,
    pub model_secondary: String,
    pub temperature: f64,
    pub embedding_dim: i32,
    pub word_target: i32,
}

// ---- Project Commands ----

#[tauri::command]
fn list_projects(state: State<AppState>) -> Result<Vec<Project>, String> {
    state.db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_project(state: State<AppState>, name: String, genre: String) -> Result<Project, String> {
    state.db.create_project(&name, &genre).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_data_dir(state: State<AppState>) -> String {
    state.data_dir.clone()
}

// ---- Agent Process Management ----

#[derive(Serialize)]
struct AgentStatus {
    running: bool,
    ready: bool,
    pid: Option<u32>,
}

#[tauri::command]
fn agent_status(state: State<AppState>) -> AgentStatus {
    let proc = state.agent_process.lock().unwrap();
    let (running, pid) = match proc.as_ref() {
        Some(child) => (true, Some(child.id())),
        None => (false, None),
    };
    let ready = running && check_health();
    AgentStatus { running, ready, pid }
}

#[tauri::command]
fn start_agent(state: State<AppState>, app: tauri::AppHandle) -> Result<String, String> {
    let mut proc = state.agent_process.lock().map_err(|e| e.to_string())?;
    if proc.is_some() {
        return Ok("Agent already running".into());
    }

    let child = spawn_agent(&app, &state.data_dir)
        .ok_or_else(|| "Failed to start agent process".to_string())?;
    *proc = Some(child);
    Ok("Agent started on port 8765".into())
}

#[tauri::command]
fn stop_agent(state: State<AppState>) -> Result<String, String> {
    let mut proc = state.agent_process.lock().map_err(|e| e.to_string())?;
    if let Some(child) = proc.take() {
        kill_process_tree(child);
        Ok("Agent stopped".into())
    } else {
        Ok("Agent not running".into())
    }
}

#[tauri::command]
fn restart_agent(state: State<AppState>, app: tauri::AppHandle) -> Result<String, String> {
    let mut proc = state.agent_process.lock().map_err(|e| e.to_string())?;
    if let Some(child) = proc.take() {
        kill_process_tree(child);
    }
    let child = spawn_agent(&app, &state.data_dir)
        .ok_or_else(|| "Failed to restart agent".to_string())?;
    *proc = Some(child);
    Ok("Agent restarted".into())
}

/// Check if the agent HTTP service is responding
fn check_health() -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", AGENT_PORT).parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
}

/// Resolve the agent directory: dev uses project root, production uses bundled resources
fn resolve_agent_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        cwd.join("agent")
    } else {
        resolve_bundled_resource(app, "agent")
            .unwrap_or_else(|| app.path().resource_dir().unwrap_or_default().join("agent"))
    }
}

/// Resolve the Python executable: dev uses system Python, production uses bundled python_embed
fn resolve_python(app: &tauri::AppHandle) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(if cfg!(target_os = "windows") { "python" } else { "python3" })
    } else {
        let base = resolve_bundled_resource(app, "python_embed")
            .unwrap_or_else(|| app.path().resource_dir().unwrap_or_default().join("python_embed"));

        #[cfg(target_os = "windows")]
        let candidates = vec![
            base.join("python.exe"),
            base.join("python3.exe"),
            base.join("python"),
            base.join("python3"),
        ];

        #[cfg(not(target_os = "windows"))]
        let candidates = vec![
            base.join("bin").join("python3"),
            base.join("bin").join("python"),
            base.join("python3"),
            base.join("python"),
            base.join("bin").join("python3.10"),
            base.join("bin").join("python3.11"),
            base.join("bin").join("python3.12"),
        ];

        candidates
            .into_iter()
            .find(|p| p.exists())
            .unwrap_or_else(|| {
                if cfg!(target_os = "windows") {
                    base.join("python.exe")
                } else {
                    base.join("bin").join("python3")
                }
            })
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn candidate_resource_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(rd) = app.path().resource_dir() {
        roots.push(rd);
    }

    if let Some(dir) = exe_dir() {
        roots.push(dir.join("resources"));
        roots.push(dir);
    }

    roots
}

fn resolve_bundled_resource(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let clean_name = name.trim_matches('/');
    candidate_resource_roots(app).into_iter().find_map(|root| {
        let direct = root.join(clean_name);
        if direct.exists() {
            return Some(direct);
        }

        // Some bundle layouts place user resources under ".../Resources/resources/".
        let nested = root.join("resources").join(clean_name);
        if nested.exists() {
            return Some(nested);
        }

        None
    })
}

fn spawn_agent(app: &tauri::AppHandle, data_dir: &str) -> Option<Child> {
    let agent_dir = resolve_agent_dir(app);
    let python = resolve_python(app);
    println!("[sanhuoai] resolved agent_dir={}", agent_dir.display());
    println!("[sanhuoai] resolved python={}", python.display());
    if !agent_dir.exists() {
        eprintln!("[sanhuoai] agent_dir missing: {}", agent_dir.display());
    }
    if !python.exists() {
        eprintln!("[sanhuoai] python missing: {}", python.display());
    }
    let mut cmd = Command::new(&python);
    cmd.args(["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", &AGENT_PORT.to_string()]);
    if cfg!(debug_assertions) {
        cmd.arg("--reload");
    }
    cmd.current_dir(&agent_dir)
        .env("SANHUOAI_DATA_DIR", data_dir);

    // 在 Windows 上创建独立的控制台窗口，让后端 CMD 常驻显示
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }

    // 非 Windows 平台仍然重定向到日志文件
    #[cfg(not(target_os = "windows"))]
    {
        let mut log_path = std::path::PathBuf::from(data_dir);
        log_path.push("agent.log");
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&log_path) {
            if let Ok(err_file) = file.try_clone() {
                cmd.stdout(std::process::Stdio::from(file));
                cmd.stderr(std::process::Stdio::from(err_file));
            }
        }
    }

    match cmd.spawn() {
        Ok(child) => {
            println!("[sanhuoai] Agent spawned (pid={})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[sanhuoai] Failed to start agent: {}", e);
            None
        }
    }
}

/// Kill a process and its entire process tree (important on Windows where
/// child.kill() only kills the parent, leaving uvicorn workers orphaned)
fn kill_process_tree(mut child: Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        // taskkill /F /T /PID kills the entire process tree
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Send SIGTERM to process group
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
    }
    let _ = child.kill();
    let _ = child.wait();
    println!("[sanhuoai] Agent stopped (pid={})", pid);
}

/// Background watchdog: restarts agent if it crashes
fn start_watchdog(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Wait for initial startup
        std::thread::sleep(Duration::from_secs(5));

        loop {
            std::thread::sleep(Duration::from_secs(3));

            let state = handle.state::<AppState>();
            let mut proc = state.agent_process.lock().unwrap();

            // Check if process has exited
            let exited = match proc.as_mut() {
                Some(child) => child.try_wait().ok().flatten().is_some(),
                None => false,
            };

            if exited {
                println!("[sanhuoai] Agent crashed, restarting...");
                proc.take(); // Clear dead process
                drop(proc); // Release lock before spawning

                if let Some(child) = spawn_agent(&handle, &state.data_dir) {
                    let mut proc = state.agent_process.lock().unwrap();
                    *proc = Some(child);
                }
            }
        }
    });
}

// ---- App Entry Point ----

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = {
        let mut p = dirs_next::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        p.push("sanhuoai");
        std::fs::create_dir_all(&p).ok();
        p.to_string_lossy().to_string()
    };

    let db = Database::new(&data_dir).expect("Failed to initialize database");

    let state = AppState {
        db,
        agent_process: Mutex::new(None),
        data_dir,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            get_data_dir,
            agent_status,
            start_agent,
            stop_agent,
            restart_agent,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.state::<AppState>().data_dir.clone();

            // Auto-start the Python agent service
            std::thread::spawn({
                let handle = handle.clone();
                move || {
                    if let Some(child) = spawn_agent(&handle, &data_dir) {
                        let state = handle.state::<AppState>();
                        let mut proc = state.agent_process.lock().unwrap();
                        *proc = Some(child);
                    }
                }
            });

            // Start watchdog for auto-restart
            start_watchdog(handle);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                let mut proc = state.agent_process.lock().unwrap();
                if let Some(child) = proc.take() {
                    kill_process_tree(child);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
