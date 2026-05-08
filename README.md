# slack-self-mcp

Local MCP server that sends Slack messages **as the human user** (xoxp- token,
not a bot) with file attachments, plus a Socket Mode listener script that
emits one JSON line per inbound message — designed to be plugged into Claude
Code's `Monitor` tool.

Why this exists: the default `mcp__claude_ai_Slack__*` connector cannot upload
files, and the Drive MCP `create_file` is broken for binary uploads above
~10K base64 chars. For sharing screenshots and other artifacts between agents
and a human, the right channel is Slack — but as the human, in a real channel
or DM, with the file attached.

## Tools

### `slack_send`

```ts
slack_send(target: string, text?: string, file_paths?: string[], thread_ts?: string)
  → { channel_id, ts, file_ids?, resolved_target }
  → on miss/ambiguity: { error: "no_match" | "ambiguous", input, candidates: [...], hint, more_available? }
```

`target` accepts:

- `#channel-name`
- channel ID (`C…` / `G…`)
- `@handle`
- user ID (`U…` / `W…`)
- email address
- bare string (searches both channels and users)

On a unique match, posts text via `chat.postMessage`. If `file_paths` is
non-empty, each file is then uploaded via `files_upload_v2` and threaded
under the parent message.

On a typo or partial name, returns up to 10 candidates with `target_id`s — the
agent re-calls `slack_send` with one of those `target_id`s. No separate
resolver round trip required.

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
slack_history(target: string, limit?: number, thread_ts?: string, before_ts?: string)
  → { channel_id, resolved_target, messages: Message[], has_more: boolean }
  → on miss/ambiguity: { error, candidates, hint, more_available? }   // same shape as slack_send
```

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
slack_listen_instructions()
  → {
    monitor: { command, description, persistent, timeout_ms },
    listener_path: string,
    listener_exists: boolean,
    env_required: string[],
    notes: string[]
  }
```

Returns the `Monitor()` parameters needed to start the Socket Mode listener,
with the listener path resolved from the server's own install location.
The agent passes the returned `monitor` object straight into Claude Code's
`Monitor` tool — no install-path hardcoding required.

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

## Listener (Socket Mode)

The listener is a standalone script. It connects via Socket Mode, filters out
messages from the token holder (avoids feedback loops), filters bot messages
and edits by default, and writes one structured JSON line per surviving event
to stdout. Diagnostics go to stderr.

Run from a Claude Code session via `Monitor`. The cleanest path is to ask the
MCP for the exact invocation — it computes the listener path from its own
install location, so the agent never has to know where the repo lives:

```
slack_listen_instructions()
  → {
    monitor: {
      command: "node <resolved-path>/scripts/slack-listen.mjs",
      description: "Slack",
      persistent: true,
      timeout_ms: 3600000
    },
    listener_path: "<resolved-path>/scripts/slack-listen.mjs",
    listener_exists: true,
    env_required: ["SLACK_USER_TOKEN", "SLACK_APP_TOKEN"],
    notes: [...]
  }
```

Pass the returned `monitor` object straight into Claude Code's `Monitor` tool.

`Monitor` turns each stdout line into a notification.

### Token handoff (Monitor strips env)

Monitor spawns its child with a stripped environment, so a Monitor-launched
listener does **not** inherit `SLACK_USER_TOKEN` / `SLACK_APP_TOKEN` from the
session that called Monitor. Pushing tokens onto the listener's command line
would put them in `ps` / `/proc/<pid>/cmdline`, visible to other processes —
which we don't want.

Instead, the MCP server writes its tokens to a per-user runtime file at
startup, and the listener reads them as a fallback when its own env is empty:

- **Path**: `$XDG_RUNTIME_DIR/slack-self-mcp/tokens.env`, or
  `/tmp/slack-self-mcp-<uid>/tokens.env` if `XDG_RUNTIME_DIR` is unset.
- **Mode**: file `0600`, parent dir `0700`. On a logged-in Linux session
  `$XDG_RUNTIME_DIR` is itself a `0700` tmpfs that gets cleared at logout.
- **Format**: dotenv-style `KEY=value` lines, only `SLACK_USER_TOKEN` and
  `SLACK_APP_TOKEN`.
- **Lifecycle**: written when the MCP server boots, removed on `SIGTERM` /
  `SIGINT` / `SIGHUP` / process exit (best-effort; the runtime tmpfs sweep
  takes care of leftover files at logout).
- **Precedence**: `process.env` wins. If you start the listener directly with
  the env vars exported, it never reads the runtime file. The fallback only
  kicks in when env is missing.

`slack_listen_instructions()` surfaces the resolved path as
`runtime_tokens_path` and a presence flag as `runtime_tokens_file_present`,
so an agent debugging a "tokens missing" error can see whether the file is
where it expects.

> Threat model: this protects against unrelated processes on the same machine
> snooping `ps`/`environ`. It does **not** protect against another process
> running as the same user — but at that point the attacker can read
> `~/.claude.json` directly anyway.

Event line shape:

```json
{
  "ts": "1715000000.123456",
  "channel": "C0123456789",
  "channel_name": "#general",
  "user": "U0123456789",
  "user_name": "alice",
  "user_real_name": "Alice Example",
  "text": "hi there",
  "thread_ts": null,
  "subtype": null,
  "files": [{ "id": "F…", "name": "foo.png", "mimetype": "image/png", "url": "https://files.slack.com/…" }]
}
```

Run directly to test:

```bash
SLACK_USER_TOKEN=xoxp-… SLACK_APP_TOKEN=xapp-… \
  node scripts/slack-listen.mjs
```

Send yourself a test message from your phone; you should see a JSON line.

To include subtyped events (edits, joins, file shares as separate
`message_changed` events, etc.), set `SLACK_LISTEN_INCLUDE_SUBTYPES=1`.

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
├── .env.example
├── src/
│   ├── server.mjs            # MCP stdio server
│   ├── resolver.mjs          # target → channel ID + fuzzy candidates
│   └── runtime-tokens.mjs    # tokens.env handoff (server → listener)
└── scripts/
    └── slack-listen.mjs      # Socket Mode listener for Monitor
```
