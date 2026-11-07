//! How many agents are at work on a server, asked from outside the web view.
//!
//! The page knows this too, but it cannot be relied on for it: WebKit stalls the
//! event stream of a hidden page. Measured on macOS 27.2 with the page hidden: a
//! `session:idle` the server sent never reached it, its own watchdog reopened the
//! stream 39 seconds later, and in another run a whole turn went unseen. A hidden
//! window is the normal case for this question, so it is asked natively, of
//! `api/sessions`, a stable route that works with any Codeman.
//!
//! A login has a price here that a single request does not show. A request with
//! a good password and no session cookie makes Codeman create a login session,
//! it keeps 100 of them, and the oldest goes first, so asking every two seconds
//! with the password alone would log every browser out within minutes. So the
//! cookie of the first answer goes along from then on, and Codeman reads the
//! cookie first: the password is only used when the cookie has lapsed (a server
//! restart), and then it creates the one new session that replaces it. Sending
//! both also means a stale cookie costs no failed login. A refused login ends
//! the polling for good, since Codeman counts each one against the login rate
//! limit (see `probe`).

use serde::Deserialize;
use std::time::Duration;
use url::Url;

/// How long the logo can lag behind the server. The list is cached for a
/// second on the server's side and is a few kilobytes.
pub const POLL_EVERY: Duration = Duration::from_secs(2);
const TIMEOUT: Duration = Duration::from_secs(5);
const SESSIONS_PATH: &str = "api/sessions";
const COOKIE_NAME: &str = "codeman_session";

#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    /// This many agents are working.
    Working(u32),
    /// No answer this time. Worth asking again.
    Failed,
    /// The server turned the login down. Never ask again.
    Refused,
}

#[derive(Deserialize)]
struct Session {
    #[serde(default)]
    status: String,
    #[serde(default)]
    mode: String,
}

/// Codeman wraps the list in its API envelope, and older servers sent it bare.
#[derive(Deserialize)]
#[serde(untagged)]
enum Sessions {
    Envelope { data: Vec<Session> },
    Bare(Vec<Session>),
}

/// Agents only: a shell tab with a `tail -f` is a run of output, which the
/// server may call busy, and that is nobody's agent.
fn count_working(body: &str) -> Option<u32> {
    let (Sessions::Envelope { data: sessions } | Sessions::Bare(sessions)) = serde_json::from_str(body).ok()?;
    let working = sessions.iter().filter(|s| s.status == "busy" && s.mode != "shell");
    u32::try_from(working.count()).ok()
}

/// `name=value` out of a `Set-Cookie` header, for Codeman's session cookie.
fn session_cookie(header: &str) -> Option<&str> {
    let pair = header.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    (name == COOKIE_NAME && !value.is_empty()).then_some(pair)
}

/// What a status code says about asking again.
fn answer(status: u16, body: impl FnOnce() -> Option<String>) -> Poll {
    match status {
        200 => body()
            .as_deref()
            .and_then(count_working)
            .map_or(Poll::Failed, Poll::Working),
        401 | 403 | 429 => Poll::Refused,
        _ => Poll::Failed,
    }
}

pub struct Poller {
    agent: ureq::Agent,
    url: String,
    authorization: Option<String>,
    cookie: Option<String>,
}

impl Poller {
    pub fn new(server: &Url, authorization: Option<String>) -> Option<Self> {
        Some(Poller {
            agent: crate::probe::agent(TIMEOUT),
            url: server.join(SESSIONS_PATH).ok()?.to_string(),
            authorization,
            cookie: None,
        })
    }

    pub fn poll(&mut self) -> Poll {
        let mut request = self.agent.get(&self.url).header("Accept", "application/json");
        if let Some(authorization) = &self.authorization {
            request = request.header("Authorization", authorization);
        }
        if let Some(cookie) = &self.cookie {
            request = request.header("Cookie", cookie);
        }
        let Ok(mut response) = request.call() else {
            return Poll::Failed;
        };
        let fresh = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(session_cookie)
            .map(str::to_owned);
        if fresh.is_some() {
            self.cookie = fresh;
        }
        let status = response.status().as_u16();
        answer(status, || {
            let body = response.body_mut().with_config();
            body.limit(crate::probe::MAX_BODY).read_to_string().ok()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// The start of a real answer of `GET /api/sessions`, captured from a
    /// server: other fields around the two that matter, in Codeman's envelope.
    const REAL_ANSWER: &str = r#"{"success":true,"data":[{"id":"0f8d0215-661e-4a1c-bfad-d7f6fd2ed4b5",
        "pid":61017,"status":"busy","workingDir":"/Users/lee/codeman-cases/testcase",
        "paneCwd":"/Users/lee/codeman-cases/testcase","currentTaskId":null,"mode":"opencode"}]}"#;

    #[test]
    fn reads_the_answer_a_real_server_gives() {
        assert_eq!(count_working(REAL_ANSWER), Some(1));
        assert_eq!(count_working(r#"{"success":true,"data":[]}"#), Some(0));
    }

    #[test]
    fn counts_agents_at_work_and_nothing_else() {
        let body = r#"{"success":true,"data":[
            {"id":"a","status":"busy","mode":"claude"},
            {"id":"b","status":"busy","mode":"codex"},
            {"id":"c","status":"idle","mode":"claude"},
            {"id":"d","status":"busy","mode":"shell"},
            {"id":"e","status":"stopped","mode":"claude"},
            {"id":"f","status":"error","mode":"opencode"}
        ]}"#;
        assert_eq!(count_working(body), Some(2));
    }

    #[test]
    fn reads_the_bare_list_of_an_older_server() {
        assert_eq!(count_working(r#"[{"status":"busy","mode":"claude"}]"#), Some(1));
        assert_eq!(count_working("[]"), Some(0));
    }

    #[test]
    fn a_session_without_a_mode_counts_and_one_without_a_status_does_not() {
        assert_eq!(
            count_working(r#"{"data":[{"status":"busy"},{"mode":"claude"}]}"#),
            Some(1)
        );
    }

    #[test]
    fn a_body_that_is_not_the_list_is_no_answer() {
        assert_eq!(count_working("<html>"), None);
        assert_eq!(count_working(r#"{"success":false,"error":"nope"}"#), None);
        assert_eq!(answer(200, || Some("<html>".into())), Poll::Failed);
        assert_eq!(answer(200, || None), Poll::Failed);
    }

    #[test]
    fn only_a_login_refusal_ends_the_polling() {
        for status in [401, 403, 429] {
            assert_eq!(answer(status, || None), Poll::Refused, "{status}");
        }
        for status in [301, 404, 500, 502, 503] {
            assert_eq!(answer(status, || None), Poll::Failed, "{status}");
        }
    }

    #[test]
    fn finds_codemans_cookie_in_a_set_cookie_header() {
        assert_eq!(
            session_cookie("codeman_session=abc123; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax"),
            Some("codeman_session=abc123")
        );
        assert_eq!(session_cookie("codeman_session=abc123"), Some("codeman_session=abc123"));
        assert_eq!(session_cookie("other=1; Path=/"), None);
        assert_eq!(session_cookie("codeman_session=; Max-Age=0"), None);
        assert_eq!(session_cookie(""), None);
    }

    /// A server that answers each connection with the next canned response
    /// and records the headers it was sent.
    fn serve(responses: Vec<String>) -> (u16, Arc<Mutex<Vec<Vec<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut headers = Vec::new();
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok() && line.trim() != "" {
                    headers.push(line.trim().to_ascii_lowercase());
                    line.clear();
                }
                log.lock().unwrap().push(headers);
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (port, seen)
    }

    const EMPTY: &str = r#"{"success":true,"data":[]}"#;

    fn ok(extra_headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n{extra_headers}\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn keeps_one_login_session_across_polls() {
        let body = r#"{"success":true,"data":[{"status":"busy","mode":"claude"}]}"#;
        let (port, seen) = serve(vec![
            ok("Set-Cookie: codeman_session=first; Max-Age=86400; Path=/\r\n", body),
            ok("Set-Cookie: codeman_session=first; Max-Age=86400; Path=/\r\n", body),
            ok("Set-Cookie: codeman_session=second; Max-Age=86400; Path=/\r\n", EMPTY),
            ok("", EMPTY),
        ]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let mut poller = Poller::new(&server, Some("Basic abc".into())).unwrap();
        assert_eq!(poller.poll(), Poll::Working(1));
        assert_eq!(poller.poll(), Poll::Working(1));
        assert_eq!(poller.poll(), Poll::Working(0));
        assert_eq!(poller.poll(), Poll::Working(0));

        let seen = seen.lock().unwrap();
        let cookie = |n: usize| seen[n].iter().find(|h| h.starts_with("cookie:")).cloned();
        assert_eq!(cookie(0), None);
        assert_eq!(cookie(1).as_deref(), Some("cookie: codeman_session=first"));
        assert_eq!(cookie(2).as_deref(), Some("cookie: codeman_session=first"));
        // A server restart hands out a new one; a response without one keeps it.
        assert_eq!(cookie(3).as_deref(), Some("cookie: codeman_session=second"));
        assert!(seen.iter().all(|h| h.contains(&"authorization: basic abc".to_string())));
        assert!(seen[0][0].starts_with("get /api/sessions "), "{:?}", seen[0][0]);
    }

    #[test]
    fn asks_under_the_servers_base_path() {
        let (port, seen) = serve(vec![ok("", EMPTY)]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/codeman/")).unwrap();
        assert_eq!(Poller::new(&server, None).unwrap().poll(), Poll::Working(0));
        let seen = seen.lock().unwrap();
        assert!(seen[0][0].starts_with("get /codeman/api/sessions "), "{:?}", seen[0][0]);
        assert!(!seen[0].iter().any(|h| h.starts_with("authorization:")));
    }

    #[test]
    fn a_server_that_answers_nothing_is_only_a_failed_poll() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(Poller::new(&server, None).unwrap().poll(), Poll::Failed);
    }
}
