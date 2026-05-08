#!/usr/bin/env node
// MCP server exposing slack_send, slack_edit, slack_resolve over stdio.
// Uses the user OAuth token (xoxp-…) so messages are attributed to the human.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';

import { resolveTarget, searchTargets, lookupUserName } from './resolver.mjs';
import { runtimeTokensPath, writeTokens, removeTokens } from './runtime-tokens.mjs';

// Resolve the listener path relative to this server file. server.mjs lives
// at <install>/src/server.mjs; the listener at <install>/scripts/slack-listen.mjs.
const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(__filename), '..');
const LISTENER_PATH = path.join(PACKAGE_ROOT, 'scripts', 'slack-listen.mjs');

const USER_TOKEN = process.env.SLACK_USER_TOKEN;
if (!USER_TOKEN) {
  console.error(
    'slack-self-mcp: SLACK_USER_TOKEN is not set. Set it in your MCP server env (xoxp-… user OAuth token). See README.',
  );
  process.exit(1);
}
if (!USER_TOKEN.startsWith('xoxp-')) {
  console.error(
    `slack-self-mcp: SLACK_USER_TOKEN does not start with "xoxp-". This MCP requires a user OAuth token so messages are sent as the human user. Got prefix: ${USER_TOKEN.slice(0, 5)}…`,
  );
  process.exit(1);
}

const slack = new WebClient(USER_TOKEN);

// Hand off tokens to the listener via $XDG_RUNTIME_DIR/slack-self-mcp/tokens.env
// (mode 0600, in user-private tmpfs). Monitor strips env from spawned children;
// rather than push tokens into the listener's command line — visible in
// `ps`/`/proc/*/cmdline` to other processes — the server publishes them to a
// per-user runtime file the listener reads as a fallback when its own env is
// missing. Best-effort cleanup on shutdown; XDG_RUNTIME_DIR is auto-cleared at
// logout regardless.
let RUNTIME_TOKENS_PATH = null;
try {
  RUNTIME_TOKENS_PATH = writeTokens({
    SLACK_USER_TOKEN: USER_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? '',
  });
  console.error(`slack-self-mcp: wrote runtime tokens to ${RUNTIME_TOKENS_PATH}`);
} catch (err) {
  // Don't fail startup — the MCP server itself doesn't need this file. Only
  // the listener does. If the write failed (read-only FS, etc.), the listener
  // will hard-error with a clear path on its own.
  console.error(`slack-self-mcp: could not write runtime tokens: ${err.message}`);
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { removeTokens(); process.exit(0); });
}
process.on('exit', () => { removeTokens(); });

// Footer appended to text messages so recipients can tell the post came
// through automation. Default `_— AI_` (italic). Set the env var to an empty
// string to disable. Only applied when the caller-supplied text is non-empty.
const FOOTER = process.env.SLACK_SEND_FOOTER ?? '_— AI_';

function buildFooter(signature) {
  if (!FOOTER) return '';
  const sig = typeof signature === 'string' ? signature.trim() : '';
  if (!sig) return FOOTER;
  // Insert "(sig)" before the trailing italic underscore if the footer is
  // wrapped in markdown italics; otherwise just append.
  if (FOOTER.endsWith('_') && FOOTER.length > 1) {
    return `${FOOTER.slice(0, -1)} (${sig})_`;
  }
  return `${FOOTER} (${sig})`;
}

function withFooter(text, signature) {
  if (!text) return text;
  const f = buildFooter(signature);
  if (!f) return text;
  return `${text}\n${f}`;
}

const TOOLS = [
  {
    name: 'slack_send',
    description:
      'Send a Slack message as the human user, optionally with file attachments. ' +
      'target accepts #channel-name, channel ID (C…/G…), @handle, user ID (U…), or email. ' +
      'On a unique match, posts text via chat.postMessage; if file_paths is non-empty, ' +
      'each file is then uploaded via files_upload_v2 and threaded under the message. ' +
      'On ambiguous/unknown target, returns { error, candidates: [...] } — re-call with target_id from a candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '#channel, channel ID, @handle, user ID, or email',
        },
        text: {
          type: 'string',
          description: 'Message text. Optional if file_paths is non-empty (uploads will have no parent text).',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to files to attach. Threaded under the parent message.',
        },
        thread_ts: {
          type: 'string',
          description: 'Optional parent message ts to reply within a thread.',
        },
        agent_signature: {
          type: 'string',
          description:
            'Optional self-identifier the calling agent can include if it wants to. ' +
            'Appears in parentheses inside the footer marker, e.g. setting it to ' +
            '"Claude Code" produces "_— AI (Claude Code)_". Only applied when the ' +
            'footer itself is enabled and the message has text.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'slack_edit',
    description:
      'Edit a previously sent message via chat.update. With a user token this only works on messages the same user sent. ' +
      'For threaded replies, ts is the reply\'s own ts (not the parent thread_ts). text fully replaces the previous text.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel ID returned by slack_send.' },
        ts: { type: 'string', description: 'Message ts returned by slack_send.' },
        text: { type: 'string', description: 'Replacement text.' },
        agent_signature: {
          type: 'string',
          description:
            'Optional self-identifier the calling agent can include if it wants to. ' +
            'Appears in parentheses inside the footer marker, e.g. "_— AI (Claude Code)_".',
        },
      },
      required: ['channel_id', 'ts', 'text'],
    },
  },
  {
    name: 'slack_history',
    description:
      'Read recent messages in a channel/DM, or the full reply set of a thread. ' +
      'Without thread_ts: conversations.history. With thread_ts: conversations.replies (parent first). ' +
      'before_ts paginates backward (passed as the API "latest" cursor). ' +
      'limit defaults to 20, capped at 100. Subtype-bearing messages (joins, edits, file shares) are returned — caller decides what is relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '#channel, channel ID, @handle, user ID, or email.' },
        limit: { type: 'number', description: 'Max messages. Default 20, capped at 100.' },
        thread_ts: { type: 'string', description: 'If set, fetch the full reply set via conversations.replies.' },
        before_ts: { type: 'string', description: 'Paginate backward — passed to the API as "latest".' },
      },
      required: ['target'],
    },
  },
  {
    name: 'slack_listen_instructions',
    description:
      'Returns the exact Monitor() invocation needed to start the Socket Mode listener. ' +
      'The listener path is resolved from this server\'s own install location, so the ' +
      'caller does not need to know where the package lives. Pass the returned `monitor` ' +
      'object directly to Claude Code\'s Monitor tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slack_file_download',
    description:
      'Download a Slack file (an attachment surfaced via slack_history or the listener) to local disk. ' +
      'Pass file_id (F…, preferred — looks up url_private + filename via files.info) or url (a https://files.slack.com/… url_private, used directly). ' +
      'The GET is authenticated with the user OAuth token. ' +
      'dest_path is recommended: pass an absolute file path, or an absolute directory (uses the original filename). ' +
      'If dest_path is omitted, the file lands in /tmp/<filename> — fine for an immediate Read but not durable; prefer specifying a real directory. ' +
      'Requires files:read on the user token; missing_scope errors here mean the app needs reinstall.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'Slack file ID (F…). Preferred — files.info resolves url_private, name, mimetype, size.',
        },
        url: {
          type: 'string',
          description: 'Direct https://files.slack.com/… url_private. Used as-is; skip files.info. One of file_id / url is required.',
        },
        dest_path: {
          type: 'string',
          description:
            'Absolute path to write to. If it ends with "/" or names an existing directory, the original filename is appended. ' +
            'Omit to default to /tmp/<filename> (ephemeral; specify a real directory for anything you want to keep).',
        },
        overwrite: {
          type: 'boolean',
          description: 'If false (default), error when dest_path already exists. Set true to overwrite.',
        },
      },
    },
  },
  {
    name: 'slack_resolve',
    description:
      'Look up channels/users matching a target string. Same engine as the slack_send fallback. ' +
      'Useful for introspection before sending. Returns { matches: [{ target_id, type, display, name?, real_name?, email? }, …] }.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '#channel, channel ID, @handle, user ID, email, or bare string.' },
      },
      required: ['target'],
    },
  },
];

const server = new Server(
  { name: 'slack-self-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'slack_send') return await handleSend(args);
    if (name === 'slack_edit') return await handleEdit(args);
    if (name === 'slack_history') return await handleHistory(args);
    if (name === 'slack_listen_instructions') return handleListenInstructions();
    if (name === 'slack_file_download') return await handleFileDownload(args);
    if (name === 'slack_resolve') return await handleResolve(args);
    return errorResult(`unknown tool: ${name}`);
  } catch (err) {
    return errorResult(formatSlackError(err));
  }
});

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message, extra) {
  const body = { error: message, ...(extra ?? {}) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

function formatSlackError(err) {
  const apiError = err?.data?.error;
  const method = err?.data?.response_metadata?.scopes ? undefined : err?.data?.callstack ? undefined : undefined;
  const parts = [];
  if (err?.code) parts.push(`code=${err.code}`);
  if (apiError) parts.push(`slack_error=${apiError}`);
  if (err?.message) parts.push(err.message);
  return parts.length ? parts.join(' | ') : String(err);
}

async function handleSend(args) {
  const { target, text, file_paths, thread_ts, agent_signature } = args;
  if (typeof target !== 'string' || target.length === 0) {
    return errorResult('target is required');
  }
  const files = Array.isArray(file_paths) ? file_paths : [];

  for (const p of files) {
    if (typeof p !== 'string' || p.length === 0) return errorResult(`file_paths entry is not a string: ${JSON.stringify(p)}`);
    if (!fs.existsSync(p)) return errorResult(`file not found: ${p}`);
    const stat = fs.statSync(p);
    if (!stat.isFile()) return errorResult(`not a regular file: ${p}`);
  }

  if ((!text || text.length === 0) && files.length === 0) {
    return errorResult('either text or file_paths must be provided');
  }

  const resolution = await resolveTarget(slack, target);
  if (resolution.error) {
    return ok(resolution);
  }
  const channel_id = resolution.channel_id;

  // Strategy:
  //   files.length > 0  → files.uploadV2 with initial_comment=text. All files
  //                        attach to ONE message (the upload's share message).
  //                        thread_ts respected if set.
  //   files.length == 0 → chat.postMessage.
  //
  // ts: chat.postMessage returns it directly. files.uploadV2 does not, so we
  // recover it via files.info on the first uploaded file (shares lookup).
  let ts = null;
  let file_ids;

  if (files.length > 0) {
    const uploadParams = {
      channel_id,
      file_uploads: files.map((p) => ({
        file: fs.createReadStream(p),
        filename: path.basename(p),
      })),
    };
    if (text && text.length > 0) uploadParams.initial_comment = withFooter(text, agent_signature);
    if (thread_ts) uploadParams.thread_ts = thread_ts;

    const uploadRes = await slack.files.uploadV2(uploadParams);
    file_ids = extractFileIds(uploadRes);
    ts = await resolveShareTs(file_ids[0], channel_id);
  } else {
    const params = { channel: channel_id, text: withFooter(text, agent_signature) };
    if (thread_ts) params.thread_ts = thread_ts;
    const msg = await slack.chat.postMessage(params);
    ts = msg.ts ?? null;
  }

  return ok({
    channel_id,
    ts,
    file_ids,
    resolved_target: { type: resolution.type, display: resolution.display },
  });
}

async function resolveShareTs(fileId, channelId) {
  if (!fileId) return null;
  // files.info shares can lag right after completeUploadExternal returns
  // (race), and the shape differs across channel kinds. Scanning the channel's
  // recent history for the file id is more reliable — the file is always part
  // of the share message we just posted.
  try {
    const res = await slack.conversations.history({ channel: channelId, limit: 10 });
    for (const m of res.messages ?? []) {
      const files = m.files ?? [];
      if (files.some((f) => f?.id === fileId)) return m.ts ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

function extractFileIds(uploadRes) {
  const ids = [];
  // files_upload_v2 returns { ok, files: [...] } or { ok, file: {...} } depending on shape.
  if (Array.isArray(uploadRes?.files)) {
    for (const entry of uploadRes.files) {
      if (entry?.id) ids.push(entry.id);
      if (Array.isArray(entry?.files)) {
        for (const f of entry.files) if (f?.id) ids.push(f.id);
      }
    }
  } else if (uploadRes?.file?.id) {
    ids.push(uploadRes.file.id);
  }
  return ids;
}

async function handleEdit(args) {
  const { channel_id, ts, text, agent_signature } = args;
  if (!channel_id || !ts || typeof text !== 'string') {
    return errorResult('channel_id, ts, and text are all required');
  }
  const res = await slack.chat.update({ channel: channel_id, ts, text: withFooter(text, agent_signature) });
  return ok({ channel_id: res.channel, ts: res.ts });
}

async function handleHistory(args) {
  const { target, limit, thread_ts, before_ts } = args;
  if (typeof target !== 'string' || target.length === 0) {
    return errorResult('target is required');
  }
  const cap = 100;
  const fallback = 20;
  let n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  if (n < 1) n = 1;
  if (n > cap) n = cap;

  const resolution = await resolveTarget(slack, target);
  if (resolution.error) return ok(resolution);
  const channel_id = resolution.channel_id;

  let raw;
  let has_more = false;
  if (thread_ts) {
    const params = { channel: channel_id, ts: thread_ts, limit: n };
    if (before_ts) params.latest = before_ts;
    const res = await slack.conversations.replies(params);
    raw = res.messages ?? [];
    has_more = !!res.has_more;
  } else {
    const params = { channel: channel_id, limit: n };
    if (before_ts) params.latest = before_ts;
    const res = await slack.conversations.history(params);
    raw = res.messages ?? [];
    has_more = !!res.has_more;
  }

  const messages = await Promise.all(raw.map((m) => shapeMessage(m)));
  return ok({
    channel_id,
    resolved_target: { type: resolution.type, display: resolution.display },
    messages,
    has_more,
  });
}

async function shapeMessage(m) {
  const user = m.user ? await lookupUserName(slack, m.user) : null;
  const out = {
    ts: m.ts ?? null,
    user: m.user ?? null,
    user_name: user?.name ?? user?.real_name ?? null,
    text: m.text ?? '',
  };
  if (m.thread_ts) out.thread_ts = m.thread_ts;
  if (m.subtype) out.subtype = m.subtype;
  if (m.bot_id) out.bot_id = m.bot_id;
  if (m.edited) out.edited = { user: m.edited.user ?? null, ts: m.edited.ts ?? null };
  if (Array.isArray(m.files) && m.files.length > 0) {
    out.files = m.files.map((f) => ({
      id: f.id ?? null,
      name: f.name ?? null,
      mimetype: f.mimetype ?? null,
      url_private: f.url_private ?? null,
      permalink: f.permalink ?? null,
    }));
  }
  if (Array.isArray(m.reactions) && m.reactions.length > 0) {
    out.reactions = m.reactions.map((r) => ({
      name: r.name ?? null,
      count: r.count ?? 0,
      users: Array.isArray(r.users) ? r.users : [],
    }));
  }
  return out;
}

function handleListenInstructions() {
  const listenerExists = fs.existsSync(LISTENER_PATH);
  const tokensPath = runtimeTokensPath();
  const tokensFileWritten = !!RUNTIME_TOKENS_PATH && fs.existsSync(tokensPath);
  return ok({
    monitor: {
      command: `node ${LISTENER_PATH}`,
      description: 'Slack',
      persistent: true,
      timeout_ms: 3600000,
    },
    listener_path: LISTENER_PATH,
    listener_exists: listenerExists,
    runtime_tokens_path: tokensPath,
    runtime_tokens_file_present: tokensFileWritten,
    notes: [
      'The MCP server publishes its tokens to runtime_tokens_path (mode 0600 in $XDG_RUNTIME_DIR or per-user /tmp dir). The listener reads them on startup when its own env is missing — Monitor strips env from spawned children, so this is the normal path.',
      'Tokens are NOT placed on the listener\'s command line, so they do not appear in `ps` / /proc/*/cmdline.',
      'If you want to bypass the runtime file, run the listener directly with SLACK_USER_TOKEN and SLACK_APP_TOKEN exported in env — those take precedence.',
      'Each stdout line is one structured JSON message event. Stderr is diagnostics only.',
      'Set SLACK_LISTEN_INCLUDE_SUBTYPES=1 to also receive edits, joins, and other subtype-bearing events.',
    ],
  });
}

async function handleFileDownload(args) {
  const { file_id, url, dest_path, overwrite } = args;
  if ((!file_id || typeof file_id !== 'string') && (!url || typeof url !== 'string')) {
    return errorResult('one of file_id or url is required');
  }

  let resolvedUrl = typeof url === 'string' ? url : null;
  let name = null;
  let mimetype = null;
  let infoSize = null;

  if (file_id) {
    const info = await slack.files.info({ file: file_id });
    const f = info.file;
    if (!f) return errorResult(`files.info returned no file for id=${file_id}`);
    if (!resolvedUrl) resolvedUrl = f.url_private ?? null;
    name = f.name ?? null;
    mimetype = f.mimetype ?? null;
    if (typeof f.size === 'number') infoSize = f.size;
  }

  if (!resolvedUrl) {
    return errorResult(`could not resolve a download URL${file_id ? ` for file_id=${file_id}` : ''}`);
  }

  // Pick destination path.
  // - dest_path absent → /tmp/<filename>
  // - dest_path is an existing directory or ends with "/" → join with filename
  // - otherwise treat dest_path as the full file path
  const fallbackName = name || (file_id ? `${file_id}.bin` : path.basename(new URL(resolvedUrl).pathname) || 'slack-file.bin');
  let target;
  if (typeof dest_path !== 'string' || dest_path.length === 0) {
    target = path.join(os.tmpdir(), fallbackName);
  } else {
    let isDirHint = dest_path.endsWith('/') || dest_path.endsWith(path.sep);
    if (!isDirHint) {
      try {
        const st = fs.statSync(dest_path);
        if (st.isDirectory()) isDirHint = true;
      } catch (_) {
        // not present — treat as full file path
      }
    }
    target = isDirHint ? path.join(dest_path, fallbackName) : dest_path;
  }
  if (!path.isAbsolute(target)) {
    return errorResult(`dest_path must be absolute (got ${target})`);
  }

  if (!overwrite && fs.existsSync(target)) {
    return errorResult(`dest_path already exists: ${target} (pass overwrite:true to replace)`);
  }

  // Ensure parent directory exists.
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });

  // Authenticated GET. url_private requires Bearer USER_TOKEN; without it Slack
  // serves a login HTML page (200) instead of the file bytes.
  const res = await fetch(resolvedUrl, {
    headers: { Authorization: `Bearer ${USER_TOKEN}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    return errorResult(`download failed: HTTP ${res.status} ${res.statusText} for ${resolvedUrl}`);
  }
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/html')) {
    return errorResult(
      `download returned HTML (likely auth/scope issue — ensure files:read is on the user token and reinstall the app). content-type=${ctype}`,
    );
  }
  if (!res.body) {
    return errorResult('download returned no body');
  }

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));

  const stat = fs.statSync(target);
  return ok({
    file_id: file_id ?? null,
    name,
    mimetype,
    size: stat.size,
    expected_size: infoSize,
    dest_path: target,
  });
}

async function handleResolve(args) {
  const { target } = args;
  if (typeof target !== 'string' || target.length === 0) {
    return errorResult('target is required');
  }
  const result = await searchTargets(slack, target);
  return ok(result);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr ok; stdout is reserved for MCP framing.
console.error('slack-self-mcp: ready (user-token mode)');
