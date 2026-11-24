---
'aicodeman': minor
---

Multi-user mode can sign people in through an authenticating reverse proxy on the same host (single sign-on with Entra ID, Google Workspace, Keycloak and others). With `CODEMAN_TRUSTED_PROXY_SECRET_FILE` set, a loopback request that carries the secret in `X-Codeman-Proxy-Secret` and a username in `X-Codeman-User` signs in as that existing, enabled account. Off by default and experimental. The wiki's Multi-User Mode page has a Caddy and oauth2-proxy walkthrough.
