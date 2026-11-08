//! "Start Codeman on this Mac": `codeman web -d` through the user's login shell.
//! The same login-shell machinery answers whether Codeman is installed
//! (`installed`) and hands its environment to the graphical install
//! (`login_environment`); `exec_bounded` is the crate's bounded process runner.
//!
//! A double-clicked app gets launchd's bare PATH (`/usr/bin:/bin:...`), which
//! finds neither `codeman` nor `node`, and the server inherits whatever
//! environment it is started with: every session it spawns looks for
//! claude/codex/tmux on that PATH and reads provider keys from it. So the
//! command runs with the login shell's environment, picking up Homebrew and the
//! user's profile, and falls back to the interactive profile (`-i`) for setups
//! that only extend PATH there (nvm in `.zshrc`). The URL's port and base path
//! are passed as separate arguments (`"$@"`), never spliced into the script text.
//!
//! How depends on the shell, chosen by its basename as Codeman's own
//! `src/utils/shell-resolver.ts` does:
//! - A POSIX shell (zsh, bash, sh, ...) runs `SCRIPT` itself:
//!   `$SHELL -l [-i] -c SCRIPT codeman-desktop <args>`.
//! - Any other shell (fish, nu, xonsh, elvish, pwsh, tcsh) cannot parse
//!   `SCRIPT`: fish has no `then`/`fi` and refuses `$@`. It is only asked to
//!   print its environment between two markers, and `SCRIPT` then runs under
//!   `/bin/sh` with exactly that environment.
//!
//! `codeman web -d` refuses to start a second server on the same data dir and
//! returns once the new one answers `/api/status`, so this is safe to call
//! only after the probe found nothing listening.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use url::Url;

use crate::policy;

/// For the whole start, every shell run and retry included.
const TIMEOUT: Duration = Duration::from_secs(60);

/// How long the pipes may stay open after the shell exited. Something the
/// profile started in the background can inherit them and keep them open for
/// as long as it runs; whatever arrived by then is used.
const PIPE_GRACE: Duration = Duration::from_secs(2);

/// Found on PATH first, then the `install.sh` clone at `~/.codeman/app`.
const SCRIPT: &str = r#"if command -v codeman >/dev/null 2>&1; then exec codeman "$@"; fi
if [ -f "$HOME/.codeman/app/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  exec node "$HOME/.codeman/app/dist/index.js" "$@"
fi
echo "Could not find the codeman command or ~/.codeman/app. Install Codeman first: https://github.com/Ark0N/Codeman#install" >&2
exit 127"#;

/// Bracket the environment a non-POSIX login shell prints, so whatever its
/// profile writes to stdout before or after cannot be read as a variable.
const ENV_BEGIN: &str = "__CODEMAN_DESKTOP_ENV_BEGIN__";
const ENV_END: &str = "__CODEMAN_DESKTOP_ENV_END__";

/// What a non-POSIX login shell runs to report its environment. The shell
/// itself only parses a command path and one single-quoted word with no `;`,
/// `$`, backslash or `!` in it, so fish, nu, xonsh, elvish, pwsh and tcsh have
/// no syntax of their own to disagree on. The markers and `env` run under
/// `/bin/sh`, which inherits everything the profile exported.
fn capture_command() -> String {
    format!("/bin/sh -c 'echo {ENV_BEGIN}; /usr/bin/env; echo {ENV_END}'")
}

fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.exists())
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

/// How the login shell takes part in a start.
#[derive(Debug, PartialEq, Eq)]
enum Flavor {
    /// Runs `SCRIPT` itself.
    Posix,
    /// Only reports its environment. One entry per attempt, in order: a later
    /// one runs when the earlier one printed no environment or its environment
    /// had no `codeman` (exit 127).
    Capture(&'static [&'static [&'static str]]),
}

fn flavor(shell: &Path) -> Flavor {
    match shell.file_name().and_then(|n| n.to_str()).unwrap_or("") {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "ash" | "ksh93" | "mksh" | "pdksh" => Flavor::Posix,
        // tcsh honors -l only when it is the ONLY flag, so a login shell that
        // also runs a command is impossible; -i at least reads all of .tcshrc
        // (csh: .cshrc), including the parts guarded by `$?prompt`.
        "csh" | "tcsh" => Flavor::Capture(&[&["-ic"]]),
        _ => Flavor::Capture(&[&["-l", "-c"], &["-l", "-i", "-c"]]),
    }
}

/// What one process printed, stdout and stderr kept apart.
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// What `codeman` (or `SCRIPT` failing to find it) said, for the connect page.
struct Run {
    code: Option<i32>,
    output: String,
}

impl From<Output> for Run {
    fn from(out: Output) -> Self {
        let mut output = out.stdout;
        if !out.stderr.trim().is_empty() {
            // On a line of its own, also when stdout ended without a newline.
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&out.stderr);
        }
        Run {
            code: out.code,
            output: last_lines(&output, 6),
        }
    }
}

/// Copy `pipe` into the channel as it arrives, tagged with `stream`, then send
/// `None` once it closes.
fn pump<R: Read + Send + 'static>(pipe: Option<R>, stream: usize, tx: mpsc::Sender<(usize, Option<Vec<u8>>)>) {
    std::thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send((stream, Some(buf[..n].to_vec()))).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
        let _ = tx.send((stream, None));
    });
}

/// `exec_bounded` with the start's timeout message. The installed check and
/// `login_environment` run through it too, and drop its error.
fn exec(cmd: Command, deadline: Instant) -> Result<Output, String> {
    exec_bounded(
        cmd,
        deadline,
        "Starting Codeman took longer than a minute; it was stopped.",
    )
}

/// Run `cmd` to completion with stdin closed, or kill it at `deadline` and
/// answer `timed_out`.
pub fn exec_bounded(mut cmd: Command, deadline: Instant, timed_out: &str) -> Result<Output, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not run {}: {e}", Path::new(cmd.get_program()).display()))?;

    // Read both pipes on threads so a chatty profile cannot fill one and stall.
    let (tx, rx) = mpsc::channel();
    pump(child.stdout.take(), 0, tx.clone());
    pump(child.stderr.take(), 1, tx);

    // A login shell usually answers within tens of milliseconds: look often
    // at first, then back off.
    let mut nap = Duration::from_millis(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(nap);
                nap = (nap * 2).min(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timed_out.to_string());
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    let mut bufs = [Vec::new(), Vec::new()];
    let settle = (Instant::now() + PIPE_GRACE).min(deadline);
    let mut open = 2;
    while open > 0 {
        match rx.recv_timeout(settle.saturating_duration_since(Instant::now())) {
            Ok((stream, Some(bytes))) => bufs[stream].extend_from_slice(&bytes),
            Ok((_, None)) => open -= 1,
            Err(_) => {
                // Still held open past the grace: keep what already arrived.
                for (stream, bytes) in rx.try_iter() {
                    if let Some(bytes) = bytes {
                        bufs[stream].extend_from_slice(&bytes);
                    }
                }
                break;
            }
        }
    }
    // Lossy rather than strict: one stray non-UTF-8 byte in a profile's output
    // must not cost the whole environment.
    let [out, err] = bufs;
    Ok(Output {
        code: status.code(),
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
    })
}

/// The tail of what the command printed, for the connect page.
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// The variables `env` printed between the markers, or None when the output
/// does not hold both. A line that does not start with a portable variable
/// name followed by `=` continues the previous value (a value with a newline
/// in it); one that does starts the next variable.
fn parse_env(output: &str) -> Option<Vec<(String, String)>> {
    let mut lines = output.split('\n');
    // ends_with: a profile line printed without its newline sits in front.
    lines.by_ref().find(|l| l.trim_end().ends_with(ENV_BEGIN))?;
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.trim() == ENV_END {
            return Some(vars);
        }
        match env_entry(line) {
            Some((name, value)) => vars.push((name.to_string(), value.to_string())),
            None => {
                if let Some((_, value)) = vars.last_mut() {
                    value.push('\n');
                    value.push_str(line);
                }
            }
        }
    }
    None
}

/// A portable variable name: a letter or `_`, then letters, digits or `_`.
pub fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn env_entry(line: &str) -> Option<(&str, &str)> {
    let (name, value) = line.split_once('=')?;
    is_env_name(name).then_some((name, value))
}

/// Ask `shell` for its environment with `flags`. The outer error ends the
/// start (the shell could not be run, or time is up); the inner one means this
/// form printed no environment and the next may be tried.
fn capture_env(
    shell: &Path,
    flags: &[&str],
    deadline: Instant,
) -> Result<Result<Vec<(String, String)>, String>, String> {
    let mut cmd = Command::new(shell);
    cmd.args(flags).arg(capture_command());
    let out = exec(cmd, deadline)?;
    Ok(parse_env(&out.stdout).ok_or_else(|| {
        // stderr only: stdout can hold part of the environment, API keys included.
        let said = last_lines(&out.stderr, 6);
        let mut message = format!("Could not read the environment of your login shell {}", shell.display());
        if said.is_empty() {
            let code = out
                .code
                .map_or_else(|| "a signal".to_string(), |c| format!("exit code {c}"));
            message.push_str(&format!(" (it ended with {code})."));
        } else {
            message.push_str(":\n");
            message.push_str(&said);
        }
        message
    }))
}

/// The login shell's environment, for a process the app runs without it (the
/// graphical install). `None` when the shell reports none.
pub fn login_environment() -> Option<Vec<(String, String)>> {
    let shell = login_shell();
    let flags: &[&str] = match flavor(&shell) {
        Flavor::Posix => &["-l", "-c"],
        Flavor::Capture(attempts) => attempts.first().copied().unwrap_or(&["-c"]),
    };
    capture_env(&shell, flags, Instant::now() + FIND_TIMEOUT).ok()?.ok()
}

/// Run `cmd` in the home folder, where a terminal and the LaunchAgent start
/// Codeman too. The server keeps the directory it was started in and uses it
/// as the default for a session that names none; an app opened from the Finder
/// or the Dock runs in `/`.
fn in_home(cmd: &mut Command) {
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
}

/// `script` (SCRIPT or FIND_SCRIPT) under `/bin/sh` with exactly the captured
/// environment, so the server gets the profile's PATH, API keys and CODEMAN_*
/// settings and nothing of launchd's bare one.
fn run_with_env(script: &str, env: &[(String, String)], args: &[String], deadline: Instant) -> Result<Run, String> {
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(script).arg("codeman-desktop").args(args);
    cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    in_home(&mut cmd);
    exec(cmd, deadline).map(Run::from)
}

/// `script` run by the POSIX login shell itself.
fn run_in_shell(
    script: &str,
    shell: &Path,
    interactive: bool,
    args: &[String],
    deadline: Instant,
) -> Result<Run, String> {
    let mut cmd = Command::new(shell);
    cmd.arg("-l");
    if interactive {
        cmd.arg("-i");
    }
    cmd.arg("-c").arg(script).arg("codeman-desktop").args(args);
    in_home(&mut cmd);
    exec(cmd, deadline).map(Run::from)
}

/// Run `script` the way the login shell allows (see the module docs). Exit
/// 127 means "no codeman here" and moves on to the next way of asking; the
/// interactive profile is asked only when `interactive` allows it.
fn launch(script: &str, shell: &Path, args: &[String], deadline: Instant, interactive: bool) -> Result<Run, String> {
    let Flavor::Capture(attempts) = flavor(shell) else {
        let result = run_in_shell(script, shell, false, args, deadline)?;
        if result.code != Some(127) || !interactive {
            return Ok(result);
        }
        // Not on the login PATH; try the interactive profile too.
        return run_in_shell(script, shell, true, args, deadline);
    };
    let mut last_run = None;
    let mut capture_error = None;
    let interactive_flag = |flags: &&&[&str]| {
        flags
            .iter()
            .any(|f| f.starts_with('-') && !f.starts_with("--") && f.contains('i'))
    };
    for flags in attempts.iter().filter(|f| interactive || !interactive_flag(f)) {
        match capture_env(shell, flags, deadline)? {
            Ok(env) => {
                let result = run_with_env(script, &env, args, deadline)?;
                if result.code != Some(127) {
                    return Ok(result);
                }
                last_run = Some(result);
            }
            Err(e) => capture_error = Some(e),
        }
    }
    if let Some(result) = last_run {
        return Ok(result);
    }
    // No form printed an environment: a shell that knows neither -l nor -i
    // may still run a bare -c.
    match capture_env(shell, &["-c"], deadline)? {
        Ok(env) => run_with_env(script, &env, args, deadline),
        Err(e) => Err(capture_error.unwrap_or(e)),
    }
}

/// Exit 0 when SCRIPT would find Codeman (the `codeman` command or the
/// `install.sh` clone), 127 when it would not. Same lookup, nothing started.
const FIND_SCRIPT: &str = r#"if command -v codeman >/dev/null 2>&1; then exit 0; fi
if [ -f "$HOME/.codeman/app/dist/index.js" ] && command -v node >/dev/null 2>&1; then exit 0; fi
exit 127"#;

/// How long one look at the login shell may take: whether Codeman is
/// installed (the This Mac tab), or its environment for the graphical install.
const FIND_TIMEOUT: Duration = Duration::from_secs(15);

/// `installed` with the shell given, so tests need not touch `$SHELL`.
fn installed_with(shell: &Path, interactive: bool) -> bool {
    matches!(
        launch(FIND_SCRIPT, shell, &[], Instant::now() + FIND_TIMEOUT, interactive),
        Ok(Run { code: Some(0), .. })
    )
}

/// Whether "Start Codeman on this Mac" would find Codeman: the `codeman`
/// command on the login shell's PATH, or `~/.codeman/app` with `node`. Runs
/// the login shell, so never on the event loop. `interactive` also asks the
/// interactive profile (nvm in `.zshrc`, say), whose side effects only a
/// user's own click should set off.
pub fn installed(interactive: bool) -> bool {
    installed_with(&login_shell(), interactive)
}

/// `start` with the shell given, so tests need not touch `$SHELL`.
fn start_with(shell: &Path, args: &[String]) -> Result<String, String> {
    let result = launch(SCRIPT, shell, args, Instant::now() + TIMEOUT, true)?;
    match result.code {
        Some(0) => Ok(result.output),
        _ if result.output.is_empty() => Err("codeman web -d failed without saying why.".into()),
        _ => Err(result.output),
    }
}

/// Start a detached server for `url`. Ok carries what `codeman` printed.
pub fn start(url: &Url) -> Result<String, String> {
    if !policy::can_start_locally(url) {
        return Err("Codeman can only be started here for http://127.0.0.1 or http://localhost on this Mac.".into());
    }
    start_with(&login_shell(), &policy::start_args(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One spawning test at a time. A test writes a fake executable and then
    /// runs it; a process forked by a parallel test in between can still hold
    /// the write descriptor, and the exec then fails with ETXTBSY.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn tail_of_output() {
        assert_eq!(last_lines("a\n\nb\nc\n", 2), "b\nc");
        assert_eq!(last_lines("", 3), "");
    }

    #[test]
    fn stderr_starts_on_a_line_of_its_own() {
        let said = |stdout: &str, stderr: &str| {
            Run::from(Output {
                code: Some(1),
                stdout: stdout.into(),
                stderr: stderr.into(),
            })
            .output
        };
        // stdout that ends without a newline: stderr still starts a line of its own.
        assert_eq!(
            said("Starting Codeman", "Error: port 3000 is in use\n"),
            "Starting Codeman\nError: port 3000 is in use"
        );
        assert_eq!(said("Starting\n", "Error\n"), "Starting\nError");
        assert_eq!(said("", "Error\n"), "Error");
        assert_eq!(said("Started\n", "  \n"), "Started");
    }

    #[test]
    fn refuses_non_local_or_https() {
        assert!(start(&Url::parse("https://127.0.0.1:3000/").unwrap()).is_err());
        assert!(start(&Url::parse("http://192.168.1.4:3000/").unwrap()).is_err());
    }

    /// The script passes its arguments through untouched and reports a missing
    /// `codeman` with exit 127 (run with an empty PATH and HOME so nothing is found).
    #[test]
    fn script_reports_missing_codeman() {
        let _serial = serial();
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(SCRIPT)
            .arg("codeman-desktop")
            .args(["web", "-d", "--port", "3000"])
            .env("PATH", "/nonexistent")
            .env("HOME", "/nonexistent")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(127));
        assert!(String::from_utf8_lossy(&out.stderr).contains("Could not find the codeman command"));
    }

    /// Arguments are data: a hostile-looking value is passed as one argv entry
    /// to a fake `codeman`, never run by the shell.
    #[test]
    fn arguments_are_not_shell_text() {
        let _serial = serial();
        let dir = std::env::temp_dir().join(format!("codeman-desktop-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("codeman");
        std::fs::write(&fake, "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(SCRIPT)
            .arg("codeman-desktop")
            .args(["web", "--base-url", "/x; touch /tmp/pwned"])
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "[web][--base-url][/x; touch /tmp/pwned]"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn pairs(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn env_capture_parser() {
        let out = format!(
            "Welcome to fish, the friendly interactive shell\nno newline here{ENV_BEGIN}\n\
             PATH=/opt/homebrew/bin:/usr/bin:/bin\n\
             MULTI=line one\nline two\n  three = 3\n\
             EMPTY=\n\
             TRAIL=a \n\n\
             _=/usr/bin/env\n\
             {ENV_END}  \nbye from the profile\nNOT_CAPTURED=1\n"
        );
        assert_eq!(
            parse_env(&out),
            Some(pairs(&[
                ("PATH", "/opt/homebrew/bin:/usr/bin:/bin"),
                ("MULTI", "line one\nline two\n  three = 3"),
                ("EMPTY", ""),
                ("TRAIL", "a \n"),
                ("_", "/usr/bin/env"),
            ]))
        );
        // A value may itself contain `=`; only the first one splits.
        assert_eq!(
            parse_env(&format!("{ENV_BEGIN}\nOPTS=a=b\n{ENV_END}\n")),
            Some(pairs(&[("OPTS", "a=b")]))
        );
        assert_eq!(parse_env(&format!("{ENV_BEGIN}\n{ENV_END}\n")), Some(vec![]));
        assert_eq!(parse_env(&format!("{ENV_BEGIN}\nPATH=/usr/bin\n")), None);
        assert_eq!(parse_env(&format!("PATH=/usr/bin\n{ENV_END}\n")), None);
        assert_eq!(parse_env("fish: Unknown command: then\n"), None);
    }

    #[test]
    fn shell_flavor_by_basename() {
        for posix in [
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh",
            "/bin/dash",
            "/bin/ksh",
            "/opt/homebrew/bin/bash",
        ] {
            assert_eq!(flavor(Path::new(posix)), Flavor::Posix, "{posix}");
        }
        assert_eq!(flavor(Path::new("/bin/tcsh")), Flavor::Capture(&[&["-ic"]]));
        assert_eq!(flavor(Path::new("/bin/csh")), Flavor::Capture(&[&["-ic"]]));
        for other in [
            "/opt/homebrew/bin/fish",
            "/usr/local/bin/nu",
            "/opt/homebrew/bin/xonsh",
            "/usr/local/bin/pwsh",
        ] {
            assert_eq!(
                flavor(Path::new(other)),
                Flavor::Capture(&[&["-l", "-c"], &["-l", "-i", "-c"]]),
                "{other}"
            );
        }
    }

    /// The login shell's part avoids everything only POSIX shells read.
    #[test]
    fn capture_command_is_shell_neutral() {
        let _serial = serial();
        let cmd = capture_command();
        for bad in ["then", "fi", "$", "\\", "!", "\"", "&&"] {
            assert!(!cmd.contains(bad), "{bad} in {cmd}");
        }
        assert_eq!(cmd.matches('\'').count(), 2);
        assert!(cmd.starts_with("/bin/sh -c '"));
        // /bin/sh, as the capture runs it, prints a parsable environment.
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .env("CODEMAN_DESKTOP_PARSER_PROBE", "two\nlines")
            .output()
            .unwrap();
        let env = parse_env(&String::from_utf8_lossy(&out.stdout)).expect("markers");
        assert!(env
            .iter()
            .any(|(k, v)| k == "CODEMAN_DESKTOP_PARSER_PROBE" && v == "two\nlines"));
        assert!(env.iter().any(|(k, _)| k == "PATH"));
    }

    /// A scratch directory with a fake `codeman` in `bin/` that prints its
    /// arguments, the profile's marker variable and the names of everything in
    /// its environment.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("codeman-desktop-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            std::fs::create_dir_all(dir.join("home")).unwrap();
            let scratch = Scratch(dir);
            scratch.exe(
                "bin/codeman",
                "#!/bin/sh\nprintf '[%s]' \"$@\"; echo\necho \"profile: $CODEMAN_DESKTOP_TEST\"\n\
                 printf 'names:'; env | cut -d= -f1 | tr '\\n' ' '; echo\n",
            );
            scratch
        }

        /// Write an executable at `rel`, with `DIR` in `body` replaced by the scratch path.
        fn exe(&self, rel: &str, body: &str) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::write(&path, body.replace("DIR", &self.0.display().to_string())).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }

        fn argv_log(&self) -> String {
            std::fs::read_to_string(self.0.join("argv.log")).unwrap_or_default()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const HOSTILE_ARGS: [&str; 3] = ["web", "--base-url", "/x; touch /tmp/pwned"];

    fn hostile_args() -> Vec<String> {
        HOSTILE_ARGS.iter().map(|s| s.to_string()).collect()
    }

    /// A stand-in for fish: it refuses POSIX `then` and `$@` the way fish
    /// does, logs its flags, prints profile noise around whatever it runs, and
    /// its "profile" replaces the environment. On its interactive form only
    /// when `INTERACTIVE_ONLY` is yes, PATH reaches the fake `codeman`.
    const FAKE_FISH: &str = r#"#!/bin/sh
args=""
for a in "$@"; do
  case "$a" in
    *then*|*'$@'*) echo "fish: Unknown command: then" >&2; exit 127;;
    -*) args="$args$a ";;
  esac
  cmd="$a"
done
echo "$args" >> "DIR/argv.log"
bin="DIR/bin"
case "INTERACTIVE_ONLY:$args" in yes:*-i*|no:*) ;; *) bin=/nonexistent;; esac
echo "Welcome to fish, the friendly interactive shell"
/usr/bin/env -i PATH="$bin:/usr/bin:/bin" HOME="DIR/home" CODEMAN_DESKTOP_TEST="from the profile" /bin/sh -c "$cmd"
echo "bye from the profile"
"#;

    /// SCRIPT never reaches the non-POSIX shell: it runs under /bin/sh with the
    /// environment the shell printed, and with nothing else.
    #[test]
    fn non_posix_shell_only_reports_its_environment() {
        let _serial = serial();
        let s = Scratch::new("fish");
        let fish = s.exe("fish", &FAKE_FISH.replace("INTERACTIVE_ONLY", "no"));
        let out = start_with(&fish, &hostile_args()).expect("started");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "[web][--base-url][/x; touch /tmp/pwned]");
        assert_eq!(lines[1], "profile: from the profile");
        assert_eq!(s.argv_log(), "-l -c \n");

        // env_clear: a variable this process has, but the profile did not
        // export, must not reach codeman.
        let names: Vec<&str> = lines[2].trim_start_matches("names:").split_whitespace().collect();
        assert!(names.contains(&"PATH") && names.contains(&"CODEMAN_DESKTOP_TEST"));
        let captured = ["PATH", "HOME", "CODEMAN_DESKTOP_TEST", "PWD", "OLDPWD", "SHLVL", "_"];
        let leaked: Vec<String> = std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .filter(|k| !captured.contains(&k.as_str()) && !k.starts_with("__CF"))
            .filter(|k| names.contains(&k.as_str()))
            .collect();
        assert!(leaked.is_empty(), "leaked from the app: {leaked:?}");
    }

    /// No codeman on the login PATH (exit 127): the environment is captured
    /// again from the interactive profile, and that run finds it.
    #[test]
    fn non_posix_shell_retries_with_the_interactive_profile() {
        let _serial = serial();
        let s = Scratch::new("fish-retry");
        let fish = s.exe("fish", &FAKE_FISH.replace("INTERACTIVE_ONLY", "yes"));
        let out = start_with(&fish, &hostile_args()).expect("started");
        assert!(out.starts_with("[web][--base-url][/x; touch /tmp/pwned]\n"), "{out}");
        assert_eq!(s.argv_log(), "-l -c \n-l -i -c \n");
    }

    /// tcsh takes -l only as its only flag, so it is asked with -ic alone.
    #[test]
    fn tcsh_gets_ic_and_never_l() {
        let _serial = serial();
        let s = Scratch::new("tcsh");
        let tcsh = s.exe(
            "tcsh",
            r#"#!/bin/sh
echo "$*" >> "DIR/argv.log"
if [ "$#" != 2 ] || [ "$1" != -ic ]; then echo "tcsh: Unknown option: $1" >&2; exit 1; fi
/usr/bin/env -i PATH="DIR/bin:/usr/bin:/bin" HOME="DIR/home" CODEMAN_DESKTOP_TEST=tcsh /bin/sh -c "$2"
"#,
        );
        let out = start_with(&tcsh, &hostile_args()).expect("started");
        assert!(out.contains("profile: tcsh"), "{out}");
        assert_eq!(s.argv_log().lines().count(), 1);
        assert!(s.argv_log().starts_with("-ic /bin/sh -c '"));
    }

    /// A shell that takes neither -l nor -i still gets a bare -c.
    #[test]
    fn shell_without_login_flags_falls_back_to_plain_c() {
        let _serial = serial();
        let s = Scratch::new("nolflag");
        let shell = s.exe(
            "elvish",
            r#"#!/bin/sh
echo "$1" >> "DIR/argv.log"
case "$1" in -l|-i) echo "flag provided but not defined: $1" >&2; exit 2;; esac
/usr/bin/env -i PATH="DIR/bin:/usr/bin:/bin" HOME="DIR/home" CODEMAN_DESKTOP_TEST=plain /bin/sh -c "$2"
"#,
        );
        let out = start_with(&shell, &hostile_args()).expect("started");
        assert!(out.contains("profile: plain"), "{out}");
        assert_eq!(s.argv_log(), "-l\n-l\n-c\n");
    }

    /// A shell that never prints its environment is reported by name with what
    /// it said on stderr, never with stdout (which can carry secrets).
    #[test]
    fn capture_failure_names_the_shell() {
        let _serial = serial();
        let s = Scratch::new("broken");
        let shell = s.exe(
            "weirdsh",
            "#!/bin/sh\necho 'API_KEY=sk-secret'\necho 'weirdsh: cannot start' >&2\nexit 3\n",
        );
        let err = start_with(&shell, &hostile_args()).unwrap_err();
        assert!(err.contains("Could not read the environment"), "{err}");
        assert!(err.contains("weirdsh: cannot start"), "{err}");
        assert!(!err.contains("sk-secret"), "{err}");
    }

    /// POSIX shells keep running SCRIPT themselves: `-l -c SCRIPT codeman-desktop
    /// args`, then `-l -i -c` when the login PATH had no codeman.
    #[test]
    fn posix_shell_runs_script_itself_and_retries_interactive() {
        let _serial = serial();
        let s = Scratch::new("zsh");
        let zsh = s.exe(
            "zsh",
            r#"#!/bin/sh
[ "$1" = -l ] || exit 90
shift
PATH=/usr/bin:/bin
if [ "$1" = -i ]; then shift; PATH="DIR/bin:/usr/bin:/bin"; fi
[ "$1" = -c ] || exit 91
shift
echo "$2" >> "DIR/argv.log"
HOME="DIR/home"
export PATH HOME
exec /bin/sh -c "$@"
"#,
        );
        let out = start_with(&zsh, &hostile_args()).expect("started");
        assert!(out.starts_with("[web][--base-url][/x; touch /tmp/pwned]\n"), "{out}");
        // $0 of the script, once per run: login, then interactive.
        assert_eq!(s.argv_log(), "codeman-desktop\ncodeman-desktop\n");
    }

    /// The installed check asks the same shells the same way and runs nothing:
    /// found on the interactive PATH here, after the login PATH had none.
    #[test]
    fn installed_check_finds_codeman_without_running_it() {
        let _serial = serial();
        let s = Scratch::new("find-zsh");
        let zsh = s.exe(
            "zsh",
            r#"#!/bin/sh
[ "$1" = -l ] || exit 90
shift
PATH=/usr/bin:/bin
if [ "$1" = -i ]; then shift; PATH="DIR/bin:/usr/bin:/bin"; fi
[ "$1" = -c ] || exit 91
shift
echo "$2" >> "DIR/argv.log"
HOME="DIR/home"
export PATH HOME
exec /bin/sh -c "$@"
"#,
        );
        // A codeman that would leave a mark if it ran.
        s.exe("bin/codeman", "#!/bin/sh\ntouch DIR/ran\n");
        // Without the interactive profile: one login-shell look, not found.
        assert!(!installed_with(&zsh, false));
        assert_eq!(s.argv_log(), "codeman-desktop\n");
        assert!(installed_with(&zsh, true));
        assert_eq!(s.argv_log(), "codeman-desktop\ncodeman-desktop\ncodeman-desktop\n");
        assert!(!s.0.join("ran").exists(), "the installed check ran codeman");
    }

    /// Nothing on any PATH and no ~/.codeman/app: not installed. Through a
    /// non-POSIX shell too, which only reports its environment.
    #[test]
    fn installed_check_reports_missing_codeman() {
        let _serial = serial();
        let s = Scratch::new("find-fish");
        std::fs::remove_file(s.0.join("bin/codeman")).unwrap();
        let fish = s.exe("fish", &FAKE_FISH.replace("INTERACTIVE_ONLY", "no"));
        assert!(!installed_with(&fish, true));
        // The login-only look asks fish once, with -l and never -i.
        let before = s.argv_log();
        assert!(!installed_with(&fish, false));
        assert_eq!(&s.argv_log()[before.len()..], "-l -c \n");

        // The install.sh clone counts once node is there.
        let app = s.0.join("home/.codeman/app/dist");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("index.js"), "").unwrap();
        s.exe("bin/node", "#!/bin/sh\nexit 0\n");
        assert!(installed_with(&fish, true));
        assert!(installed_with(&fish, false));
    }
}
