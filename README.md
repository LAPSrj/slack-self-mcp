# slack-self-mcp

**Let your AI coding agents talk to you on Slack — as you.**

This is an MCP server for AI agents (Claude Code, Claude Desktop, or any MCP
client) that need a real back-and-forth handoff channel with the human they're
working for. Your agent posts in your real Slack channels and DMs, attaches
screenshots and generated files, reads replies, and responds in-thread — all
under your user account. Pair it with the included Socket Mode listener and
Claude Code's `Monitor` tool, and the agent gets pushed each inbound message
as it arrives, so it can keep going while you're away from your laptop.

What that buys you:

- **Long-running tasks become async.** The agent can run for an hour, share a
  screenshot when it hits something ambiguous, and wait for your reply from
  the bus / kitchen / phone — no terminal required.
- **File handoffs work.** Screenshots, build artifacts, generated images,
  PDFs — uploaded as real Slack file attachments, downloadable both ways
  (`slack_send` for upload, `slack_file_download` for the reverse).
- **It's just Slack.** Threaded replies, mobile notifications, search — the
  conversation lives in tools you already use, not in a bespoke agent UI.

A typical exchange:

```
# agent posts in your DM with itself, attaching a screenshot
slack_send({ target: "@me", text: "PR ready — preview attached", file_paths: ["/tmp/diff.png"] })

# you reply from your phone; the listener emits to the agent's Monitor:
{ "user_name": "leandro", "text": "looks good, ship it", "thread_ts": "..." }

# agent reads the thread + responds in-thread
slack_send({ target: "C012345", thread_ts: "...", text: "shipped at abc1234" })
```

## Why a separate MCP for this

The default `mcp__claude_ai_Slack__*` connector can't upload files, and the
Google Drive MCP's `create_file` breaks on binary uploads above ~10K base64
chars. So the moment your agent needs to show you a screenshot, hand over a
generated artifact, or read an image attachment from a Slack thread, it's
stuck. This server fills that gap by going through a Slack **user** OAuth
token (`xoxp-`), so posts land as you — in real channels and DMs — with
files actually attached.

## Tools

### `slack_send`

```ts
slack_send(
  target: string | string[],        // single ref, or array of 2-8 user refs (MPIM)
  text?: string,
  file_paths?: string[],
  thread_ts?: string,
)
  → { channel_id, ts, file_ids?, resolved_target }
  → on miss/ambiguity: { error: "no_match" | "ambiguous" | "not_a_user" | "too_many_users", input, candidates: [...], hint, failed_input?, more_available? }
```

`target` accepts either a single reference:

- `#channel-name`
- channel ID (`C…` / `G…`)
- `@handle`
- user ID (`U…` / `W…`)
- email address
- bare string (searches both channels and users)

…or an **array of 2-8 user references** — in which case slack-self opens an
MPIM (group DM) for that user set via `conversations.open` and posts to the
returned channel. Each element must resolve to a user; mixing in a channel
ref returns `not_a_user`. Self is silently dropped (Slack auto-includes the
caller), and duplicate IDs are deduped. `conversations.open` is idempotent,
so passing the same user set repeatedly returns the same MPIM channel — no
new conversation is created. A length-1 array is treated the same as the
equivalent single string.

On a unique single match, posts text via `chat.postMessage`. If `file_paths`
is non-empty, each file is then uploaded via `files_upload_v2` and threaded
under the parent message.

On a typo or partial name, returns up to 10 candidates with `target_id`s — the
agent re-calls `slack_send` with one of those `target_id`s. For array form,
the offending entry is reported as `failed_input`. No separate resolver round
trip required.

### `slack_edit`

```ts
slack_edit(channel_id: string, ts: string, text: string)
  → { channel_id, ts }
```

Calls `chat.update`. With a user token Slack only allows editing messages the
same user posted; the API error is surfaced verbatim if it fails. `text`
fully replaces the previous text (this is not a delta API). For threaded
replies, `ts` is the reply's own `ts` (not the parent `thread_ts`).

### `slack_history`

```ts
slack_history(
  target: string | string[],
  limit?: number,
  thread_ts?: string,
  before_ts?: string,
)
  → { channel_id, resolved_target, messages: Message[], has_more: boolean }
  → on miss/ambiguity: { error, candidates, hint, more_available? }   // same shape as slack_send
```

`target` follows the same rules as `slack_send` — a single reference, or an
array of 2-8 user refs (resolved to the corresponding MPIM, idempotently).

- Without `thread_ts`: recent messages in the channel/DM via
  `conversations.history`.
- With `thread_ts`: full reply set via `conversations.replies` (Slack returns
  the parent as the first item — preserved).
- `before_ts` paginates backward (passed as the API's `latest` cursor).
- `limit` defaults to 20, capped at 100.

`Message` shape:

```ts
{
  ts: string,
  user: string | null,            // U…
  user_name: string | null,       // resolved display name
  text: string,
  thread_ts?: string,
  subtype?: string,               // "bot_message", "file_share", "channel_join", …
  bot_id?: string,
  edited?: { user, ts },
  files?: [{ id, name, mimetype, url_private, permalink }],
  reactions?: [{ name, count, users: string[] }]
}
```

Subtype-bearing messages (joins, edits, file shares) are **not** filtered —
the agent decides what's relevant.

### `slack_file_download`

```ts
slack_file_download(
  file_id?: string,        // F… — preferred; calls files.info to get url_private + name
  url?: string,            // direct https://files.slack.com/… url_private
  dest_path?: string,      // absolute file path, or absolute directory (uses original filename)
  overwrite?: boolean,     // default false → error if dest_path exists
)
  → { file_id, name, mimetype, size, expected_size, dest_path }
```

Downloads a Slack-hosted file (typically an attachment surfaced via
`slack_history` or the listener) to local disk. The GET against `url_private`
is authenticated with the user OAuth token; without `files:read` Slack returns
a login HTML page rather than the bytes — this tool detects that and fails
loudly rather than writing HTML to disk.

One of `file_id` / `url` is required. `file_id` is preferred — `files.info`
recovers the original filename and mimetype, which the response surfaces back.
With only `url`, the response carries `name: null, mimetype: null`.

`dest_path` is **recommended**. Pass an absolute file path, or an absolute
directory (trailing `/` or an existing dir → original filename appended). If
omitted, the file lands in `/tmp/<filename>` — fine for an immediate `Read`,
but `/tmp` is ephemeral; specify a real directory for anything you want to
keep.

### `slack_listen_instructions`

```ts
slack_listen_instructions(
  watch_self?: boolean,        // include events authored by the token-holder (default: drop)
  channel?: string,            // filter to one channel ID
  thread?: string,             // filter to one thread (matches thread_ts or parent ts)
  include_subtypes?: boolean,  // include edits / joins / file_share / bot_message etc.
)
  → {
    monitor: { command, description, persistent, timeout_ms },
    stream_binary_path: string,
    stream_binary_exists: boolean,
    filters: { watch_self, include_subtypes, channel, thread },
    singleton: {
      alive, pid, heartbeat_age_ms,
      events_file_path, events_file_present,
      log_path, ensure_result,
    },
    runtime_tokens_path, runtime_tokens_file_present,
    recent_sends_path, recent_sends_ttl_ms,
    notes: string[],
  }
```

Returns the `Monitor()` parameters needed to consume the Slack event stream.
The architecture has two pieces: ONE singleton listener daemon per machine
owns the Slack Socket Mode connection and writes shaped events to
`events.jsonl`; each agent's `Monitor` invokes a per-agent stream binary
(`scripts/slack-listen-stream.mjs`) that tails+filters that file. The MCP
server ensures the singleton is running at boot, and re-ensures on each
call to this tool. See §Listener below for the full model.

Pass the returned `monitor` object straight into Claude Code's `Monitor`
tool. The filters baked into the returned command live on the per-agent
binary, so two agents in different tabs get independently-filtered streams
off the same shared singleton.

### `slack_resolve`

```ts
slack_resolve(target: string)
  → { matches: [{ target_id, type, display, name?, real_name?, email? }, …], more_available? }
```

Same engine as the `slack_send` fallback, exposed for introspection.

## Setup

### 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
   Name it (e.g. `claude-self`) and pick the target workspace.
2. **Socket Mode** → enable. Generate an app-level token with the
   `connections:write` scope. Save the `xapp-…` token — this is
   `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → under **User Token Scopes**, add:
   - `chat:write`
   - `files:write`
   - `im:write`
   - `mpim:write`         *(open MPIMs / group DMs — slack_send & slack_history when target is an array of users)*
   - `users:read`
   - `users:read.email`
   - `channels:read`
   - `groups:read`
   - `mpim:read`
   - `im:read`
   - `channels:history`   *(slack_history on public channels)*
   - `groups:history`     *(slack_history on private channels)*
   - `im:history`         *(slack_history on DMs)*
   - `mpim:history`       *(slack_history on group DMs)*
   - `reactions:read`     *(reactions on history results)*
   - `files:read`         *(slack_file_download — files.info + url_private GET)*

   **If you add scopes after the initial install, you must reinstall the app
   to the workspace** (Settings → Install App → Reinstall). The existing
   `xoxp-…` token is invalidated and replaced; copy the new one into
   `SLACK_USER_TOKEN`.
4. **Event Subscriptions** → enable. Under **Subscribe to events on behalf
   of users**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
5. **Install App** → install to the workspace. Copy the **User OAuth Token**
   (`xoxp-…`) — this is `SLACK_USER_TOKEN`.
6. For private channels you want the MCP to post into, manually invite your
   user (the token holder is you).

### 2. Install dependencies

```bash
cd <repo-path>
npm install
```

Requires Node ≥ 20. `<repo-path>` is wherever you cloned this repo; substitute
its absolute path in the snippets below.

### 3. Configure environment

Copy `.env.example` to `.env` and fill in both tokens, **or** set them in the
MCP server config (next step). The server reads from `process.env`; either
works.

### 4. Register the MCP server

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "slack-self": {
      "command": "node",
      "args": ["<repo-path>/src/server.mjs"],
      "env": {
        "SLACK_USER_TOKEN": "xoxp-…",
        "SLACK_APP_TOKEN": "xapp-…"
      }
    }
  }
}
```

Then restart Claude Code. Tools appear as `mcp__slack-self__slack_send`, etc.

> `SLACK_APP_TOKEN` is consumed by the listener, not the MCP server itself.
> Setting it in the MCP env is required because the server publishes its env
> tokens to a runtime file (see §Listener) that the listener reads when its
> own env is stripped — which is what happens when Monitor spawns it.

### 5. Use it from a session

```
mcp__slack-self__slack_send({ target: "@filmstoat", text: "test", file_paths: ["/tmp/foo.png"] })
```

## Listener (singleton + per-agent stream)

The listener is split into two pieces:

1. **Singleton daemon** — `scripts/slack-listen.mjs`. One per machine + user
   token. Owns the Slack Socket Mode connection, dedups echoes of our own
   `slack_send` / `slack_edit` posts, and appends shaped+enriched events
   to `events.jsonl`. Spawned automatically when the MCP server boots or
   when any per-agent stream binary boots — `ensureRunning()` is idempotent
   and race-safe (concurrent boots only produce one daemon).
2. **Per-agent stream binary** — `scripts/slack-listen-stream.mjs`. One
   process per `Monitor` invocation. Tails `events.jsonl` (rotation-aware
   via inode tracking), applies the agent's filters (`--watch-self` /
   `--no-self` / `--channel` / `--thread` / `--include-subtypes`), and
   writes survivors to stdout. No Socket Mode connection of its own.

**Why this shape:** Slack Socket Mode load-balances events across all
WebSocket clients connected with the same App token. The previous
per-tab-listener design meant N MCP tabs → events sharded ~1/N, so each
agent saw only its fraction. Worse, orphan listeners from crashed sessions
held shares forever and silently stole events from live ones. The singleton
collapses everything to one WebSocket, so every event hits the one consumer
that fans out via `events.jsonl`.

### Calling it from a session

Easiest path: ask the MCP for the invocation.

```
slack_listen_instructions({ watch_self: true, channel: "C012345" })
  → {
    monitor: {
      command: "node <…>/scripts/slack-listen-stream.mjs --watch-self --channel C012345",
      description: "Slack",
      persistent: true,
      timeout_ms: 3600000,
    },
    singleton: { alive: true, pid: 12345, heartbeat_age_ms: 4, … },
    …
  }
```

Pass the returned `monitor` object straight into Claude Code's `Monitor` tool.
Each stdout line is one shaped JSON event:

```json
{
  "ts": "1715000000.123456",
  "channel": "C0123456789",
  "channel_name": "#general",
  "user": "U0123456789",
  "user_name": "alice",
  "user_real_name": "Alice Example",
  "is_self": false,
  "text": "hi there",
  "thread_ts": null,
  "subtype": null,
  "bot_id": null,
  "files": [{ "id": "F…", "name": "foo.png", "mimetype": "image/png", "url": "https://files.slack.com/…" }]
}
```

Synthetic events for stream-health detection appear as
`{"event":"slack_connected","at":<ms>}` and `{"event":"slack_disconnected","at":<ms>,"error":…}` —
these always pass through any filter so consumers can detect gaps.

### Run directly (debugging)

```bash
# Run the singleton manually (it will refuse to start a second one — heartbeat check):
SLACK_USER_TOKEN=xoxp-… SLACK_APP_TOKEN=xapp-… node scripts/slack-listen.mjs

# Tail it via the stream binary in another shell:
node scripts/slack-listen-stream.mjs --watch-self
```

To bring up the singleton without writing your own command, just call
`slack_listen_instructions()` once — the MCP server ensures it on each call.

### Runtime files

All under `$XDG_RUNTIME_DIR/slack-self-mcp/` (or `/tmp/slack-self-mcp-<uid>/`
if `XDG_RUNTIME_DIR` is unset), parent dir `0700`, every file `0600`.

| File | Owner | Purpose |
|---|---|---|
| `tokens.env` | MCP server | Tokens for the singleton (Monitor strips child env; this is the fallback) |
| `recent-sends.jsonl` | MCP servers (shared) | Echo-suppression. Each successful `slack_send`/`slack_edit` appends `{ts,channel,sent_at}`; singleton drops matching events before they reach `events.jsonl`. TTL 5 min. |
| `listener.heartbeat` | Singleton | mtime touched every 10s; ensureRunning treats >30s as dead |
| `listener.pid` | Singleton | Diagnostic — current singleton's pid |
| `listener.spawn.lock` | ensureRunning | O_EXCL ephemeral lock during spawn; prevents concurrent double-spawn |
| `listener.log` | Singleton | Singleton's stderr (boot, errors, rotation events) |
| `events.jsonl` | Singleton | Append-only event stream consumed by stream binaries. Rotated to `events.1.jsonl` at 5 MB (two-segment scheme) |
| `events.1.jsonl` | Singleton | Previous segment; transparently followed by in-flight stream binaries via inode tracking |
| `stream-heartbeats/<pid>.heartbeat` | Stream binaries | One per active subscriber; diagnostic only |

### Permission UX

Grant `Bash` permission once for the named stream binary:

```
node /home/leandro/repos/slack-self-mcp/scripts/slack-listen-stream.mjs *
```

(Wildcard covers all filter combinations.) Every agent's `Monitor` call
from `slack_listen_instructions()` matches this pattern — no per-call
permission prompts.

### Watch-self caveat (Slack platform)

`watch_self: true` toggles whether the stream binary surfaces events
where `is_self: true` (the token-holder authored them). It does NOT
change what Slack delivers over Socket Mode. Empirically (2026-05-25),
user-token Socket Mode does NOT reliably deliver `message.im` events
authored by the token-holder via the Slack client — so a self-typed
DM may not arrive regardless of this flag. File-share events from
the same user DO arrive. Behavior in `message.channels` /
`message.mpim` / `message.groups` is unclear; treat watch-self as
"do not filter" rather than "guarantee delivery." Echoes of our own
`slack_send` are always suppressed at the singleton level before they
reach the stream binary, so you never see your own posts come back.

### Token handoff (Monitor strips env)

Monitor spawns child processes with a stripped environment, so a
Monitor-launched stream binary does **not** inherit `SLACK_USER_TOKEN` /
`SLACK_APP_TOKEN` from the session. The stream binary doesn't need them
directly (it just reads `events.jsonl`), but it does spawn the singleton
on first boot — and the singleton DOES need them. The MCP server writes
its tokens to `tokens.env` at startup so the singleton can read them as
an env-stripped child.

- **Path**: `$XDG_RUNTIME_DIR/slack-self-mcp/tokens.env`
- **Mode**: file `0600`, parent dir `0700`. On a logged-in Linux session
  `$XDG_RUNTIME_DIR` is itself a `0700` tmpfs that gets cleared at logout.
- **Format**: dotenv-style `KEY=value` lines.
- **Precedence**: `process.env` wins. If you set the env vars in the
  spawning shell, the file is never read.

`slack_listen_instructions()` surfaces `runtime_tokens_path` and
`runtime_tokens_file_present` so an agent debugging a "tokens missing"
error can see whether the file is where it expects.

> Threat model: this protects against unrelated processes on the same
> machine snooping `ps`/`environ`. It does **not** protect against another
> process running as the same user — but at that point the attacker can
> read `~/.claude.json` directly anyway.

## Done means

1. `slack_send("@filmstoat", "test", ["/tmp/foo.png"])` from a Claude Code
   session posts as the human user with the PNG attached.
2. The listener, run via `Monitor`, surfaces a structured JSON event when a
   test message is sent in Slack from another device.
3. Round-trip thread reply: the listener emits an event carrying
   `thread_ts` → the agent calls `slack_history(target=channel_id, thread_ts=parent_ts)`
   → gets the full thread context → calls
   `slack_send(target=channel_id, thread_ts=parent_ts, text=…)` and the reply
   lands in-thread.

## Footer marker

Every outgoing message gets a footer appended on a new line so recipients can
tell the post came through automation rather than a hand-typed message:

```
your message text
_— AI_
```

The default is `_— AI_` (markdown italic). Override or disable via env:

- `SLACK_SEND_FOOTER="_— Claude_"` — custom marker
- `SLACK_SEND_FOOTER=""` — disable entirely

The footer is only appended when the caller-supplied text is non-empty (so
file-only uploads with no caption stay caption-less). It is also re-applied
on `slack_edit` so editing doesn't strip the marker.

### Agent signature

Both `slack_send` and `slack_edit` accept an optional `agent_signature` string.
If set, it is inserted in parentheses inside the footer:

```
your message text
_— AI (Claude Code)_
```

This is opt-in — agents that want to identify themselves can; agents that
don't, won't. If `SLACK_SEND_FOOTER` is empty, the signature is also
suppressed (no footer at all).

> Note: this MCP posts as the human user (xoxp- token), so Slack itself will
> not show a "via app" badge. The footer is the substitute. If you'd rather
> have a username/icon override, that requires the `chat:write.customize`
> scope and a reinstall — and it still wouldn't apply to file uploads, which
> is why we went with a text footer instead.

## Notes / gotchas

- `files_upload_v2` requires channel **IDs**, not names — the resolver always
  produces an ID before calling it.
- The token holder must be a member of the channel they're posting into.
  For private channels, invite yourself first.
- Resolutions are cached for the process lifetime. Restart the MCP server
  after creating a new channel or DM you want to address by name.
- This MCP intentionally does not duplicate the existing
  `mcp__claude_ai_Slack__*` connector's reactions / search / history /
  thread-read tools. Use those for everything except sending with files
  and listening.

## Files

```
slack-self-mcp/
├── package.json
├── README.md
├── LICENSE
├── .env.example
├── src/
│   ├── server.mjs               # MCP stdio server (slack_send / edit / history / file_download / resolve / listen_instructions)
│   ├── resolver.mjs             # target → channel ID + fuzzy candidates
│   ├── runtime-tokens.mjs       # tokens.env handoff (server → singleton)
│   ├── recent-sends.mjs         # recent-sends.jsonl shared dedup for echo suppression
│   └── listener-singleton.mjs   # ensureRunning/heartbeat/path constants for the one-daemon-per-machine model
├── scripts/
│   ├── slack-listen.mjs         # Singleton listener daemon — owns Socket Mode, writes events.jsonl
│   └── slack-listen-stream.mjs  # Per-agent stream binary — tails+filters events.jsonl for one Monitor session
└── test/
    ├── recent-sends.test.mjs
    ├── listener-singleton.test.mjs
    └── slack-listen-stream.test.mjs    # run all: `npm test`
```
