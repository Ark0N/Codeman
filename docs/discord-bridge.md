# Discord bridge

Codeman can post to a private Discord server when a session needs you, give every tab its own thread, and type your thread reply into that tab. It only makes outbound connections, so Codeman is not exposed to the internet and it works when you are away from your network.

> [!WARNING]
> A reply from an allowed Discord account is typed into agents that can run shell commands. Treat that Discord account like a login to the machine: turn on 2FA and use a strong, unique password.

## What it does

- Posts when a session asks for permission, asks a question, goes idle or errors. Which of these a CLI can raise depends on the hooks it has: Claude Code sends a turn end (`stop`, an `info` event that posts only when **Which events** is set to Everything, and `idle_prompt`, which posts by default after the turn has waited a minute). DeepSeek Harness sends only `stop`. Codex, OMP, OpenCode, Gemini, Antigravity, Pi, Grok and Copilot send no turn end, so they reach Discord through an error, a blocked respawn, a stopped crash loop or their own `codeman notify`; Codex's permission and question dialogs are also read off its screen.
- Posts a finished turn, and an error or blocked alert, as the CLI's whole last message, with its bold, lists and numbered questions kept (a Markdown table, which Discord cannot draw, becomes an aligned code block), split over several posts if it is long. It reads the CLI's transcript where it keeps one (Claude Code, Codex, DeepSeek Harness, OMP) and otherwise splits the screen into turns (OpenCode, Gemini, Antigravity, Pi, Grok, Copilot), which can start mid-message when a long answer has scrolled off. A shell, and a permission or question dialog, show the last lines of the screen instead, without the prompt row and status lines under them.
- Creates one thread per tab in a single parent channel, so a reply always reaches exactly one session.
- Types your reply into that session as a single line followed by Enter. A single digit sent while a permission or question is waiting goes as the key alone, without Enter, because the dialog acts on the keypress.
- Lets a CLI post a deliberate message (for example "press the reset button on the case") with the `codeman notify` command, which calls `POST /api/sessions/:id/discord-notify`. Each tab may post 6 a minute; past that the command says "too many messages", so a looping agent cannot ping your phone without end.
- Saves files you attach in a thread into that tab's working folder and tells the CLI the path. A CLI can send a file back with `codeman notify "message" --file <path>`.
- Tells each CLI about `codeman notify` (see [Telling the CLIs](#telling-the-clis)).

## Setup

Do these once, in order. Never paste the bot token into a chat or a session.

### 1. Create a private server

1. In Discord choose **Add a Server**, **Create My Own**, **For me and my friends**.
2. Invite nobody and create no invite links.
3. Create one text channel, for example `#codeman-cli`.

### 2. Copy the IDs

1. Open **User Settings**, **Advanced** and turn on **Developer Mode**.
2. Right-click the server, the channel and your own avatar, and choose **Copy ID** for each. You need the guild ID, the parent channel ID and your user ID.

### 3. Create the application

1. Go to <https://discord.com/developers/applications> and choose **New Application**.
2. Name it `Codeman`.

### 4. Configure the bot

On the **Bot** tab:

1. Choose **Reset Token** and copy it. It is shown once.
2. Turn **Public Bot** off, so nobody else can add it. Discord refuses this while the app has a default install link, so first open the **Installation** tab, set **Install Link** to **None** (untick Guild Install and User Install if it will not save) and save, then come back here.
3. Leave **Requires OAuth2 Code Grant** off.
4. Under **Privileged Gateway Intents** turn **Message Content Intent** on. Leave **Server Members Intent** and **Presence Intent** off.

### 5. Invite the bot with minimal permissions

On **OAuth2**, **URL Generator**:

1. Tick the scope `bot` only. Do not tick `applications.commands` or anything else.
2. Tick only these permissions (Attach Files and Embed Links are optional: without them, files cannot be sent from a CLI and links show no preview):

   | Permission               | Why                                  |
   | ------------------------ | ------------------------------------ |
   | View Channels            | See the parent channel               |
   | Send Messages            | Post in the parent channel           |
   | Send Messages in Threads | Post in each tab's thread            |
   | Create Public Threads    | Make a thread per tab                |
   | Read Message History     | Read your replies                    |
   | Add Reactions            | Acknowledge a reply that was typed   |
   | Attach Files             | Send a file from a CLI to the thread |
   | Embed Links              | Show previews for links in posts     |

3. Open the generated URL, choose your private server and authorise.
4. Check the **Installation** tab still shows **Install Link: None**, so there is no public way to add the bot.

The ticked boxes are the source of truth. As a cross-check, these eight permissions add up to the permissions integer `309237763136`.

### 6. Optional: allow deleting threads

Only needed for `onSessionDelete: delete`. Give the bot role **Manage Threads** on the parent channel only, as a channel permission override and not server-wide. Skip this if you are happy to keep or archive threads.

### 7. Never grant

Administrator, Manage Channels, Manage Roles, Manage Messages, Mention Everyone, or any voice permission.

### 8. Configure Codeman

1. Open **Settings**, **Notifications**, then the **Discord** group.
2. Enter the bot token, guild ID, parent channel ID and your user ID in the allowlist.
3. Choose the options below and press **Send test**. A test message should appear in the channel.

The token is stored in `~/.codeman/discord.json` with mode 0600. It is never returned by the API, written to logs or sent over SSE.

### 9. Phone alerts

In the Discord mobile app set the server to **All Messages**. Discord's own push notification is what reaches you off-network.

## Options

| Option            | Values                      | Default     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threadCreation`  | `lazy`, `onSessionStart`    | `lazy`      | `lazy` makes a thread on the first notification. `onSessionStart` makes one per new tab                                                                                                                                                                                                                                                                                                                                                           |
| `onSessionDelete` | `keep`, `archive`, `delete` | `archive`   | What happens to the thread when its tab is deleted. `delete` needs Manage Threads                                                                                                                                                                                                                                                                                                                                                                 |
| `staleThreads`    | `keep`, `archive`, `delete` | `keep`      | What happens to threads this bot made that no tab uses any more, checked after startup and then daily. A deleted tab's thread leaves the map, so this also archives or deletes threads that `onSessionDelete` kept or archived. Skips threads under an hour old, other people's threads and other channels, does nothing while the thread map is empty, and closes at most 25 per run. `delete` needs Manage Threads. Use one channel per Codeman |
| `pingMode`        | `off`, `critical`, `all`    | `critical`  | `critical` pings you for permission prompts, questions, errors and urgent posts                                                                                                                                                                                                                                                                                                                                                                   |
| `scope`           | `attention`, `all`          | `attention` | `attention` skips the quiet "response complete" event. `all` sends it too                                                                                                                                                                                                                                                                                                                                                                         |
| `startupHint`     | on, off                     | on          | Tell Claude about `codeman notify` in its system prompt at launch                                                                                                                                                                                                                                                                                                                                                                                 |
| `typedHint`       | on, off                     | off         | Also send the note once, as a first message, to brand-new non-Claude CLI tabs                                                                                                                                                                                                                                                                                                                                                                     |

## Telling the CLIs

A CLI only posts deliberately if it knows it can. While the bridge is on:

- **Claude** (`startupHint`, on by default) is launched with `--append-system-prompt`, so nothing shows in the conversation. This reaches local tabs only: remote (ssh) and Docker launches are built outside the CLI registry, and have no `codeman` command anyway.
- **Every other CLI** is sent nothing unless you turn on `typedHint` (off by default: it costs one model turn per tab, and for a spawned worker or a scheduled run it arrives together with the first real prompt). With it on, the same text is sent once, as a message, the first time a brand-new tab becomes idle. Tabs that are restored when Codeman starts, shell tabs, and remote (ssh) and Docker tabs (which have no `codeman` command) are never sent it.

The text explains `codeman notify "message" --urgent`. `codeman` is on the PATH of every session from the installer or an npm install (a git checkout run without the installer has no `codeman` command) and reads `CODEMAN_SESSION_ID` and `CODEMAN_API_URL`, so no other setup is needed. Without a bridge it prints that the bridge is off and exits cleanly. Tabs started before the bridge was enabled are not told; use the skill or `CLAUDE.md` for those.

## Files

- **Received:** files you attach to a reply from an allowed user are saved as `<working folder>/.codeman-discord/<message id>-<name>` (mode 0600) and the one-line reply the CLI sees ends with `[attached: <paths>]`. At most 5 files of 8 MB each; names are reduced to letters, digits, `.`, `_` and `-`; only Discord's own HTTPS addresses are fetched. Anything skipped is named in the thread. The folder ignores itself (it holds a `.gitignore` of `*`), so nothing in it is committed. Remote (ssh) tabs have no local folder, so no file is saved for them.
- **Sent:** `codeman notify "message" --file <path>` uploads a regular file of at most 8 MB. The real path (symlinks followed) must be inside the tab's working folder, which stops an upload of something outside it by mistake. The agent runs as your user, so this is a guard against accidents, not a sandbox. Remote tabs cannot send files.
- A downloaded file is untrusted content: only allowed users can send one, but a CLI that opens it is exposed to anything written inside it.

## Security model

- Only messages from IDs in `allowedUserIds`, in the configured guild, inside a thread Codeman created, are acted on. Everything else is dropped.
- A reply is reduced to one line, stripped of control characters and capped in length before it is typed.
- Replies are rate limited per session.
- A Discord outage or a bad token never affects sessions. The bridge backs off, and the last error shows in Settings.

## Rotating and revoking

- **Rotate:** in the Developer Portal choose **Bot**, **Reset Token**, paste the new token into Codeman and press **Send test**.
- **Revoke:** kick the bot from the server or delete the application, then choose **Remove token** in Settings. Deleting `~/.codeman/discord.json` alone does not reach a running bridge, which keeps the token it loaded until Codeman restarts.
- If the token is ever pasted somewhere it should not be, reset it straight away.

## Troubleshooting

| Symptom                             | Check                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Test fails with 401                 | The token is wrong or was reset. Paste the current one                   |
| Test fails with 403 or 50001        | The bot cannot see the parent channel. Check the role and the channel ID |
| Posts arrive but replies do nothing | Message Content Intent is off, or your user ID is not in the allowlist   |
| Thread is not deleted               | The bot lacks Manage Threads on the parent channel                       |
| Nothing arrives on the phone        | Check the Discord app's notification setting for the server              |
