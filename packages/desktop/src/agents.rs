//! What the agents on a server are doing, asked from outside the web view: at
//! work, finished with nobody having looked yet (a yellow tab), or stopped on a
//! permission or a question (a red tab).
//!
//! The page knows this too, but it cannot be relied on for it: WebKit stalls the
//! event stream of a hidden page. Measured on macOS 27.2 with the page hidden: a
//! `session:idle` the server sent never reached it, its own watchdog reopened the
//! stream 39 seconds later, and in another run a whole turn went unseen. A hidden
//! window is the normal case for this question, so it is asked natively, of
//! `api/sessions`, a stable route that works with any Codeman, and of
//! `api/approvals`, the list the page itself builds its red and yellow tabs from
//! when it loads. A server from before that list has no such route, which reads
//! as no alerts.
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
const APPROVALS_PATH: &str = "api/approvals";
const COOKIE_NAME: &str = "codeman_session";

/// What the agents on a server are doing. Any number of these can be true.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Activity {
    /// At least one agent is at work.
    pub working: bool,
    /// An agent finished and nobody has looked at it yet: a yellow tab.
    pub waiting: bool,
    /// An agent stopped on a permission or a question: a red tab.
    pub needs_you: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    Seen(Activity),
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

#[derive(Deserialize)]
struct Approval {
    #[serde(default)]
    kind: String,
    #[serde(default, rename = "acknowledgedAt")]
    acknowledged_at: Option<f64>,
}

#[derive(Deserialize)]
struct Approvals {
    approvals: Vec<Approval>,
}

#[derive(Deserialize)]
struct ApprovalsAnswer {
    data: Approvals,
}

/// The two alerts, by the page's own rules: `permission_prompt` and a question
/// make a tab red, an idle prompt makes it yellow until someone has looked at it,
/// and an acknowledged item stays listed but alerts nobody.
fn read_alerts(body: &str) -> Option<(bool, bool)> {
    let answer: ApprovalsAnswer = serde_json::from_str(body).ok()?;
    let items = &answer.data.approvals;
    let waiting = items.iter().any(|i| i.kind == "idle" && i.acknowledged_at.is_none());
    let needs_you = items.iter().any(|i| i.kind == "permission" || i.kind == "question");
    Some((waiting, needs_you))
}

/// `name=value` out of a `Set-Cookie` header, for Codeman's session cookie.
fn session_cookie(header: &str) -> Option<&str> {
    let pair = header.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    (name == COOKIE_NAME && !value.is_empty()).then_some(pair)
}

/// A refused login: Codeman counts each against the login rate limit, so the
/// polling ends.
fn refused(status: u16) -> bool {
    matches!(status, 401 | 403 | 429)
}

/// What a status code says about asking again.
fn answer(status: u16, body: Option<&str>) -> Poll {
    match status {
        200 => body.and_then(count_working).map_or(Poll::Failed, |working| {
            Poll::Seen(Activity {
                working: working > 0,
                ..Activity::default()
            })
        }),
        s if refused(s) => Poll::Refused,
        _ => Poll::Failed,
    }
}

pub struct Poller {
    agent: ureq::Agent,
    sessions_url: String,
    /// None when no alert has a style: that request is then never made.
    approvals_url: Option<String>,
    authorization: Option<String>,
    cookie: Option<String>,
    /// The last alerts seen, kept through a request that failed.
    alerts: (bool, bool),
}

impl Poller {
    pub fn new(server: &Url, authorization: Option<String>, alerts: bool) -> Option<Self> {
        let approvals_url = match alerts {
            true => Some(server.join(APPROVALS_PATH).ok()?.to_string()),
            false => None,
        };
        Some(Poller {
            agent: crate::probe::agent(TIMEOUT),
            sessions_url: server.join(SESSIONS_PATH).ok()?.to_string(),
            approvals_url,
            authorization,
            cookie: None,
            alerts: (false, false),
        })
    }

    /// One GET with the login, and the status with the body of a 200.
    fn ask(&mut self, url: &str) -> Option<(u16, Option<String>)> {
        let mut request = self.agent.get(url).header("Accept", "application/json");
        if let Some(authorization) = &self.authorization {
            request = request.header("Authorization", authorization);
        }
        if let Some(cookie) = &self.cookie {
            request = request.header("Cookie", cookie);
        }
        let mut response = request.call().ok()?;
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
        let body = (status == 200).then(|| {
            let body = response.body_mut().with_config();
            body.limit(crate::probe::MAX_BODY).read_to_string().ok()
        });
        Some((status, body.flatten()))
    }

    pub fn poll(&mut self) -> Poll {
        let url = self.sessions_url.clone();
        let Some((status, body)) = self.ask(&url) else {
            return Poll::Failed;
        };
        let mut activity = match answer(status, body.as_deref()) {
            Poll::Seen(activity) => activity,
            other => return other,
        };
        if let Some(url) = self.approvals_url.clone() {
            match self.ask(&url) {
                Some((200, body)) => {
                    if let Some(alerts) = body.as_deref().and_then(read_alerts) {
                        self.alerts = alerts;
                    }
                }
                Some((s, _)) if refused(s) => return Poll::Refused,
                // A server from before the list has no alerts to report.
                Some((404, _)) => self.alerts = (false, false),
                _ => {}
            }
        }
        (activity.waiting, activity.needs_you) = self.alerts;
        Poll::Seen(activity)
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
        assert_eq!(answer(200, Some("<html>")), Poll::Failed);
        assert_eq!(answer(200, None), Poll::Failed);
    }

    #[test]
    fn only_a_login_refusal_ends_the_polling() {
        for status in [401, 403, 429] {
            assert_eq!(answer(status, None), Poll::Refused, "{status}");
        }
        for status in [301, 404, 500, 502, 503] {
            assert_eq!(answer(status, None), Poll::Failed, "{status}");
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

    fn plain(working: bool) -> Poll {
        Poll::Seen(Activity {
            working,
            ..Activity::default()
        })
    }

    /// The shape of a real `GET /api/approvals`, with the frame text cut.
    fn approvals(items: &[&str]) -> String {
        format!(r#"{{"success":true,"data":{{"approvals":[{}]}}}}"#, items.join(","))
    }
    const IDLE: &str = r#"{"id":"s:1","sessionId":"s","sessionName":"w4","kind":"idle","createdAt":1,"context":"x"}"#;
    const LOOKED_AT: &str = r#"{"id":"s:2","sessionId":"s","kind":"idle","createdAt":1,"acknowledgedAt":2}"#;
    const PERMISSION: &str = r#"{"id":"s:3","sessionId":"s","kind":"permission","createdAt":1,"toolName":"Bash"}"#;
    const QUESTION: &str = r#"{"id":"s:4","sessionId":"s","kind":"question","createdAt":1}"#;

    #[test]
    fn the_alerts_follow_the_pages_rules() {
        assert_eq!(read_alerts(&approvals(&[])), Some((false, false)));
        assert_eq!(read_alerts(&approvals(&[IDLE])), Some((true, false)));
        assert_eq!(read_alerts(&approvals(&[LOOKED_AT])), Some((false, false)), "seen");
        assert_eq!(read_alerts(&approvals(&[PERMISSION])), Some((false, true)));
        assert_eq!(read_alerts(&approvals(&[QUESTION])), Some((false, true)));
        assert_eq!(read_alerts(&approvals(&[IDLE, PERMISSION])), Some((true, true)));
        assert_eq!(read_alerts("not json"), None);
        assert_eq!(read_alerts(EMPTY), None);
    }

    #[test]
    fn reads_all_three_states_from_one_poll() {
        let busy = r#"{"success":true,"data":[{"status":"busy","mode":"claude"}]}"#;
        let (port, seen_requests) = serve(vec![ok("", busy), ok("", &approvals(&[IDLE, PERMISSION]))]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let mut poller = Poller::new(&server, None, true).unwrap();
        let everything = Activity {
            working: true,
            waiting: true,
            needs_you: true,
        };
        assert_eq!(poller.poll(), Poll::Seen(everything));
        assert!(seen_requests.lock().unwrap()[1][0].starts_with("get /api/approvals "));
    }

    fn status(code: u16) -> String {
        format!("HTTP/1.1 {code} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }

    #[test]
    fn a_server_without_the_list_still_shows_work() {
        let busy = r#"{"data":[{"status":"busy","mode":"claude"}]}"#;
        let (port, _) = serve(vec![ok("", busy), status(404)]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(Poller::new(&server, None, true).unwrap().poll(), plain(true));
    }

    #[test]
    fn a_refused_list_ends_the_polling_and_a_failed_one_keeps_the_last_answer() {
        let (port, _) = serve(vec![ok("", EMPTY), status(401)]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(Poller::new(&server, None, true).unwrap().poll(), Poll::Refused);

        let (port, _) = serve(vec![
            ok("", EMPTY),
            ok("", &approvals(&[PERMISSION])),
            ok("", EMPTY),
            status(500),
        ]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        let mut poller = Poller::new(&server, None, true).unwrap();
        let red = Poll::Seen(Activity {
            needs_you: true,
            ..Activity::default()
        });
        assert_eq!(poller.poll(), red);
        assert_eq!(
            poller.poll(),
            Poll::Seen(Activity {
                needs_you: true,
                ..Activity::default()
            })
        );
    }

    #[test]
    fn no_alert_with_a_style_means_no_second_request() {
        let (port, seen_requests) = serve(vec![ok("", EMPTY)]);
        let server = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(Poller::new(&server, None, false).unwrap().poll(), plain(false));
        assert_eq!(seen_requests.lock().unwrap().len(), 1);
    }

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
        let mut poller = Poller::new(&server, Some("Basic abc".into()), false).unwrap();
        assert_eq!(poller.poll(), plain(true));
        assert_eq!(poller.poll(), plain(true));
        assert_eq!(poller.poll(), plain(false));
        assert_eq!(poller.poll(), plain(false));

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
        assert_eq!(Poller::new(&server, None, false).unwrap().poll(), plain(false));
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
        assert_eq!(Poller::new(&server, None, false).unwrap().poll(), Poll::Failed);
    }
}
