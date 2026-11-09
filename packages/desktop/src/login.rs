//! The login a connect goes out with, and what the Keychain keeps once the
//! server has answered it.

use crate::credentials::{self, Keychain};
use crate::probe::ProbeOutcome;

/// The login a connect goes out with, and where its password came from. A
/// typed password wins, then the one the Keychain holds for this user. Last
/// comes the login of the Codeman on this Mac, which keeps it where its own
/// clients find it (setup::local_login: its launchd job, then
/// ~/.codeman/.env) and only answers it at its own loopback address. That one
/// is used only when the config expected no password in the Keychain
/// (`expect_saved`: one that should be there and is not is reported, not
/// papered over), only for the username in use when there is one, and it is
/// never saved anywhere. `local` is asked only then: it runs processes.
pub fn choose_login(
    user: Option<String>,
    typed_password: Option<String>,
    saved: Option<String>,
    expect_saved: bool,
    local: impl FnOnce() -> Option<(String, String)>,
) -> (Option<String>, Option<String>, PasswordSource) {
    if let Some(password) = typed_password {
        return (user, Some(password), PasswordSource::Typed);
    }
    if let Some(password) = saved {
        return (user, Some(password), PasswordSource::Keychain);
    }
    if !expect_saved {
        if let Some((local_user, password)) = local() {
            if user.as_deref().is_none_or(|current| current == local_user) {
                return (Some(local_user), Some(password), PasswordSource::LocalServer);
            }
        }
    }
    (user, None, PasswordSource::Absent)
}

/// A login the probe just tried, and what the user asked for it.
pub struct ProbedLogin<'a> {
    /// The server, as the config and the Keychain accounts key it.
    pub server: &'a str,
    /// The username the config named for this server before the connect.
    pub previous_user: Option<&'a str>,
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
    /// Where the password came from.
    pub source: PasswordSource,
    pub remember: bool,
}

/// Where a connect's password came from, which decides what the Keychain
/// does with it (update_keychain).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordSource {
    /// Typed on the connect page this time: saved if Remember is on.
    Typed,
    /// From the Keychain: there already.
    Keychain,
    /// The local Codeman's own login (setup::local_login): it stays where it
    /// is, and the Keychain never gets a copy.
    LocalServer,
    /// No password.
    Absent,
}

/// What update_keychain did: whether the Keychain now holds the login's
/// password, and whose items it deleted.
#[derive(Default)]
pub struct KeychainUpdate {
    pub saved: bool,
    pub deleted: Vec<String>,
}

/// Bring the Keychain in line with a probe the server answered, on the probe
/// worker. Only an accepted login changes anything (Ok, or a password the
/// server wants changed), since only then does the config get the new entry.
///
/// When that entry names another user than the config did (compared exactly,
/// as the account string is), the old user's item is deleted FIRST, before any
/// save: the Keychain worker runs jobs in order, so a Keychain that treats two
/// spellings of a name as one item cannot lose the new password to that
/// delete. Then the typed password is saved when Remember is on and deleted
/// when it is off, and a password the server wants changed is never kept.
pub fn update_keychain(keychain: &Keychain, outcome: &ProbeOutcome, login: &ProbedLogin<'_>) -> KeychainUpdate {
    let mut update = KeychainUpdate::default();
    if !matches!(outcome, ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired) {
        return update;
    }
    let mut delete = |user: &str| {
        keychain.delete(&credentials::account(login.server, user));
        update.deleted.push(user.to_string());
    };
    if let Some(old) = login.previous_user.filter(|old| login.username != Some(*old)) {
        delete(old);
    }
    let saved = match (outcome, login.username, login.password) {
        (ProbeOutcome::Ok { .. }, Some(user), Some(password)) if login.source == PasswordSource::Typed => {
            if login.remember {
                keychain
                    .save_blocking(&credentials::account(login.server, user), password)
                    .is_ok()
            } else {
                delete(user);
                false
            }
        }
        // A password that came from the Keychain is saved there already.
        (ProbeOutcome::Ok { .. }, Some(_), Some(_)) => login.source == PasswordSource::Keychain,
        (ProbeOutcome::PasswordChangeRequired, Some(user), _) => {
            delete(user);
            false
        }
        _ => false,
    };
    update.saved = saved;
    update
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::memory;

    fn none() -> Option<(String, String)> {
        panic!("the local login must not be looked up here");
    }

    #[test]
    fn the_login_a_connect_uses() {
        let s = |v: &str| Some(v.to_string());
        let local = || Some(("admin".to_string(), "from-this-mac".to_string()));

        // A typed password wins over everything, and nothing else is asked.
        assert_eq!(
            choose_login(s("kay"), s("typed"), s("kept"), true, none),
            (s("kay"), s("typed"), PasswordSource::Typed)
        );
        // Then the Keychain's.
        assert_eq!(
            choose_login(s("kay"), None, s("kept"), true, none),
            (s("kay"), s("kept"), PasswordSource::Keychain)
        );
        // The Keychain should hold one and does not: reported as absent, the
        // local login is not tried in its place.
        assert_eq!(
            choose_login(s("kay"), None, None, true, none),
            (s("kay"), None, PasswordSource::Absent)
        );
        // Nothing typed, nothing expected: the Codeman on this Mac's own
        // login, for no username or the same one.
        assert_eq!(
            choose_login(None, None, None, false, local),
            (s("admin"), s("from-this-mac"), PasswordSource::LocalServer)
        );
        assert_eq!(
            choose_login(s("admin"), None, None, false, local),
            (s("admin"), s("from-this-mac"), PasswordSource::LocalServer)
        );
        // Never for another user: the names are compared exactly.
        assert_eq!(
            choose_login(s("kay"), None, None, false, local),
            (s("kay"), None, PasswordSource::Absent)
        );
        assert_eq!(
            choose_login(s("Admin"), None, None, false, local),
            (s("Admin"), None, PasswordSource::Absent)
        );
        // No local login either.
        assert_eq!(
            choose_login(None, None, None, false, || None),
            (None, None, PasswordSource::Absent)
        );
    }

    /// update_keychain for one probe answer; the log is what the Keychain did,
    /// in order (the last load only waits for the queue to drain).
    fn keychain_after(outcome: ProbeOutcome, login: ProbedLogin<'_>) -> (KeychainUpdate, Vec<String>) {
        let (keychain, store) = memory::keychain();
        let update = update_keychain(&keychain, &outcome, &login);
        keychain.load_blocking("done");
        let mut log = store.log();
        assert_eq!(log.pop().as_deref(), Some("load done"));
        (update, log)
    }

    fn login<'a>(
        previous_user: Option<&'a str>,
        username: Option<&'a str>,
        source: PasswordSource,
        remember: bool,
    ) -> ProbedLogin<'a> {
        ProbedLogin {
            server: "http://a/",
            previous_user,
            username,
            password: (source != PasswordSource::Absent).then_some("secret"),
            source,
            remember,
        }
    }

    #[test]
    fn what_the_keychain_keeps_after_a_connect() {
        let ok = || ProbeOutcome::Ok {
            version: "1.48.0".into(),
        };
        let item = |user: &str| credentials::account("http://a/", user);

        // A typed password is saved when Remember is on, deleted when it is off.
        let (update, log) = keychain_after(ok(), login(Some("kay"), Some("kay"), PasswordSource::Typed, true));
        assert!(update.saved && update.deleted.is_empty());
        assert_eq!(log, [format!("save {}", item("kay"))]);
        let (update, log) = keychain_after(ok(), login(Some("kay"), Some("kay"), PasswordSource::Typed, false));
        assert!(!update.saved);
        assert_eq!(update.deleted, ["kay"]);
        assert_eq!(log, [format!("delete {}", item("kay"))]);

        // One that came from the Keychain is there already: nothing is written.
        let (update, log) = keychain_after(ok(), login(Some("kay"), Some("kay"), PasswordSource::Keychain, true));
        assert!(update.saved && log.is_empty());

        // The local Codeman's own login never gets a copy, Remember or not.
        let (update, log) = keychain_after(ok(), login(None, Some("admin"), PasswordSource::LocalServer, true));
        assert!(!update.saved && update.deleted.is_empty() && log.is_empty());

        // Another user than before: the old user's item goes FIRST, then the save.
        let (update, log) = keychain_after(ok(), login(Some("old"), Some("new"), PasswordSource::Typed, true));
        assert!(update.saved);
        assert_eq!(update.deleted, ["old"]);
        assert_eq!(
            log,
            [format!("delete {}", item("old")), format!("save {}", item("new"))]
        );

        // A password the server wants changed is never kept.
        let (update, log) = keychain_after(
            ProbeOutcome::PasswordChangeRequired,
            login(Some("kay"), Some("kay"), PasswordSource::Typed, true),
        );
        assert!(!update.saved);
        assert_eq!(update.deleted, ["kay"]);
        assert_eq!(log, [format!("delete {}", item("kay"))]);

        // A login the server did not accept changes nothing.
        for refused in [
            ProbeOutcome::BadCredentials,
            ProbeOutcome::NeedsLogin,
            ProbeOutcome::Refused,
            ProbeOutcome::Timeout,
        ] {
            let (update, log) = keychain_after(refused, login(Some("old"), Some("new"), PasswordSource::Typed, true));
            assert!(!update.saved && update.deleted.is_empty() && log.is_empty());
        }
    }
}
