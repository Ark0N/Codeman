//! Saved passwords, in the macOS Keychain (service "Codeman Desktop", one item
//! per username + server). Nothing secret is ever written to the config file.
//! Windows and Linux get their stores when those builds land.
//!
//! Every Keychain call runs on ONE long-lived worker thread, never on the
//! event loop: any of them can bring up the system's access prompt (an
//! ad-hoc build's items name the previous build), and the window must keep
//! running while it is up. One serial worker rather than a thread per call,
//! because jobs must run in the order they were asked for: a delete from
//! Forget that ran after a later save of the same account would remove the
//! password that was just saved.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};

pub const SERVICE: &str = "Codeman Desktop";

/// What a job reports when the worker thread is gone.
const WORKER_GONE: &str = "The Keychain could not be reached.";

/// The Keychain account name for a username on a server.
pub fn account(server_url: &str, username: &str) -> String {
    format!("{username} @ {server_url}")
}

/// The password store the worker runs jobs against: the Keychain on macOS,
/// a stub elsewhere, an in-memory map in the tests.
trait Backend: Send {
    fn load(&mut self, account: &str) -> Option<String>;
    fn save(&mut self, account: &str, password: &str) -> Result<(), String>;
    fn delete(&mut self, account: &str);
}

enum Job {
    Load {
        account: String,
        reply: Sender<Option<String>>,
    },
    Save {
        account: String,
        password: String,
        reply: Sender<Result<(), String>>,
    },
    Delete {
        account: String,
    },
    /// Ends the worker, so the tests can check what callers see after it.
    #[cfg(test)]
    Stop,
}

/// A handle on the Keychain worker. Start it once with [`Keychain::spawn`]
/// and clone the handle: every clone feeds the same queue, which is what
/// keeps jobs in order. The worker ends when the last handle is dropped.
#[derive(Clone)]
pub struct Keychain {
    jobs: Sender<Job>,
}

impl Keychain {
    /// Starts the worker. If the thread cannot be started, the handle still
    /// works and every call fails soft (no password, save refused).
    pub fn spawn() -> Keychain {
        start(Box::new(imp::System)).0
    }

    /// The saved password for an account. Blocks until every job queued
    /// before it has run and the Keychain has answered, which can mean
    /// waiting on the access prompt, so call it from a worker thread.
    /// `None` when nothing is saved, the item is unreadable or the worker
    /// is gone.
    pub fn load_blocking(&self, account: &str) -> Option<String> {
        let (reply, answer) = mpsc::channel();
        let job = Job::Load {
            account: account.to_owned(),
            reply,
        };
        self.jobs.send(job).ok()?;
        answer.recv().ok().flatten()
    }

    /// Saves a password, replacing any saved before. Blocks like
    /// [`Keychain::load_blocking`]; the result is the Keychain's own.
    pub fn save_blocking(&self, account: &str, password: &str) -> Result<(), String> {
        let (reply, answer) = mpsc::channel();
        let job = Job::Save {
            account: account.to_owned(),
            password: password.to_owned(),
            reply,
        };
        self.jobs.send(job).map_err(|_| WORKER_GONE.to_string())?;
        answer.recv().unwrap_or_else(|_| Err(WORKER_GONE.into()))
    }

    /// Queues the removal of an account's password and returns at once.
    /// Jobs queued after it see the account gone. Nothing happens when the
    /// worker is gone.
    pub fn delete(&self, account: &str) {
        let _ = self.jobs.send(Job::Delete {
            account: account.to_owned(),
        });
    }
}

/// Starts a worker on `backend`. The join handle is for the tests; `None`
/// when the thread could not be started, in which case the receiver went
/// down with the closure and every send fails.
fn start(backend: Box<dyn Backend>) -> (Keychain, Option<JoinHandle<()>>) {
    let (jobs, queue) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("keychain".into())
        .spawn(move || run(backend, queue))
        .ok();
    (Keychain { jobs }, worker)
}

/// The worker loop: one job at a time, in the order they were sent, until
/// every handle is gone. A reply nobody waits for any more is dropped.
fn run(mut backend: Box<dyn Backend>, queue: Receiver<Job>) {
    for job in queue {
        match job {
            Job::Load { account, reply } => {
                let _ = reply.send(backend.load(&account));
            }
            Job::Save {
                account,
                password,
                reply,
            } => {
                let _ = reply.send(backend.save(&account, &password));
            }
            Job::Delete { account } => backend.delete(&account),
            #[cfg(test)]
            Job::Stop => return,
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Backend, SERVICE};
    use objc2::rc::autoreleasepool;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    /// The login Keychain, through security-framework. The worker lives as
    /// long as the app and a thread's implicit autorelease pool drains only
    /// when the thread ends, so each call gets its own pool and whatever
    /// Security autoreleases is freed with the job.
    pub struct System;

    impl Backend for System {
        fn load(&mut self, account: &str) -> Option<String> {
            autoreleasepool(|_| {
                get_generic_password(SERVICE, account)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
            })
        }

        fn save(&mut self, account: &str, password: &str) -> Result<(), String> {
            autoreleasepool(|_| set_generic_password(SERVICE, account, password.as_bytes()).map_err(|e| e.to_string()))
        }

        fn delete(&mut self, account: &str) {
            autoreleasepool(|_| {
                let _ = delete_generic_password(SERVICE, account);
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Backend;

    /// No password store yet on this platform.
    pub struct System;

    impl Backend for System {
        fn load(&mut self, _account: &str) -> Option<String> {
            None
        }
        fn save(&mut self, _account: &str, _password: &str) -> Result<(), String> {
            Err("Saving passwords is not supported on this platform yet.".into())
        }
        fn delete(&mut self, _account: &str) {}
    }
}

/// A Keychain on an in-memory store, for these tests and for the tests of the
/// code that uses a Keychain (main.rs).
#[cfg(test)]
pub(crate) mod memory {
    use super::{start, Backend, Keychain};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// An in-memory store that logs every job it runs. Its delete is slow on
    /// purpose: a queue that did not keep order would let the next job
    /// overtake it, and the tests would see that.
    #[derive(Clone, Default)]
    pub(crate) struct Memory {
        items: Arc<Mutex<HashMap<String, String>>>,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl Memory {
        fn note(&self, entry: String) {
            self.log.lock().unwrap().push(entry);
        }
        /// The jobs the store ran, in order.
        pub(crate) fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl Backend for Memory {
        fn load(&mut self, account: &str) -> Option<String> {
            self.note(format!("load {account}"));
            self.items.lock().unwrap().get(account).cloned()
        }
        fn save(&mut self, account: &str, password: &str) -> Result<(), String> {
            self.note(format!("save {account}"));
            self.items
                .lock()
                .unwrap()
                .insert(account.to_owned(), password.to_owned());
            Ok(())
        }
        fn delete(&mut self, account: &str) {
            std::thread::sleep(Duration::from_millis(30));
            self.note(format!("delete {account}"));
            self.items.lock().unwrap().remove(account);
        }
    }

    /// A worker on a fresh store, and the store to look into.
    pub(crate) fn keychain() -> (Keychain, Memory) {
        let memory = Memory::default();
        let (keychain, worker) = start(Box::new(memory.clone()));
        assert!(worker.is_some(), "the worker thread starts");
        (keychain, memory)
    }
}

#[cfg(test)]
mod tests {
    use super::memory::{keychain, Memory};
    use super::{start, Backend, Job, Keychain};

    /// A store whose load fails the way a crashed worker would.
    struct Crashes;

    impl Backend for Crashes {
        fn load(&mut self, _account: &str) -> Option<String> {
            panic!("keychain worker crashed");
        }
        fn save(&mut self, _account: &str, _password: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&mut self, _account: &str) {}
    }

    #[test]
    fn account_names_are_per_user_and_server() {
        assert_eq!(
            super::account("http://127.0.0.1:3000/", "admin"),
            "admin @ http://127.0.0.1:3000/"
        );
        assert_ne!(
            super::account("http://a/", "admin"),
            super::account("http://b/", "admin")
        );
    }

    #[test]
    fn a_load_reads_what_a_save_wrote() {
        let (keychain, _) = keychain();
        assert_eq!(keychain.load_blocking("a"), None);
        assert_eq!(keychain.save_blocking("a", "secret"), Ok(()));
        assert_eq!(keychain.load_blocking("a").as_deref(), Some("secret"));
        assert_eq!(keychain.save_blocking("a", "changed"), Ok(()));
        assert_eq!(keychain.load_blocking("a").as_deref(), Some("changed"));
        assert_eq!(keychain.load_blocking("b"), None);
    }

    #[test]
    fn a_delete_queued_before_a_save_never_removes_the_saved_password() {
        let (keychain, memory) = keychain();
        assert_eq!(keychain.save_blocking("a", "old"), Ok(()));
        keychain.delete("a");
        assert_eq!(keychain.save_blocking("a", "new"), Ok(()));
        assert_eq!(keychain.load_blocking("a").as_deref(), Some("new"));
        assert_eq!(memory.log(), ["save a", "delete a", "save a", "load a"]);
    }

    #[test]
    fn a_delete_queued_after_a_save_removes_it_before_the_next_job() {
        let (keychain, memory) = keychain();
        assert_eq!(keychain.save_blocking("a", "secret"), Ok(()));
        keychain.delete("a");
        // No wait between the two: the load is queued behind the delete.
        assert_eq!(keychain.load_blocking("a"), None);
        assert_eq!(memory.log(), ["save a", "delete a", "load a"]);
    }

    #[test]
    fn jobs_from_clones_on_other_threads_share_one_queue() {
        let (keychain, memory) = keychain();
        let other = keychain.clone();
        std::thread::spawn(move || {
            other.save_blocking("a", "secret").unwrap();
            other.delete("a");
        })
        .join()
        .unwrap();
        assert_eq!(keychain.load_blocking("a"), None);
        assert_eq!(memory.log(), ["save a", "delete a", "load a"]);
    }

    #[test]
    fn every_call_fails_soft_once_the_worker_is_gone() {
        let memory = Memory::default();
        let (keychain, worker) = start(Box::new(memory.clone()));
        assert_eq!(keychain.save_blocking("a", "secret"), Ok(()));
        keychain.jobs.send(Job::Stop).unwrap();
        worker.unwrap().join().unwrap();

        assert_eq!(keychain.load_blocking("a"), None);
        assert!(keychain.save_blocking("a", "secret").is_err());
        keychain.delete("a");
        keychain.clone().delete("a");
        assert_eq!(memory.log(), ["save a"]);
    }

    #[cfg(panic = "unwind")]
    #[test]
    fn a_worker_that_dies_mid_job_answers_nothing_and_takes_no_more_jobs() {
        let (keychain, worker) = start(Box::new(Crashes));
        assert_eq!(keychain.load_blocking("a"), None);
        assert!(worker.unwrap().join().is_err(), "the worker panicked");
        assert!(keychain.save_blocking("a", "secret").is_err());
        keychain.delete("a");
    }

    #[test]
    fn the_handle_is_send_and_sync() {
        fn send_sync_clone<T: Send + Sync + Clone + 'static>() {}
        send_sync_clone::<Keychain>();
    }
}
