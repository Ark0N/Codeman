//! "Is a Codeman server answering at this address, and does it want a login?"
//!
//! One `GET <server>/api/status`, five seconds at most, run off the UI thread.
//! The answer is classified into something the connect page can explain. It is
//! asked on a user action, or by one of the This Mac tab's waits (for an
//! install to bring Codeman up, for a server that is starting), which end at
//! the first answer, never as a standing poll: Codeman counts a request without
//! valid credentials against the login rate limit (10 per IP).

use serde::Serialize;
use std::time::Duration;
use url::Url;

pub const TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_BODY: u64 = 8 * 1024 * 1024;

/// The path the probe asks for, relative to the server's base URL.
const STATUS_PATH: &str = "api/status";

/// rustls' text for `Error::InvalidCertificate`, which is what a handshake
/// with a certificate the OS does not trust fails with. ureq hands it over as
/// an `io::Error` of kind `InvalidData`, so the text is all there is to match
/// without a direct rustls dependency.
const CERT_REJECTED_PREFIX: &str = "invalid peer certificate";

/// std's text for a failed `getaddrinfo`. Its kind is `Uncategorized`, which
/// cannot be matched on stable Rust, so the prefix is the only handle. The
/// prefix is the same on macOS and Linux; only the resolver's reason differs.
const LOOKUP_FAILED_PREFIX: &str = "failed to lookup address information";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProbeOutcome {
    Ok {
        version: String,
    },
    /// 401 and we sent no credentials.
    NeedsLogin,
    /// 401 although we sent credentials.
    BadCredentials,
    /// 429: too many failed logins from this address. A single-user Codeman
    /// still accepts the right password, so the page needs to know whether
    /// this probe carried one. `retry_after_secs` is the server's
    /// `Retry-After`, when it gave one in seconds.
    #[serde(rename_all = "camelCase")]
    RateLimited {
        sent_credentials: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after_secs: Option<u64>,
    },
    /// 403 `PASSWORD_CHANGE_REQUIRED`: the credentials are valid, but a
    /// multi-user Codeman wants this account's password changed first. Page
    /// loads are exempt, so the web UI can show its change-password dialog.
    PasswordChangeRequired,
    /// 403 from Codeman's Host guard (a name it does not know, e.g. a custom domain).
    HostNotAllowed,
    /// 3xx. `location` is the target resolved against the probed URL.
    /// `suggested` is a server address to use instead, set only when the
    /// redirect stays on the same host, only moves to https or another port,
    /// and still points at the status API. Never followed: a second request
    /// would carry the credentials to an address the user did not type.
    Redirect {
        location: String,
        suggested: Option<String>,
    },
    /// Something answered, but not Codeman's status API.
    NotCodeman {
        status: u16,
    },
    Refused,
    /// No route to the address: the machine is off or on another network,
    /// or macOS's Local Network privacy setting blocked the app.
    Unreachable,
    /// An http:// probe whose connection was closed without an answer. A
    /// Codeman started with `--https` does exactly that to plain HTTP.
    MaybeHttps,
    Timeout,
    TlsUntrusted {
        detail: String,
    },
    Unresolvable,
    Failed {
        detail: String,
    },
}

impl ProbeOutcome {
    /// The server's version, when it answered as Codeman.
    pub fn version(&self) -> Option<String> {
        match self {
            ProbeOutcome::Ok { version } => Some(version.clone()),
            _ => None,
        }
    }
}

/// Classify an HTTP answer to `<server>/api/status`. `request` is the URL that
/// was asked, `location` and `retry_after` are those response headers.
pub fn classify_response(
    request: &Url,
    status: u16,
    location: Option<&str>,
    retry_after: Option<&str>,
    sent_credentials: bool,
    body: &str,
) -> ProbeOutcome {
    match status {
        200 => {
            let version = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .filter(|v| v["success"] == true)
                .and_then(|v| v["data"]["version"].as_str().map(str::to_string));
            match version {
                Some(version) => ProbeOutcome::Ok { version },
                None => ProbeOutcome::NotCodeman { status },
            }
        }
        300..=399 => {
            // A 3xx without a usable Location (304, a garbled header) is not a
            // redirect anyone can act on.
            match location.and_then(|l| request.join(l.trim()).ok()) {
                Some(target) => ProbeOutcome::Redirect {
                    suggested: suggested_server(request, &target),
                    location: target.into(),
                },
                None => ProbeOutcome::NotCodeman { status },
            }
        }
        401 if sent_credentials => ProbeOutcome::BadCredentials,
        401 => ProbeOutcome::NeedsLogin,
        403 if body.contains("host not allowed") => ProbeOutcome::HostNotAllowed,
        // Codeman only says this after the Basic credentials verified (the
        // probe sends no cookie), so without credentials it is not Codeman's
        // answer to us, and loading the page without them would not help.
        403 if sent_credentials && error_code(body).as_deref() == Some("PASSWORD_CHANGE_REQUIRED") => {
            ProbeOutcome::PasswordChangeRequired
        }
        429 => ProbeOutcome::RateLimited {
            sent_credentials,
            retry_after_secs: retry_after.and_then(|v| v.trim().parse::<u64>().ok()),
        },
        other => ProbeOutcome::NotCodeman { status: other },
    }
}

/// `errorCode` of a Codeman `ApiResponse` error body.
fn error_code(body: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(parsed.get("errorCode")?.as_str()?.to_string())
}

/// The server base URL a redirect points to, when it is the same server
/// moved to https or another port (a reverse proxy upgrading plain HTTP, the
/// usual case). Anything else, such as another host (a login gateway the
/// window could not pass anyway) or a downgrade to http, gets no suggestion.
fn suggested_server(request: &Url, target: &Url) -> Option<String> {
    let upgrade = request.scheme() == "http" && target.scheme() == "https";
    let port_change =
        request.scheme() == target.scheme() && request.port_or_known_default() != target.port_or_known_default();
    if !(upgrade || port_change) || target.host() != request.host() {
        return None;
    }
    if !target.username().is_empty() || target.password().is_some() {
        return None;
    }
    // The redirect must keep pointing at the status API (a proxy may add a
    // base path in front of it); the base is what comes before it.
    if !target.path().ends_with(request.path()) || !request.path().ends_with(STATUS_PATH) {
        return None;
    }
    let base_path = &target.path()[..target.path().len() - STATUS_PATH.len()];
    let mut base = target.clone();
    base.set_path(base_path);
    base.set_query(None);
    base.set_fragment(None);
    Some(base.into())
}

/// Transport failures, reduced to what the connect page explains differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    Refused,
    Unreachable,
    ClosedWithoutAnswer,
    Timeout,
    Tls(String),
    Dns,
    Other(String),
}

pub fn classify_transport(err: TransportError) -> ProbeOutcome {
    match err {
        TransportError::Refused => ProbeOutcome::Refused,
        TransportError::Unreachable => ProbeOutcome::Unreachable,
        TransportError::ClosedWithoutAnswer => ProbeOutcome::MaybeHttps,
        TransportError::Timeout => ProbeOutcome::Timeout,
        TransportError::Tls(detail) => ProbeOutcome::TlsUntrusted { detail },
        TransportError::Dns => ProbeOutcome::Unresolvable,
        TransportError::Other(detail) => ProbeOutcome::Failed { detail },
    }
}

/// `plain_http`: the probe went to an http:// URL. Only there does a closed
/// connection hint at an https-only server; over https the same close is a
/// failed handshake with nothing more to say about it.
fn transport_error(err: &ureq::Error, plain_http: bool) -> TransportError {
    use std::io::ErrorKind;
    match err {
        ureq::Error::Timeout(_) => TransportError::Timeout,
        ureq::Error::HostNotFound => TransportError::Dns,
        ureq::Error::ConnectionFailed => TransportError::Refused,
        // ureq passes both a rejected certificate (rustls wraps it as
        // InvalidData during the handshake) and a failed name lookup (std's
        // own error) through as plain io errors, so they are told apart here
        // before the kinds below swallow them.
        ureq::Error::Io(e) if e.kind() == ErrorKind::InvalidData && e.to_string().starts_with(CERT_REJECTED_PREFIX) => {
            TransportError::Tls(e.to_string())
        }
        ureq::Error::Io(e) if e.raw_os_error().is_none() && e.to_string().starts_with(LOOKUP_FAILED_PREFIX) => {
            TransportError::Dns
        }
        ureq::Error::Io(e) => match e.kind() {
            ErrorKind::ConnectionRefused | ErrorKind::ConnectionReset | ErrorKind::AddrNotAvailable => {
                TransportError::Refused
            }
            ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => TransportError::Unreachable,
            ErrorKind::UnexpectedEof if plain_http => TransportError::ClosedWithoutAnswer,
            ErrorKind::TimedOut | ErrorKind::WouldBlock => TransportError::Timeout,
            _ => TransportError::Other(e.to_string()),
        },
        // ureq's own rustls errors come from setting up the TLS client (the
        // handshake's arrive as Io above); only a certificate rejection is
        // "untrusted", anything else is reported as it is.
        ureq::Error::Rustls(e) if e.to_string().starts_with(CERT_REJECTED_PREFIX) => TransportError::Tls(e.to_string()),
        other => TransportError::Other(other.to_string()),
    }
}

/// Ask the server. Blocking: call it from a worker thread.
pub fn probe(server: &Url, authorization: Option<&str>) -> ProbeOutcome {
    probe_within(server, authorization, TIMEOUT)
}

/// The app's one way of asking a server something: the OS's certificate trust,
/// a bound on the whole exchange, and status codes as answers.
pub fn agent(timeout: Duration) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        // Never follow: a 3xx comes back as an answer and is explained.
        .max_redirects(0)
        .tls_config(tls)
        .user_agent(concat!("CodemanDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// `probe` with the time the whole exchange may take.
pub fn probe_within(server: &Url, authorization: Option<&str>, timeout: Duration) -> ProbeOutcome {
    let status_url = match server.join(STATUS_PATH) {
        Ok(u) => u,
        Err(e) => return ProbeOutcome::Failed { detail: e.to_string() },
    };
    let mut req = agent(timeout)
        .get(status_url.as_str())
        .header("Accept", "application/json");
    if let Some(auth) = authorization {
        req = req.header("Authorization", auth);
    }
    match req.call() {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let header = |name: &str| {
                resp.headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            let location = header("location");
            let retry_after = header("retry-after");
            let body = match resp.body_mut().with_config().limit(MAX_BODY).read_to_string() {
                Ok(body) => body,
                // The answer began but did not finish in time. Where the body
                // decides what answered (200, 403), that is a timeout, not
                // "something else answers here".
                Err(e) if matches!(status, 200 | 403) && transport_error(&e, false) == TransportError::Timeout => {
                    return ProbeOutcome::Timeout;
                }
                Err(_) => String::new(),
            };
            classify_response(
                &status_url,
                status,
                location.as_deref(),
                retry_after.as_deref(),
                authorization.is_some(),
                &body,
            )
        }
        Err(e) => classify_transport(transport_error(&e, status_url.scheme() == "http")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn status_url() -> Url {
        Url::parse("http://studio.lan:3000/api/status").unwrap()
    }

    /// `classify_response` for the cases that need no headers.
    fn classify(status: u16, sent_credentials: bool, body: &str) -> ProbeOutcome {
        classify_response(&status_url(), status, None, None, sent_credentials, body)
    }

    fn redirect(request: &str, location: &str) -> ProbeOutcome {
        classify_response(&Url::parse(request).unwrap(), 301, Some(location), None, false, "")
    }

    fn io_outcome(kind: io::ErrorKind, message: &str, plain_http: bool) -> ProbeOutcome {
        let err = ureq::Error::Io(io::Error::new(kind, message.to_string()));
        classify_transport(transport_error(&err, plain_http))
    }

    #[test]
    fn ok_needs_success_and_version() {
        assert_eq!(
            classify(
                200,
                false,
                r#"{"success":true,"data":{"version":"1.47.0","sessions":[]}}"#
            ),
            ProbeOutcome::Ok {
                version: "1.47.0".into()
            }
        );
        assert_eq!(
            classify(200, false, "<html>hello</html>"),
            ProbeOutcome::NotCodeman { status: 200 }
        );
        assert_eq!(
            classify(200, false, r#"{"success":false,"data":{"version":"1"}}"#),
            ProbeOutcome::NotCodeman { status: 200 }
        );
        assert_eq!(
            classify(200, false, r#"{"success":true}"#),
            ProbeOutcome::NotCodeman { status: 200 }
        );
    }

    #[test]
    fn auth_and_guards() {
        assert_eq!(classify(401, false, "Unauthorized"), ProbeOutcome::NeedsLogin);
        assert_eq!(classify(401, true, "Unauthorized"), ProbeOutcome::BadCredentials);
        assert_eq!(
            classify(403, false, "Forbidden: host not allowed"),
            ProbeOutcome::HostNotAllowed
        );
        // The Host guard runs before authentication, so it wins even with credentials.
        assert_eq!(
            classify(403, true, "Forbidden: host not allowed"),
            ProbeOutcome::HostNotAllowed
        );
        assert_eq!(classify(403, false, "nope"), ProbeOutcome::NotCodeman { status: 403 });
        assert_eq!(classify(502, false, ""), ProbeOutcome::NotCodeman { status: 502 });
    }

    /// The exact body auth.ts sends: `createErrorResponse(PASSWORD_CHANGE_REQUIRED)`.
    #[test]
    fn password_change_required_only_after_sent_credentials() {
        let body = r#"{"success":false,"error":"You must change your password before continuing","errorCode":"PASSWORD_CHANGE_REQUIRED"}"#;
        assert_eq!(classify(403, true, body), ProbeOutcome::PasswordChangeRequired);
        assert_eq!(classify(403, false, body), ProbeOutcome::NotCodeman { status: 403 });
        // Another Codeman error code, or the text without the JSON field, is not it.
        assert_eq!(
            classify(403, true, r#"{"success":false,"errorCode":"FORBIDDEN"}"#),
            ProbeOutcome::NotCodeman { status: 403 }
        );
        assert_eq!(
            classify(403, true, "PASSWORD_CHANGE_REQUIRED"),
            ProbeOutcome::NotCodeman { status: 403 }
        );
    }

    #[test]
    fn rate_limited_says_whether_credentials_went_along() {
        let body = "Too Many Requests, try again later";
        assert_eq!(
            classify(429, false, body),
            ProbeOutcome::RateLimited {
                sent_credentials: false,
                retry_after_secs: None
            }
        );
        assert_eq!(
            classify(429, true, body),
            ProbeOutcome::RateLimited {
                sent_credentials: true,
                retry_after_secs: None
            }
        );
        // auth.ts sends Retry-After in whole seconds; an HTTP date is not parsed.
        assert_eq!(
            classify_response(&status_url(), 429, None, Some(" 742 "), true, body),
            ProbeOutcome::RateLimited {
                sent_credentials: true,
                retry_after_secs: Some(742)
            }
        );
        assert_eq!(
            classify_response(
                &status_url(),
                429,
                None,
                Some("Wed, 21 Oct 2026 07:28:00 GMT"),
                false,
                body
            ),
            ProbeOutcome::RateLimited {
                sent_credentials: false,
                retry_after_secs: None
            }
        );
    }

    #[test]
    fn redirect_to_https_on_the_same_host_is_suggested() {
        assert_eq!(
            redirect("http://studio.lan/api/status", "https://studio.lan/api/status"),
            ProbeOutcome::Redirect {
                location: "https://studio.lan/api/status".into(),
                suggested: Some("https://studio.lan/".into())
            }
        );
        // A base path the proxy adds stays part of the suggestion; a query does not.
        assert_eq!(
            redirect(
                "http://studio.lan:3000/api/status",
                "https://studio.lan/codeman/api/status?from=http"
            ),
            ProbeOutcome::Redirect {
                location: "https://studio.lan/codeman/api/status?from=http".into(),
                suggested: Some("https://studio.lan/codeman/".into())
            }
        );
        // A relative Location resolves against the probed URL; another port is fine.
        assert_eq!(
            redirect(
                "http://studio.lan:3000/base/api/status",
                "//studio.lan:3001/base/api/status"
            ),
            ProbeOutcome::Redirect {
                location: "http://studio.lan:3001/base/api/status".into(),
                suggested: Some("http://studio.lan:3001/base/".into())
            }
        );
    }

    #[test]
    fn other_redirects_are_reported_without_a_suggestion() {
        // Another host (a login gateway, say).
        assert_eq!(
            redirect("http://studio.lan/api/status", "https://sso.example.com/login?next=x"),
            ProbeOutcome::Redirect {
                location: "https://sso.example.com/login?next=x".into(),
                suggested: None
            }
        );
        // Same host, but no longer the status API.
        assert_eq!(
            redirect("http://studio.lan/api/status", "/login"),
            ProbeOutcome::Redirect {
                location: "http://studio.lan/login".into(),
                suggested: None
            }
        );
        // A downgrade to plain http.
        assert_eq!(
            redirect("https://studio.lan/api/status", "http://studio.lan/api/status"),
            ProbeOutcome::Redirect {
                location: "http://studio.lan/api/status".into(),
                suggested: None
            }
        );
        // Same scheme and port, only the path moved.
        assert_eq!(
            redirect("http://studio.lan/api/status", "/x/api/status"),
            ProbeOutcome::Redirect {
                location: "http://studio.lan/x/api/status".into(),
                suggested: None
            }
        );
        // Credentials in the target are never suggested.
        assert_eq!(
            redirect("http://studio.lan/api/status", "https://u:p@studio.lan/api/status"),
            ProbeOutcome::Redirect {
                location: "https://u:p@studio.lan/api/status".into(),
                suggested: None
            }
        );
        // No Location (304), or one that does not parse: nothing to act on.
        assert_eq!(
            classify_response(&status_url(), 304, None, None, false, ""),
            ProbeOutcome::NotCodeman { status: 304 }
        );
        assert_eq!(
            classify_response(&status_url(), 302, Some("http://[::1"), None, false, ""),
            ProbeOutcome::NotCodeman { status: 302 }
        );
    }

    #[test]
    fn transport_classes() {
        assert_eq!(classify_transport(TransportError::Refused), ProbeOutcome::Refused);
        assert_eq!(classify_transport(TransportError::Timeout), ProbeOutcome::Timeout);
        assert_eq!(classify_transport(TransportError::Dns), ProbeOutcome::Unresolvable);
        assert_eq!(
            classify_transport(TransportError::Tls("bad cert".into())),
            ProbeOutcome::TlsUntrusted {
                detail: "bad cert".into()
            }
        );
    }

    /// The io errors exactly as ureq hands them over (`Error::Io`).
    #[test]
    fn io_errors_are_told_apart() {
        use io::ErrorKind;
        // rustls' certificate rejection from the handshake.
        let cert = "invalid peer certificate: UnknownIssuer";
        assert_eq!(
            io_outcome(ErrorKind::InvalidData, cert, false),
            ProbeOutcome::TlsUntrusted { detail: cert.into() }
        );
        // Any other InvalidData (a port that does not speak TLS, say) is not a certificate problem.
        assert_eq!(
            io_outcome(
                ErrorKind::InvalidData,
                "received corrupt message of type InvalidContentType",
                false
            ),
            ProbeOutcome::Failed {
                detail: "received corrupt message of type InvalidContentType".into()
            }
        );
        // std's getaddrinfo failure (its real kind, Uncategorized, cannot be built on stable).
        assert_eq!(
            io_outcome(
                ErrorKind::Other,
                "failed to lookup address information: nodename nor servname provided, or not known",
                true
            ),
            ProbeOutcome::Unresolvable
        );
        // The same text from the OS (an errno) is not a lookup failure.
        let os = ureq::Error::Io(io::Error::from_raw_os_error(1));
        assert!(!matches!(
            classify_transport(transport_error(&os, true)),
            ProbeOutcome::Unresolvable
        ));
        // ureq's "Peer disconnected": over http a hint at https, over https just a failure.
        assert_eq!(
            io_outcome(ErrorKind::UnexpectedEof, "Peer disconnected", true),
            ProbeOutcome::MaybeHttps
        );
        assert_eq!(
            io_outcome(ErrorKind::UnexpectedEof, "Peer disconnected", false),
            ProbeOutcome::Failed {
                detail: "Peer disconnected".into()
            }
        );
        // No route: Local Network privacy, or a machine that is off.
        assert_eq!(
            io_outcome(ErrorKind::HostUnreachable, "No route to host", true),
            ProbeOutcome::Unreachable
        );
        assert_eq!(
            io_outcome(ErrorKind::NetworkUnreachable, "Network is unreachable", false),
            ProbeOutcome::Unreachable
        );
        assert_eq!(
            io_outcome(ErrorKind::ConnectionRefused, "Connection refused", true),
            ProbeOutcome::Refused
        );
        assert_eq!(
            classify_transport(transport_error(&ureq::Error::HostNotFound, true)),
            ProbeOutcome::Unresolvable
        );
        // A ureq TLS setup message is not an untrusted certificate.
        assert_eq!(
            classify_transport(transport_error(
                &ureq::Error::Tls("Rustls invalid dns name error"),
                false
            )),
            ProbeOutcome::Failed {
                detail: "Rustls invalid dns name error".into()
            }
        );
    }

    #[test]
    fn outcome_serializes_for_the_page() {
        let json = |o: ProbeOutcome| serde_json::to_value(o).unwrap();
        assert_eq!(
            json(ProbeOutcome::NotCodeman { status: 404 }),
            serde_json::json!({"kind":"notCodeman","status":404})
        );
        assert_eq!(json(ProbeOutcome::NeedsLogin), serde_json::json!({"kind":"needsLogin"}));
        assert_eq!(
            json(ProbeOutcome::RateLimited {
                sent_credentials: true,
                retry_after_secs: None
            }),
            serde_json::json!({"kind":"rateLimited","sentCredentials":true})
        );
        assert_eq!(
            json(ProbeOutcome::RateLimited {
                sent_credentials: false,
                retry_after_secs: Some(60)
            }),
            serde_json::json!({"kind":"rateLimited","sentCredentials":false,"retryAfterSecs":60})
        );
        assert_eq!(
            json(ProbeOutcome::PasswordChangeRequired),
            serde_json::json!({"kind":"passwordChangeRequired"})
        );
        assert_eq!(
            json(ProbeOutcome::Redirect {
                location: "https://studio.lan/api/status".into(),
                suggested: Some("https://studio.lan/".into())
            }),
            serde_json::json!({"kind":"redirect","location":"https://studio.lan/api/status","suggested":"https://studio.lan/"})
        );
        assert_eq!(
            json(ProbeOutcome::Redirect {
                location: "https://sso.example.com/".into(),
                suggested: None
            }),
            serde_json::json!({"kind":"redirect","location":"https://sso.example.com/","suggested":null})
        );
        assert_eq!(
            json(ProbeOutcome::Unreachable),
            serde_json::json!({"kind":"unreachable"})
        );
        assert_eq!(json(ProbeOutcome::MaybeHttps), serde_json::json!({"kind":"maybeHttps"}));
        assert_eq!(
            json(ProbeOutcome::TlsUntrusted { detail: "x".into() }),
            serde_json::json!({"kind":"tlsUntrusted","detail":"x"})
        );
        assert_eq!(
            json(ProbeOutcome::Unresolvable),
            serde_json::json!({"kind":"unresolvable"})
        );
    }

    /// Against real sockets: a closed port is `Refused`, a listener that
    /// speaks HTTP but not Codeman is `NotCodeman`, a fake Codeman is `Ok`,
    /// a 401 is `NeedsLogin`, a redirect is reported without being followed,
    /// and a listener that hangs up without answering is `MaybeHttps`.
    #[test]
    fn probe_against_local_sockets() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let url = Url::parse(&format!("http://127.0.0.1:{closed}/")).unwrap();
        assert_eq!(probe(&url, None), ProbeOutcome::Refused);

        /// Accept one connection, read the request and send `response`
        /// (nothing, then close, for an empty one).
        fn serve_raw(response: String) -> u16 {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    // Read the whole request head (a GET has no body) so that
                    // closing sends a FIN, not a reset for unread bytes.
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = s.write_all(response.as_bytes());
                }
            });
            port
        }
        fn serve_once(status_line: &str, extra_headers: &str, body: &str) -> u16 {
            serve_raw(format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n{body}",
                body.len()
            ))
        }

        let p = serve_once("200 OK", "", r#"{"success":true,"data":{"version":"9.9.9"}}"#);
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(
            probe(&url, None),
            ProbeOutcome::Ok {
                version: "9.9.9".into()
            }
        );

        let p = serve_once("404 Not Found", "", "nope");
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(probe(&url, None), ProbeOutcome::NotCodeman { status: 404 });

        let p = serve_once("401 Unauthorized", "", "Unauthorized");
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(probe(&url, None), ProbeOutcome::NeedsLogin);

        let p = serve_once("429 Too Many Requests", "Retry-After: 30\r\n", "Too Many Requests");
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(
            probe(&url, Some("Basic YWRtaW46eA==")),
            ProbeOutcome::RateLimited {
                sent_credentials: true,
                retry_after_secs: Some(30)
            }
        );

        // Nothing listens on the redirect target: had it been followed, the
        // answer would be Refused instead.
        let p = serve_once(
            "301 Moved Permanently",
            &format!("Location: https://127.0.0.1:{closed}/api/status\r\n"),
            "",
        );
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(
            probe(&url, None),
            ProbeOutcome::Redirect {
                location: format!("https://127.0.0.1:{closed}/api/status"),
                suggested: Some(format!("https://127.0.0.1:{closed}/"))
            }
        );

        let p = serve_raw(String::new());
        let url = Url::parse(&format!("http://127.0.0.1:{p}/")).unwrap();
        assert_eq!(probe(&url, None), ProbeOutcome::MaybeHttps);
    }

    /// A Codeman that sends its status headers and then stalls (a blocked
    /// event loop, a lossy link) did not answer in time: a Timeout, not
    /// NotCodeman ("something else on this port").
    #[test]
    fn a_body_that_stalls_is_a_timeout() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        /// Send `head` and the start of a body, then hold the connection open.
        fn serve_stalling(status_line: &'static str) -> u16 {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(
                        format!("HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{{\"success\":true,").as_bytes(),
                    );
                    std::thread::sleep(Duration::from_secs(3));
                }
            });
            port
        }
        let short = Duration::from_millis(400);

        let url = Url::parse(&format!("http://127.0.0.1:{}/", serve_stalling("200 OK"))).unwrap();
        assert_eq!(probe_within(&url, None, short), ProbeOutcome::Timeout);

        // A 401 has said all it needs to with its status line.
        let url = Url::parse(&format!("http://127.0.0.1:{}/", serve_stalling("401 Unauthorized"))).unwrap();
        assert_eq!(probe_within(&url, None, short), ProbeOutcome::NeedsLogin);
    }
}
