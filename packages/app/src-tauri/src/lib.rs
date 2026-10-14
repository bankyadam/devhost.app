//! Thin shell around the system `ssh`: the app has no server component and no credentials of its
//! own. Every operation is `ssh <host> devhost <command> --json` over a multiplexed connection.
//! Anything security-relevant (quoting, validation) is in `devhost-core` and unit-tested there.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use devhost_core::{
    control_path, remote_command, ssh_args, terminal_command, terminal_script, tray_title, validate_devhost_args,
    is_safari_web_app, valid_icon_png, validate_claude_url, validate_url, vscode_args, web_app_icon_path,
    web_app_path_named, LineBuffer, TerminalAction,
    TrayStatus,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

const SSH: &str = "/usr/bin/ssh";
const TRAY_ID: &str = "devhost";
const CLAUDE_CODE_URL: &str = "https://claude.ai/code";

#[derive(Default)]
struct Streams(Mutex<HashMap<String, StreamHandle>>);

struct StreamHandle {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Set when the user cancelled, so the end is reported as 130 (cancelled) rather than a lost connection.
    cancelled: bool,
}

#[derive(Serialize)]
struct RunOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
struct LineEvent {
    id: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: String,
    code: i32,
}

fn home() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME is not set".to_string())
}

fn ssh_command(host: &str, args: &[String], tty: bool) -> Result<Command, String> {
    validate_devhost_args(args)?;
    let ssh = ssh_args(host, &control_path(&home()?), &remote_command(args), tty)?;
    let mut cmd = Command::new(SSH);
    cmd.args(ssh);
    Ok(cmd)
}

/// `devhost <args>` on the host, output captured. A transport failure is exit code 255 (ssh's own).
#[tauri::command]
async fn ssh_run(host: String, args: Vec<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<RunOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = ssh_command(&host, &args, false)?;
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("could not start ssh: {e}"))?;

        if let Some(mut pipe) = child.stdin.take() {
            if let Some(text) = stdin {
                let _ = pipe.write_all(text.as_bytes());
            }
            // Dropping the pipe closes stdin so the remote command sees EOF.
        }
        let mut out = child.stdout.take().ok_or("no stdout")?;
        let mut err = child.stderr.take().ok_or("no stderr")?;
        let t_out = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = out.read_to_end(&mut s);
            s
        });
        let t_err = std::thread::spawn(move || {
            let mut s = Vec::new();
            let _ = err.read_to_end(&mut s);
            s
        });

        let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(120_000));
        let code = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status.code().unwrap_or(255),
                None if Instant::now() > deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break 124;
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        Ok(RunOutput {
            code,
            stdout: String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned(),
            stderr: String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start a long-running command; every stdout line becomes an `ssh-line` event, the end an `ssh-exit`.
#[tauri::command]
fn ssh_stream_start(app: AppHandle, streams: State<Streams>, id: String, host: String, args: Vec<String>) -> Result<(), String> {
    let mut cmd = ssh_command(&host, &args, false)?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("could not start ssh: {e}"))?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    streams.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), StreamHandle { child, stdin, cancelled: false });

    std::thread::spawn(move || {
        let mut buf = LineBuffer::default();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for line in buf.push(&chunk[..n]) {
                        let _ = app.emit("ssh-line", LineEvent { id: id.clone(), line });
                    }
                }
            }
        }
        if let Some(line) = buf.finish() {
            let _ = app.emit("ssh-line", LineEvent { id: id.clone(), line });
        }
        let code = app
            .state::<Streams>()
            .0
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&id))
            .map(|mut h| {
                let status = h.child.wait().ok().and_then(|s| s.code());
                if h.cancelled { 130 } else { status.unwrap_or(255) }
            })
            .unwrap_or(255);
        let _ = app.emit("ssh-exit", ExitEvent { id, code });
    });
    Ok(())
}

/// One line to the running command's stdin (prompt answers). Secrets never go on command lines.
#[tauri::command]
fn ssh_stream_write(streams: State<Streams>, id: String, line: String) -> Result<(), String> {
    let mut map = streams.0.lock().map_err(|e| e.to_string())?;
    let handle = map.get_mut(&id).ok_or("no such stream")?;
    let stdin = handle.stdin.as_mut().ok_or("stdin is closed")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}

/// Cancel: SIGINT-like. Closing stdin and killing ssh ends the remote command; devhost steps are safe to re-run.
#[tauri::command]
fn ssh_stream_kill(streams: State<Streams>, id: String) -> Result<(), String> {
    if let Some(handle) = streams.0.lock().map_err(|e| e.to_string())?.get_mut(&id) {
        handle.cancelled = true;
        handle.stdin.take();
        let _ = handle.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    validate_url(&url)?;
    Command::new("/usr/bin/open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TerminalRequest {
    Devhost { args: Vec<String> },
    Shell { dir: String },
    Resume { dir: String, session_id: String },
}

/// Open Terminal.app on `ssh -t host ...`; used where a human must type (sudo password) or attach.
#[tauri::command]
fn open_terminal(host: String, action: TerminalRequest) -> Result<(), String> {
    let action = match action {
        TerminalRequest::Devhost { args } => TerminalAction::Devhost(args),
        TerminalRequest::Shell { dir } => TerminalAction::Shell { dir },
        TerminalRequest::Resume { dir, session_id } => TerminalAction::Resume { dir, session_id },
    };
    let script = terminal_script(&terminal_command(&host, &action)?);
    Command::new("/usr/bin/osascript").arg("-e").arg(script).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn code_cli() -> Option<String> {
    ["/usr/local/bin/code", "/opt/homebrew/bin/code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
}

#[derive(Serialize)]
struct Tools {
    code: bool,
    iterm: bool,
}

/// Optional integrations are detected at runtime and hidden when missing.
#[tauri::command]
fn detect_tools() -> Tools {
    Tools { code: code_cli().is_some(), iterm: std::path::Path::new("/Applications/iTerm.app").exists() }
}

#[tauri::command]
fn open_vscode(host: String, path: String) -> Result<(), String> {
    let code = code_cli().ok_or("VS Code's `code` command was not found")?;
    Command::new(code).args(vscode_args(&host, &path)?).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Names of the Safari web apps in ~/Applications (Add to Dock puts them there, under any name).
#[tauri::command]
fn list_web_apps() -> Result<Vec<String>, String> {
    let dir = std::path::Path::new(&home()?).join("Applications");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().strip_suffix(".app")?.to_string();
            let plist = std::fs::read(e.path().join("Contents/Info.plist")).ok()?;
            is_safari_web_app(&plist).then_some(name)
        })
        .collect();
    names.sort();
    Ok(names)
}

/// First half of "Add to Dock", the part Safari lets us do: save the generated icon, open
/// claude.ai/code in Safari and show the icon in Finder so it can be dragged onto Safari's dialog.
/// Returns where the icon was saved.
#[tauri::command]
fn setup_web_app(app: AppHandle, account: String, png: Vec<u8>) -> Result<String, String> {
    valid_icon_png(&png)?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let icon = web_app_icon_path(&data_dir.to_string_lossy(), &account)?;
    if let Some(dir) = std::path::Path::new(&icon).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&icon, &png).map_err(|e| e.to_string())?;
    Command::new("/usr/bin/open").args(["-a", "Safari", CLAUDE_CODE_URL]).spawn().map_err(|e| e.to_string())?;
    Command::new("/usr/bin/open").args(["-R", &icon]).spawn().map_err(|e| e.to_string())?;
    Ok(icon)
}

/// Open a web app, optionally on a claude.ai page (a Remote Control environment).
#[tauri::command]
fn open_web_app(name: String, url: Option<String>) -> Result<(), String> {
    let path = web_app_path_named(&home()?, &name)?;
    let plist = std::fs::read(std::path::Path::new(&path).join("Contents/Info.plist")).map_err(|_| format!("{path} does not exist"))?;
    if !is_safari_web_app(&plist) {
        return Err(format!("{path} is not a Safari web app"));
    }
    let mut cmd = Command::new("/usr/bin/open");
    cmd.args(["-a", &path]);
    if let Some(url) = url {
        validate_claude_url(&url)?;
        cmd.arg(url);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Menu bar: a status dot and the count of sessions waiting for input.
#[tauri::command]
fn set_tray(app: AppHandle, status: String, waiting: u32) -> Result<(), String> {
    let status = TrayStatus::parse(&status).ok_or("unknown status")?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_title(Some(tray_title(status, waiting))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn show_main(app: &AppHandle, screen: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(screen) = screen {
        let _ = app.emit("navigate", screen.to_string());
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(Streams::default())
        .invoke_handler(tauri::generate_handler![
            ssh_run,
            ssh_stream_start,
            ssh_stream_write,
            ssh_stream_kill,
            open_url,
            open_terminal,
            open_vscode,
            detect_tools,
            list_web_apps,
            setup_web_app,
            open_web_app,
            set_tray
        ])
        .setup(|app| {
            let menu = MenuBuilder::new(app)
                .item(&MenuItemBuilder::with_id("dashboard", "Dashboard").build(app)?)
                .item(&MenuItemBuilder::with_id("environments", "Environments").build(app)?)
                .item(&MenuItemBuilder::with_id("claude", "Open claude.ai/code").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("quit", "Quit devhost").build(app)?)
                .build()?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .title("🟡")
                .tooltip("devhost")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "dashboard" => show_main(app, Some("dashboard")),
                    "environments" => show_main(app, Some("environments")),
                    "claude" => {
                        let _ = open_url(CLAUDE_CODE_URL.into());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // Closing the window keeps the app (and the menu bar item) alive.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running devhost desktop");
}
