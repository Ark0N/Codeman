//! The installs that run in Terminal: on this Mac, and on another machine over
//! SSH.
//!
//! The Terminal route is for what the in-app install (`gui_install.rs`) cannot
//! do. `install.sh` asks for the administrator password on a terminal
//! (Homebrew, its sudo keep-alive), the Xcode tools arrive as a system dialog,
//! and ssh asks about host keys and passwords on a terminal too. So the app
//! writes a small script that deletes itself and hands it to Terminal
//! (`open -b com.apple.Terminal`), which needs no permission, unlike scripting
//! Terminal through osascript (an Automation prompt). Everything the scripts
//! contain is built here and unit-tested; the only text from the user is the
//! SSH login, which `SshTarget::parse` limits to the characters of a user and
//! host name before it is quoted.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::setup::{DEFAULT_PORT, INSTALLER_URL};

/// The Terminal scripts' file names (`<name>-<pid>-<n>.command`). The local
/// one is also how `inspect` recognizes an install that is still running.
pub const LOCAL_SCRIPT_NAME: &str = "install-codeman-local";
pub const REMOTE_SCRIPT_NAME: &str = "install-codeman-remote";

/// `s` as one bash word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What the This Mac install asks `install.sh` for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalInstall {
    pub port: u16,
    /// Let the installer ask how other devices reach Codeman (Tailscale, the
    /// local network with a password). Off: this Mac only (`--local`).
    pub network: bool,
}

/// `install.sh`'s flags for a This Mac install. Always `--service`: a
/// LaunchAgent runs Codeman, so it keeps running when the app quits and starts
/// again at login, and the app finds it there (read_service). No `--yes`: the
/// user answers the installer's questions (Homebrew, AI coding tools).
pub fn local_install_args(opts: LocalInstall) -> Vec<String> {
    let mut args = Vec::new();
    if !opts.network {
        args.push("--local".to_string());
    }
    args.push("--service".to_string());
    args.push("--port".to_string());
    args.push(opts.port.to_string());
    args
}

/// The Terminal script for a This Mac install. It downloads the installer to a
/// temporary file and runs it from there, so the installer's input is the
/// terminal itself.
pub fn local_install_script(opts: LocalInstall) -> String {
    let args = local_install_args(opts);
    let shown = format!("bash install.sh {}", args.join(" "));
    let quoted: Vec<String> = args.iter().map(|a| sh_quote(a)).collect();
    format!(
        r#"#!/bin/bash
rm -f -- "$0"
printf '\033]0;%s\007' 'Install Codeman'
cat <<'CODEMAN_MSG'
Installing Codeman on this Mac.

The installer may ask for your Mac password (it installs Homebrew, Node.js and
tmux when they are missing) and which AI coding tools to set up. Codeman then
runs in the background and starts when you log in, so your sessions keep
running when the app is closed. The Codeman app opens it by itself when the
install is done.

CODEMAN_MSG
tmp=$(mktemp "${{TMPDIR:-/tmp}}/codeman-install.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT
echo {from}
if ! curl -fsSL {url} -o "$tmp"; then
  echo
  echo 'Could not download the installer. Check the internet connection, then try again from the Codeman app.'
  exit 1
fi
echo {shown}
echo
bash "$tmp" {args}
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo 'Done. You can close this window.'
else
  echo "The installer stopped (exit $status). Its log is ~/.codeman/install.log"
fi
exit "$status"
"#,
        from = sh_quote(&format!("Downloading the installer from {INSTALLER_URL}")),
        url = sh_quote(INSTALLER_URL),
        shown = sh_quote(&format!("$ {shown}")),
        args = quoted.join(" "),
    )
}

/// A machine to install Codeman on, as ssh takes it: `[user@]host`, plus a
/// `:port` the app passes as `-p`. The host may be a name from `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

const SSH_FORMAT: &str =
    "Enter the machine the way ssh takes it: user@host (for example kay@build-box), or a name from your ssh config.";

impl SshTarget {
    /// Only the characters of a user and host name, never a leading `-` (ssh
    /// would read it as an option) and never an IPv6 literal (ambiguous with
    /// the port; a host name or an IPv4 address works).
    pub fn parse(input: &str) -> Result<Self, String> {
        let s = input.trim();
        if s.is_empty() || s.len() > 300 {
            return Err(SSH_FORMAT.into());
        }
        let (user, rest) = match s.split_once('@') {
            Some((u, r)) => (Some(u), r),
            None => (None, s),
        };
        let (host, port) = match rest.split_once(':') {
            Some((h, p)) => {
                let port = p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| {
                    "The part after the colon must be the SSH port, for example kay@build-box:2222.".to_string()
                })?;
                (h, Some(port))
            }
            None => (rest, None),
        };
        let name_ok = |v: &str, max: usize| {
            !v.is_empty()
                && v.len() <= max
                && !v.starts_with(['-', '.'])
                && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        };
        if let Some(u) = user {
            if !name_ok(u, 64) {
                return Err(SSH_FORMAT.into());
            }
        }
        if !name_ok(host, 253) {
            return Err(SSH_FORMAT.into());
        }
        Ok(SshTarget {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
        })
    }

    /// `user@host`, or `host`.
    pub fn destination(&self) -> String {
        match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        }
    }

    /// The address the connect screen suggests once the install is done: the
    /// installer's default port on that host. Tailscale and a sub-path give
    /// another address, which the installer prints at the end.
    pub fn suggested_url(&self) -> String {
        format!("http://{}:{DEFAULT_PORT}", self.host)
    }
}

/// What the remote login shell runs. It may be fish or tcsh, so the work is
/// one single-quoted `bash -c` word with nothing in it those shells treat
/// specially (no `!`, `$`, backslash or single quote). `curl | bash` is the
/// documented install and the installer asks its questions on ssh's terminal
/// (`-t`); `pipefail` makes a failed download fail the whole command, where a
/// plain pipe would report bash's success on an empty script. The installer
/// needs bash anyway.
pub fn remote_command() -> String {
    format!(
        "bash -o pipefail -c 'if command -v curl >/dev/null 2>&1; then curl -fsSL {u} | bash; \
         elif command -v wget >/dev/null 2>&1; then wget -qO- {u} | bash; \
         else echo \"Codeman needs curl or wget on this machine.\" >&2; exit 1; fi'",
        u = INSTALLER_URL
    )
}

/// `ssh`'s arguments for an install on `target`: a terminal (`-t`) for the
/// installer's questions, the port, and `--` before the destination.
pub fn ssh_args(target: &SshTarget) -> Vec<String> {
    let mut args = vec!["-t".to_string()];
    if let Some(port) = target.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    args.push("--".into());
    args.push(target.destination());
    args.push(remote_command());
    args
}

/// The Terminal script for an install on another machine over SSH.
pub fn remote_install_script(target: &SshTarget) -> String {
    let args: Vec<String> = ssh_args(target).iter().map(|a| sh_quote(a)).collect();
    let dest = target.destination();
    format!(
        r#"#!/bin/bash
rm -f -- "$0"
printf '\033]0;%s\007' {title}
echo {what}
cat <<'CODEMAN_MSG'

ssh may ask you to confirm the machine and for its password. Then the installer
asks how Codeman should be reached (Tailscale, the local network with a password,
or that machine only) and whether to run it in the background. At the end it
prints the address of Codeman there: connect to it in the Codeman app, under
Another machine.

CODEMAN_MSG
ssh {args}
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo 'Done. You can close this window.'
else
  echo "ssh or the installer stopped (exit $status)."
fi
exit "$status"
"#,
        title = sh_quote(&format!("Install Codeman on {}", target.host)),
        what = sh_quote(&format!("Installing Codeman on {dest} over SSH.")),
        args = args.join(" "),
    )
}

static SCRIPT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Run `script` in a new Terminal window. The script file is private to this
/// user (the per-user temporary folder, mode 0700, created fresh) and deletes
/// itself as it starts.
#[cfg(target_os = "macos")]
pub fn open_in_terminal(name: &str, script: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("{name}-{}-{n}.command", std::process::id()));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .and_then(|mut f| f.write_all(script.as_bytes()));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not write the install script: {e}"));
    }
    let out = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.Terminal"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let _ = std::fs::remove_file(&path);
            let said = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if said.is_empty() {
                "Could not open Terminal.".into()
            } else {
                format!("Could not open Terminal: {said}")
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(format!("Could not open Terminal: {e}"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_in_terminal(_name: &str, _script: &str) -> Result<(), String> {
    let _ = &SCRIPT_COUNTER;
    Err("Installing from the app is only available on macOS so far.".into())
}

/// Put `text` on the clipboard (`pbcopy`). The connect page is not a secure
/// context, so it cannot use the web clipboard API itself.
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not copy: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("Could not copy: {e}"))?;
    }
    match child.wait() {
        Ok(s) if s.success() => Ok(()),
        _ => Err("Could not copy the command.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn local_install_flags() {
        assert_eq!(
            local_install_args(LocalInstall {
                port: 3000,
                network: false
            }),
            ["--local", "--service", "--port", "3000"]
        );
        assert_eq!(
            local_install_args(LocalInstall {
                port: 3007,
                network: true
            }),
            ["--service", "--port", "3007"]
        );
    }

    /// Run a script under bash with `curl` and `bash`... replaced, and report
    /// what it did. The real installer never runs in a test.
    #[cfg(unix)]
    fn run_script(script: &str, fakes: &[(&str, &str)]) -> (String, i32, bool) {
        use std::os::unix::fs::PermissionsExt;
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codeman-setup-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        for (name, body) in fakes {
            let p = dir.join("bin").join(name);
            std::fs::write(&p, body.replace("DIR", &dir.display().to_string())).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let file = dir.join("run.command");
        std::fs::write(&file, script).unwrap();
        let out = Command::new("/bin/bash")
            .arg(&file)
            .env("PATH", format!("{}:/usr/bin:/bin", dir.join("bin").display()))
            .env("TMPDIR", &dir)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let log = std::fs::read_to_string(dir.join("log")).unwrap_or_default();
        let self_deleted = !file.exists();
        let _ = std::fs::remove_dir_all(&dir);
        (log, out.status.code().unwrap_or(-1), self_deleted)
    }

    #[cfg(unix)]
    #[test]
    fn local_script_downloads_then_runs_the_installer_with_its_flags() {
        let script = local_install_script(LocalInstall {
            port: 3001,
            network: false,
        });
        let (log, code, self_deleted) = run_script(
            &script,
            &[(
                "curl",
                r#"#!/bin/sh
echo "curl $*" >> DIR/log
out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out" <<'INSTALLER'
for a in "$@"; do printf '[%s]' "$a" >> DIR/log; done
echo >> DIR/log
exit 7
INSTALLER
"#,
            )],
        );
        assert!(self_deleted, "the script must delete itself");
        assert!(
            log.starts_with("curl -fsSL https://getcodeman.com/install -o "),
            "{log}"
        );
        assert!(log.contains("\n[--local][--service][--port][3001]\n"), "{log}");
        assert_eq!(code, 7, "the installer's exit status is the script's");
    }

    #[cfg(unix)]
    #[test]
    fn local_script_stops_when_the_download_fails() {
        let script = local_install_script(LocalInstall {
            port: 3000,
            network: true,
        });
        let (log, code, _) = run_script(&script, &[("curl", "#!/bin/sh\necho curl >> DIR/log\nexit 22\n")]);
        assert_eq!(log, "curl\n");
        assert_eq!(code, 1);
    }

    #[test]
    fn ssh_targets() {
        assert_eq!(
            SshTarget::parse(" kay@build-box ").unwrap(),
            SshTarget {
                user: Some("kay".into()),
                host: "build-box".into(),
                port: None
            }
        );
        assert_eq!(
            SshTarget::parse("pi@192.168.1.20:2222").unwrap(),
            SshTarget {
                user: Some("pi".into()),
                host: "192.168.1.20".into(),
                port: Some(2222)
            }
        );
        assert_eq!(SshTarget::parse("macmini").unwrap().destination(), "macmini");
        assert_eq!(
            SshTarget::parse("a.b@tnode.tailnet.ts.net").unwrap().destination(),
            "a.b@tnode.tailnet.ts.net"
        );
        for bad in [
            "",
            "-oProxyCommand=touch /tmp/x",
            "kay@-oProxyCommand=x",
            "-l@host",
            "kay@host name",
            "kay@host;rm",
            "kay@host$(x)",
            "k'y@host",
            "kay@",
            "@host",
            "kay@host:",
            "kay@host:0",
            "kay@host:x",
            "kay@fe80::1",
            "kay@[::1]",
            "a@b@c",
            ".hidden",
        ] {
            assert!(SshTarget::parse(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(SshTarget::parse("kay@box").unwrap().suggested_url(), "http://box:3000");
    }

    #[test]
    fn ssh_arguments() {
        let t = SshTarget::parse("kay@box:2222").unwrap();
        let args = ssh_args(&t);
        assert_eq!(&args[..5], ["-t", "-p", "2222", "--", "kay@box"]);
        assert_eq!(args.len(), 6);
        let remote = &args[5];
        let head = "bash -o pipefail -c '";
        assert!(remote.starts_with(head) && remote.ends_with('\''));
        // One word for fish and tcsh: no quote inside, nothing they expand.
        let inner = &remote[head.len()..remote.len() - 1];
        assert!(!inner.contains(['\'', '!', '$', '\\', '`']), "{inner}");
        assert!(inner.contains("curl -fsSL https://getcodeman.com/install | bash"));
        assert_eq!(ssh_args(&SshTarget::parse("box").unwrap())[..3], ["-t", "--", "box"]);
    }

    #[cfg(unix)]
    #[test]
    fn remote_script_runs_ssh_with_exactly_those_arguments() {
        let t = SshTarget::parse("kay@box:2222").unwrap();
        let (log, code, self_deleted) = run_script(
            &remote_install_script(&t),
            &[(
                "ssh",
                "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\" >> DIR/log; done\necho >> DIR/log\nexit 3\n",
            )],
        );
        assert!(self_deleted);
        let expected: String = ssh_args(&t).iter().map(|a| format!("[{a}]")).collect();
        assert_eq!(log, format!("{expected}\n"));
        assert_eq!(code, 3);
    }

    /// The remote command does what it says under a POSIX shell: curl first,
    /// wget without curl, and a clear error with neither.
    #[cfg(unix)]
    #[test]
    fn remote_command_picks_a_downloader() {
        use std::os::unix::fs::PermissionsExt;
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codeman-remote-cmd-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let exe = |name: &str, body: &str| {
            let p = dir.join("bin").join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // The outer `bash -o pipefail` is the real one; the `bash` the
        // download is piped into only reports what it was fed.
        exe(
            "bash",
            "#!/bin/sh\nif [ \"$1\" = -o ]; then exec /bin/bash \"$@\"; fi\nprintf 'bash got: '; /bin/cat\n",
        );
        exe("wget", "#!/bin/sh\necho \"wget $*\"\n");
        let run = || {
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(remote_command())
                .env("PATH", dir.join("bin"))
                .output()
                .unwrap();
            (
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
                out.status.code(),
            )
        };
        let (out, _, _) = run();
        assert_eq!(out, "bash got: wget -qO- https://getcodeman.com/install\n");
        exe("curl", "#!/bin/sh\necho \"curl $*\"\n");
        let (out, _, _) = run();
        assert_eq!(out, "bash got: curl -fsSL https://getcodeman.com/install\n");
        // A failed download fails the command (pipefail), not "Done".
        exe(
            "curl",
            "#!/bin/sh\necho 'curl: (6) Could not resolve host' >&2\nexit 6\n",
        );
        let (_, _, code) = run();
        assert_ne!(code, Some(0));
        std::fs::remove_file(dir.join("bin/curl")).unwrap();
        std::fs::remove_file(dir.join("bin/wget")).unwrap();
        let (out, err, code) = run();
        assert_eq!(out, "");
        assert!(err.contains("needs curl or wget"), "{err}");
        assert_eq!(code, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
