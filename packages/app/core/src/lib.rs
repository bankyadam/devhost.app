//! Everything the desktop shell does that can go wrong in a security-relevant way lives here,
//! without any GUI dependency, so `cargo test` covers it on every platform.
//!
//! The webview is not trusted with arbitrary commands: it can only ask for `devhost <known
//! subcommand> ...` on the configured host, a few fixed Terminal actions, and http(s) URLs.

/// Non-interactive ssh shells have a minimal PATH. `bootstrap.sh` links the CLI into the Homebrew
/// prefix (/opt/homebrew on Apple Silicon, /usr/local on Intel), and its `#!/usr/bin/env node`
/// needs Homebrew's node, so `devhost` runs through `env` with a fixed PATH covering both.
pub const DEVHOST_PATH_ENV: &str = "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// `devhost` subcommands the app may run (everything else is refused).
pub const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "version", "status", "doctor", "apply", "account", "env", "login", "config", "dash", "collector",
    "notify", "uninstall",
];

/// POSIX single-quote a string so a remote shell sees it as one literal word.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A host as accepted by ssh: a name from ~/.ssh/config, a DNS name (MagicDNS), `user@host`, or an
/// IP. Never something ssh could read as an option or something with whitespace.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || "._@:-[]".contains(c))
}

/// Check the arguments of a `devhost` call coming from the webview.
pub fn validate_devhost_args(args: &[String]) -> Result<(), String> {
    let first = args.first().ok_or("no devhost command given")?;
    if !ALLOWED_SUBCOMMANDS.contains(&first.as_str()) {
        return Err(format!("`{first}` is not a devhost command the app may run"));
    }
    if args.iter().any(|a| a.contains('\0')) {
        return Err("arguments must not contain NUL".into());
    }
    Ok(())
}

/// The command string sent to the remote shell: `/usr/bin/env PATH=... devhost 'arg' ...`.
pub fn remote_command(args: &[String]) -> String {
    let mut parts = vec!["/usr/bin/env".to_string(), shell_quote(DEVHOST_PATH_ENV), "devhost".to_string()];
    parts.extend(args.iter().map(|a| shell_quote(a)));
    parts.join(" ")
}

/// Arguments for the system `ssh`: one multiplexed connection per host (ControlMaster) so each
/// call after the first is fast, no prompts (keys/agent only), fail fast when the host is down.
pub fn ssh_args(host: &str, control_path: &str, remote: &str, tty: bool) -> Result<Vec<String>, String> {
    if !valid_host(host) {
        return Err(format!("`{host}` is not a valid host name"));
    }
    let mut v: Vec<String> = [
        "-o", "ControlMaster=auto",
        "-o", "ControlPersist=10m",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    v.push("-o".into());
    v.push(format!("ControlPath={control_path}"));
    v.push(if tty { "-tt" } else { "-T" }.into());
    v.push("--".into());
    v.push(host.into());
    v.push(remote.into());
    Ok(v)
}

/// Where the shared ssh connection socket lives. `%C` is ssh's hash of host/port/user, which also
/// keeps the path short enough for a unix socket.
pub fn control_path(home: &str) -> String {
    format!("{home}/.ssh/devhost-%C")
}

/// Fixed things the app may open in Terminal.app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalAction {
    /// `devhost <args>` interactively (sudo prompts, `apply` in a real terminal).
    Devhost(Vec<String>),
    /// A login shell in a project directory.
    Shell { dir: String },
    /// `claude --resume <id>` in a project directory, with the account's environment from direnv.
    Resume { dir: String, session_id: String },
}

fn valid_dir(dir: &str) -> bool {
    dir.starts_with('/') && !dir.contains("..") && dir.chars().all(|c| !c.is_control())
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl TerminalAction {
    /// The remote command line to run after `ssh -t host`.
    pub fn remote(&self) -> Result<String, String> {
        match self {
            TerminalAction::Devhost(args) => {
                validate_devhost_args(args)?;
                Ok(remote_command(args))
            }
            TerminalAction::Shell { dir } => {
                if !valid_dir(dir) {
                    return Err("invalid directory".into());
                }
                let inner = format!("cd {} && exec zsh -l", shell_quote(dir));
                Ok(format!("exec /bin/zsh -lic {}", shell_quote(&inner)))
            }
            TerminalAction::Resume { dir, session_id } => {
                if !valid_dir(dir) || !valid_session_id(session_id) {
                    return Err("invalid directory or session id".into());
                }
                let inner = format!("cd {} && direnv exec . claude --resume {}", shell_quote(dir), shell_quote(session_id));
                Ok(format!("exec /bin/zsh -lic {}", shell_quote(&inner)))
            }
        }
    }
}

/// The command typed into Terminal: `ssh -t -- host '<remote>'`.
pub fn terminal_command(host: &str, action: &TerminalAction) -> Result<String, String> {
    if !valid_host(host) {
        return Err(format!("`{host}` is not a valid host name"));
    }
    Ok(format!("ssh -t -- {} {}", shell_quote(host), shell_quote(&action.remote()?)))
}

/// Escape for the inside of an AppleScript string literal.
pub fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// AppleScript that opens a new Terminal window running `command`.
pub fn terminal_script(command: &str) -> String {
    format!(
        "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
        applescript_escape(command)
    )
}

/// Only http(s) URLs without whitespace or control characters are opened.
pub fn validate_url(url: &str) -> Result<(), String> {
    let ok_scheme = url.starts_with("https://") || url.starts_with("http://");
    if ok_scheme && !url.chars().any(|c| c.is_whitespace() || c.is_control()) && url.len() <= 2048 {
        Ok(())
    } else {
        Err("only http(s) URLs are opened".into())
    }
}

/// Arguments for `code` to open a path on the host over Remote-SSH.
pub fn vscode_args(host: &str, path: &str) -> Result<Vec<String>, String> {
    if !valid_host(host) || !valid_dir(path) {
        return Err("invalid host or path".into());
    }
    Ok(vec!["--remote".into(), format!("ssh-remote+{host}"), path.into()])
}

/// An account name as the CLI accepts it (`commands-accounts.ts`). It ends up in file names on
/// this Mac, so nothing else gets through.
pub fn valid_account(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Name of the account's Safari web app (Safari → File → Add to Dock). Each web app has its own
/// cookies, so one per account keeps several claude.ai logins open side by side.
pub fn web_app_name(account: &str) -> Result<String, String> {
    if !valid_account(account) {
        return Err(format!("`{account}` is not a valid account name"));
    }
    Ok(format!("Claude – {account}"))
}

/// Where Safari puts that web app.
pub fn web_app_path(home: &str, account: &str) -> Result<String, String> {
    Ok(format!("{home}/Applications/{}.app", web_app_name(account)?))
}

/// A web app the user named themselves (Add to Dock takes any name): one file name in
/// ~/Applications, never a path out of it.
pub fn web_app_path_named(home: &str, name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.chars().any(|c| c == '/' || c == ':' || c.is_control());
    if !ok {
        return Err(format!("`{name}` is not a web app name"));
    }
    Ok(format!("{home}/Applications/{name}.app"))
}

/// Safari's web apps are template apps with this bundle identifier prefix in their Info.plist
/// (XML or binary, the string is stored as is).
pub fn is_safari_web_app(info_plist: &[u8]) -> bool {
    info_plist.windows(24).any(|w| w == b"com.apple.Safari.WebApp.")
}

/// Only claude.ai pages are handed to a web app.
pub fn validate_claude_url(url: &str) -> Result<(), String> {
    validate_url(url)?;
    if url.starts_with("https://claude.ai/") { Ok(()) } else { Err("only claude.ai links open in a web app".into()) }
}

/// Where the app saves the generated icon offered for that web app.
pub fn web_app_icon_path(data_dir: &str, account: &str) -> Result<String, String> {
    Ok(format!("{data_dir}/web-app-icons/{}.png", web_app_name(account)?))
}

/// Largest icon the webview may hand over; a 1024px PNG of the generated tile is far below it.
pub const MAX_ICON_BYTES: usize = 4 * 1024 * 1024;

/// The generated icon is written to disk as-is, so it must at least be a PNG of sane size.
pub fn valid_icon_png(bytes: &[u8]) -> Result<(), String> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() > MAX_ICON_BYTES {
        return Err("the icon is too large".into());
    }
    if !bytes.starts_with(SIGNATURE) || bytes.len() <= SIGNATURE.len() {
        return Err("the icon is not a PNG".into());
    }
    Ok(())
}

/// Status of the menu bar item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayStatus {
    Green,
    Yellow,
    Red,
}

impl TrayStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "green" => Some(Self::Green),
            "yellow" => Some(Self::Yellow),
            "red" => Some(Self::Red),
            _ => None,
        }
    }
}

/// Menu bar text: a status dot and the number of sessions waiting for input.
pub fn tray_title(status: TrayStatus, waiting: u32) -> String {
    let dot = match status {
        TrayStatus::Green => "🟢",
        TrayStatus::Yellow => "🟡",
        TrayStatus::Red => "🔴",
    };
    if waiting > 0 { format!("{dot} {waiting}") } else { dot.to_string() }
}

/// Splits a byte stream into lines, keeping a partial line until its newline arrives.
#[derive(Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(i) = self.pending.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=i).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    /// The last line when the stream ended without a trailing newline.
    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let s = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn quoting_keeps_safe_words_and_protects_the_rest() {
        assert_eq!(shell_quote("env"), "env");
        assert_eq!(shell_quote("/opt/homebrew/bin/devhost"), "/opt/homebrew/bin/devhost");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote("a;b"), "'a;b'");
        assert_eq!(shell_quote("--flag=1"), "--flag=1");
    }

    #[test]
    fn hosts_cannot_become_ssh_options() {
        assert!(valid_host("macmini"));
        assert!(valid_host("macmini.tail1234.ts.net"));
        assert!(valid_host("adam@100.64.0.7"));
        assert!(valid_host("[fd7a::1]"));
        assert!(!valid_host(""));
        assert!(!valid_host("-oProxyCommand=evil"));
        assert!(!valid_host("a b"));
        assert!(!valid_host("host;rm"));
        assert!(!valid_host("host\nname"));
        assert!(!valid_host(&"a".repeat(300)));
    }

    #[test]
    fn only_known_devhost_subcommands_are_allowed() {
        assert!(validate_devhost_args(&v(&["env", "list", "--json"])).is_ok());
        assert!(validate_devhost_args(&v(&["config", "put"])).is_ok());
        assert!(validate_devhost_args(&[]).is_err());
        assert!(validate_devhost_args(&v(&["rm", "-rf", "/"])).is_err());
        assert!(validate_devhost_args(&v(&["--json", "version"])).is_err());
        assert!(validate_devhost_args(&v(&["env", "a\0b"])).is_err());
    }

    #[test]
    fn remote_command_quotes_every_argument() {
        let cmd = remote_command(&v(&["env", "create", "--name", "x y", "--repo", "git@github.com:a/b.git; rm -rf ~"]));
        assert_eq!(
            cmd,
            "/usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin devhost env create --name 'x y' --repo 'git@github.com:a/b.git; rm -rf ~'"
        );
    }

    #[test]
    fn ssh_args_multiplex_and_never_prompt() {
        let a = ssh_args("macmini", "/Users/me/.ssh/devhost-%C", "/usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin devhost version --json", false).unwrap();
        let joined = a.join(" ");
        for must in ["ControlMaster=auto", "ControlPersist=10m", "BatchMode=yes", "ConnectTimeout=5", "ControlPath=/Users/me/.ssh/devhost-%C", "-T"] {
            assert!(joined.contains(must), "{must} missing in {joined}");
        }
        // Host comes after `--` so it can never be parsed as an option.
        let dashdash = a.iter().position(|x| x == "--").unwrap();
        assert_eq!(a[dashdash + 1], "macmini");
        assert_eq!(a.last().unwrap(), "/usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin devhost version --json");
        assert!(ssh_args("-oProxyCommand=x", "/p", "r", false).is_err());
        assert!(ssh_args("h", "/p", "r", true).unwrap().contains(&"-tt".to_string()));
    }

    #[test]
    fn terminal_actions_are_fixed_and_validated() {
        let apply = TerminalAction::Devhost(v(&["apply"]));
        assert_eq!(terminal_command("macmini", &apply).unwrap(), "ssh -t -- macmini '/usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin devhost apply'");
        assert!(terminal_command("macmini", &TerminalAction::Devhost(v(&["bash"]))).is_err());
        assert!(terminal_command("-bad", &apply).is_err());

        let shell = TerminalAction::Shell { dir: "/Users/me/work/b/acme api".into() };
        let r = shell.remote().unwrap();
        assert!(r.starts_with("exec /bin/zsh -lic "));
        assert!(r.contains("acme api"));
        assert!(TerminalAction::Shell { dir: "relative".into() }.remote().is_err());
        assert!(TerminalAction::Shell { dir: "/a/../etc".into() }.remote().is_err());

        let resume = TerminalAction::Resume { dir: "/Users/me/work/b/x".into(), session_id: "abc-123".into() };
        assert!(resume.remote().unwrap().contains("direnv exec . claude --resume abc-123"));
        assert!(TerminalAction::Resume { dir: "/x".into(), session_id: "a; rm".into() }.remote().is_err());
    }

    #[test]
    fn a_hostile_directory_cannot_break_out_of_the_quotes() {
        let a = TerminalAction::Shell { dir: "/tmp/it's $(id)".into() };
        let line = terminal_command("macmini", &a).unwrap();
        // Two nested quoting levels: the dangerous text only ever appears inside quotes.
        assert!(!line.contains("it's $(id)"));
        assert!(line.starts_with("ssh -t -- macmini "));
    }

    #[test]
    fn applescript_strings_are_escaped() {
        let s = terminal_script(r#"ssh -t -- h 'say "hi" \ done'"#);
        assert!(s.contains(r#"do script "ssh -t -- h 'say \"hi\" \\ done'""#));
        assert!(s.starts_with("tell application \"Terminal\""));
    }

    #[test]
    fn only_http_urls_are_opened() {
        assert!(validate_url("https://claude.ai/code").is_ok());
        assert!(validate_url("http://macmini:3000").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("https://a.b/x y").is_err());
        assert!(validate_url("-a Calculator").is_err());
    }

    #[test]
    fn vscode_remote_args() {
        assert_eq!(vscode_args("macmini", "/Users/me/work/b/x").unwrap(), v(&["--remote", "ssh-remote+macmini", "/Users/me/work/b/x"]));
        assert!(vscode_args("macmini", "x").is_err());
        assert!(vscode_args("-bad", "/x").is_err());
    }

    #[test]
    fn web_app_paths_only_take_account_names() {
        assert!(valid_account("business"));
        assert!(valid_account("a-1"));
        assert!(valid_account(&format!("a{}", "b".repeat(31))));
        for bad in ["", "1a", "-a", "Work", "a b", "a/b", "../x", "a.b", &"a".repeat(33)] {
            assert!(!valid_account(bad), "{bad:?} accepted");
        }
        assert_eq!(web_app_name("business").unwrap(), "Claude – business");
        assert_eq!(web_app_path("/Users/me", "business").unwrap(), "/Users/me/Applications/Claude – business.app");
        assert_eq!(
            web_app_icon_path("/Users/me/Library/Application Support/app.devhost.desktop", "personal").unwrap(),
            "/Users/me/Library/Application Support/app.devhost.desktop/web-app-icons/Claude – personal.png"
        );
        assert!(web_app_path("/Users/me", "../../etc").is_err());
        assert!(web_app_icon_path("/d", "a/b").is_err());
    }

    #[test]
    fn named_web_apps_stay_in_applications() {
        assert_eq!(web_app_path_named("/Users/me", "Claude - Stylers").unwrap(), "/Users/me/Applications/Claude - Stylers.app");
        for bad in ["", "../x", "a/b", ".hidden", "a:b", "a\nb"] {
            assert!(web_app_path_named("/Users/me", bad).is_err(), "{bad:?} accepted");
        }
        assert!(is_safari_web_app(b"<key>CFBundleIdentifier</key><string>com.apple.Safari.WebApp.04FDAF15</string>"));
        assert!(!is_safari_web_app(b"<string>com.anthropic.claudefordesktop</string>"));
        assert!(validate_claude_url("https://claude.ai/code?environment=env_01Bd").is_ok());
        assert!(validate_claude_url("https://claude.ai.evil.com/x").is_err());
        assert!(validate_claude_url("http://claude.ai/code").is_err());
    }

    #[test]
    fn icons_must_be_png() {
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[0u8; 16]].concat();
        assert!(valid_icon_png(&png).is_ok());
        assert!(valid_icon_png(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(valid_icon_png(b"<svg/>").is_err());
        assert!(valid_icon_png(&[]).is_err());
        let huge = [png.as_slice(), &vec![0u8; MAX_ICON_BYTES]].concat();
        assert!(valid_icon_png(&huge).is_err());
    }

    #[test]
    fn tray_title_shows_dot_and_waiting_count() {
        assert_eq!(tray_title(TrayStatus::Green, 0), "🟢");
        assert_eq!(tray_title(TrayStatus::Yellow, 2), "🟡 2");
        assert_eq!(tray_title(TrayStatus::Red, 1), "🔴 1");
        assert_eq!(TrayStatus::parse("red"), Some(TrayStatus::Red));
        assert_eq!(TrayStatus::parse("blue"), None);
    }

    #[test]
    fn line_buffer_handles_partial_chunks_and_crlf() {
        let mut b = LineBuffer::default();
        assert!(b.push(b"{\"a\":").is_empty());
        assert_eq!(b.push(b"1}\n{\"b\":2}\r\nrest"), vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert_eq!(b.finish(), Some("rest".to_string()));
        assert_eq!(b.finish(), None);
        // A multi-byte character split across chunks survives.
        let mut b = LineBuffer::default();
        let bytes = "é\n".as_bytes();
        assert!(b.push(&bytes[..1]).is_empty());
        assert_eq!(b.push(&bytes[1..]), vec!["é".to_string()]);
    }

    #[test]
    fn control_path_is_short_and_per_connection() {
        assert_eq!(control_path("/Users/me"), "/Users/me/.ssh/devhost-%C");
    }
}
