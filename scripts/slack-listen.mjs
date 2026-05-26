#!/usr/bin/env node
// Singleton Slack Socket Mode listener. One daemon per machine + user
// token. Owns the Socket Mode connection; writes shaped+enriched events
// to events.jsonl for per-agent stream binaries (scripts/slack-listen-stream.mjs)
// to tail and filter.
//
// Lifecycle: this process is normally spawned detached by src/listener-singleton.mjs
// (called from src/server.mjs at MCP boot, or from the stream binary at
// Monitor boot). At startup it claims listener.pid + listener.heartbeat;
// from then on it touches the heartbeat every HEARTBEAT_TICK_MS so peers
// can tell it's alive. On SIGTERM/SIGINT it cleans up its files.
//
// Output channels:
//   events.jsonl  — append-only event stream (one JSON line per shaped event,
//                   plus synthetic {"event":"slack_connected"/"slack_disconnected"}
//                   lines so consumers can detect gaps).
//   listener.log  — stderr (diagnostics, boot, errors). Rotated by external
//                   tooling; we just append.
//
// Env:
//   SLACK_USER_TOKEN  — xoxp-… for user/channel name resolution + auth.test
//   SLACK_APP_TOKEN   — xapp-… for the socket connection
//
// Tokens are read from process.env, then from $XDG_RUNTIME_DIR/.../tokens.env
// as a fallback (Monitor strips env when spawning children).

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import fs from 'node:fs';

import { runtimeTokensPath, readTokens } from '../src/runtime-tokens.mjs';
import {
  DEFAULT_TTL_MS,
  readRecentSends,
  matchesRecentSend,
} from '../src/recent-sends.mjs';
import {
  HEARTBEAT_TICK_MS,
  eventsPath,
  eventsRotatedPath,
  writeHeartbeat,
  writePidFile,
  clearSingletonFiles,
} from '../src/listener-singleton.mjs';

const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024; // 5 MB

let USER_TOKEN = process.env.SLACK_USER_TOKEN;
let APP_TOKEN = process.env.SLACK_APP_TOKEN;
const INCLUDE_SUBTYPES_DEFAULT = process.env.SLACK_LISTEN_INCLUDE_SUBTYPES === '1';

if (!USER_TOKEN || !APP_TOKEN) {
  try {
    const fileTokens = readTokens();
    if (fileTokens) {
      if (!USER_TOKEN && fileTokens.SLACK_USER_TOKEN) USER_TOKEN = fileTokens.SLACK_USER_TOKEN;
      if (!APP_TOKEN && fileTokens.SLACK_APP_TOKEN) APP_TOKEN = fileTokens.SLACK_APP_TOKEN;
      if (USER_TOKEN || APP_TOKEN) {
        console.error(`slack-listen: loaded tokens from runtime file ${runtimeTokensPath()}`);
      }
    }
  } catch (err) {
    console.error(`slack-listen: could not read runtime tokens file ${runtimeTokensPath()}: ${err.message}`);
  }
}

function diagnoseMissingToken(name) {
  return [
    `slack-listen: ${name} is not set in env or in the runtime tokens file (${runtimeTokensPath()}).`,
    'The MCP server (src/server.mjs) writes that file at startup; if it is missing, the server is not running, was started without the corresponding env var, or could not write to the runtime dir.',
    'Workaround: start the listener directly with SLACK_USER_TOKEN and SLACK_APP_TOKEN exported in env.',
  ].join(' ');
}

if (!USER_TOKEN) {
  console.error(diagnoseMissingToken('SLACK_USER_TOKEN'));
  process.exit(1);
}
if (!APP_TOKEN) {
  console.error(diagnoseMissingToken('SLACK_APP_TOKEN'));
  process.exit(1);
}
if (!APP_TOKEN.startsWith('xapp-')) {
  console.error(`slack-listen: SLACK_APP_TOKEN does not start with "xapp-". Got prefix: ${APP_TOKEN.slice(0, 5)}…`);
  process.exit(1);
}

const web = new WebClient(USER_TOKEN);
const socket = new SocketModeClient({ appToken: APP_TOKEN });

const userCache = new Map();   // user_id → { name, real_name }
const channelCache = new Map(); // channel_id → { name, is_im, is_mpim, is_private }

let selfUserId = null;
let heartbeatTimer = null;

async function lookupUser(userId) {
  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const res = await web.users.info({ user: userId });
    const entry = {
      name: res.user?.name ?? null,
      real_name: res.user?.real_name ?? res.user?.profile?.real_name ?? null,
    };
    userCache.set(userId, entry);
    return entry;
  } catch (err) {
    console.error(`slack-listen: users.info(${userId}) failed: ${err.data?.error || err.message}`);
    userCache.set(userId, { name: null, real_name: null });
    return userCache.get(userId);
  }
}

async function lookupChannel(channelId) {
  if (!channelId) return null;
  if (channelCache.has(channelId)) return channelCache.get(channelId);
  try {
    const res = await web.conversations.info({ channel: channelId });
    const c = res.channel;
    const entry = {
      name: c?.name ?? null,
      is_im: !!c?.is_im,
      is_mpim: !!c?.is_mpim,
      is_private: !!c?.is_private,
    };
    channelCache.set(channelId, entry);
    return entry;
  } catch (err) {
    console.error(`slack-listen: conversations.info(${channelId}) failed: ${err.data?.error || err.message}`);
    channelCache.set(channelId, { name: null, is_im: false, is_mpim: false, is_private: false });
    return channelCache.get(channelId);
  }
}

// Maybe rotate events.jsonl when it crosses EVENTS_ROTATE_BYTES. Two-segment
// scheme: events.jsonl → events.1.jsonl (overwriting any existing .1), then
// open a fresh events.jsonl on the next append. Rename is atomic on POSIX,
// so any tailer with a live fd on the old inode drains cleanly.
function maybeRotateEvents() {
  try {
    const st = fs.statSync(eventsPath());
    if (st.size < EVENTS_ROTATE_BYTES) return;
    fs.renameSync(eventsPath(), eventsRotatedPath());
    console.error(`slack-listen: rotated events.jsonl → events.1.jsonl at ${st.size} bytes`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`slack-listen: rotate check failed: ${err.message}`);
    }
  }
}

function emitEvent(obj) {
  try {
    maybeRotateEvents();
    fs.appendFileSync(eventsPath(), JSON.stringify(obj) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`slack-listen: emit failed: ${err.message}`);
  }
}

function emitSynthetic(eventName, extra = {}) {
  emitEvent({ event: eventName, at: Date.now(), ...extra });
}

// Returns true when this event is an echo of one of OUR own outbound posts
// (chat.postMessage / files.uploadV2 / chat.update from any MCP server on
// this machine). Reads the shared recent-sends.jsonl and matches on
// (channel, ts). Best-effort — empty/missing file → returns false.
function isOwnSendEcho(event) {
  if (!event.channel || !event.ts) return false;
  const recent = readRecentSends({ ttlMs: DEFAULT_TTL_MS });
  return matchesRecentSend(recent, { channel: event.channel, ts: event.ts });
}

async function shape(event) {
  const [user, channel] = await Promise.all([lookupUser(event.user), lookupChannel(event.channel)]);
  let channel_label;
  if (channel?.is_im) channel_label = '(dm)';
  else if (channel?.is_mpim) channel_label = '(mpim)';
  else if (channel?.name) channel_label = `#${channel.name}`;
  else channel_label = event.channel;

  const files = Array.isArray(event.files)
    ? event.files.map((f) => ({
        id: f.id ?? null,
        name: f.name ?? null,
        mimetype: f.mimetype ?? null,
        url: f.url_private ?? f.permalink ?? null,
      }))
    : [];

  return {
    ts: event.ts ?? null,
    channel: event.channel ?? null,
    channel_name: channel_label,
    user: event.user ?? null,
    user_name: user?.name ?? null,
    user_real_name: user?.real_name ?? null,
    is_self: !!event.user && event.user === selfUserId,
    text: event.text ?? '',
    thread_ts: event.thread_ts ?? null,
    subtype: event.subtype ?? null,
    bot_id: event.bot_id ?? null,
    files,
  };
}

// Per-event drop decisions — only the structural ones. Per-agent filters
// (watch-self / channel / thread / include-subtypes) happen downstream
// in the stream binary; the singleton emits everything that's not a
// definite self-echo of our own send.
function shouldDrop(event) {
  if (!event) return true;
  if (event.type !== 'message') return true;
  // Drop our own slack_send echoes. This is the ONLY hard drop; all other
  // events flow to events.jsonl so per-agent stream binaries can decide.
  if (event.user && event.user === selfUserId && isOwnSendEcho(event)) return true;
  return false;
}

// @slack/socket-mode v2.x: the 'slack_event' handler receives the envelope
// type at the top level (`type`), while `body` is the payload (`event_callback`
// for events_api envelopes — so `body.type === "event_callback"`, never
// `"events_api"`). Gate on `type`, then unwrap `body.event`.
socket.on('slack_event', async ({ ack, type, body }) => {
  try {
    await ack();
  } catch (err) {
    console.error(`slack-listen: ack failed: ${err.message}`);
  }
  if (type !== 'events_api') return;
  const event = body?.event;
  if (!event) return;
  if (shouldDrop(event)) return;
  try {
    const out = await shape(event);
    emitEvent(out);
  } catch (err) {
    console.error(`slack-listen: shape failed: ${err.message}`);
  }
});

socket.on('connected', () => {
  console.error('slack-listen: connected');
  emitSynthetic('slack_connected');
});
socket.on('disconnected', (err) => {
  console.error(`slack-listen: disconnected${err ? `: ${err.message ?? err}` : ''}`);
  emitSynthetic('slack_disconnected', { error: err ? (err.message ?? String(err)) : null });
});
socket.on('unable_to_socket_mode_start', (err) => {
  console.error(`slack-listen: unable_to_socket_mode_start: ${err?.message ?? err}`);
});
socket.on('error', (err) => {
  console.error(`slack-listen: error: ${err?.message ?? err}`);
});

function startHeartbeat() {
  writeHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { writeHeartbeat(); } catch (err) {
      console.error(`slack-listen: heartbeat failed: ${err.message}`);
    }
  }, HEARTBEAT_TICK_MS);
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function main() {
  writePidFile();
  startHeartbeat();
  const auth = await web.auth.test();
  selfUserId = auth.user_id;
  console.error(`slack-listen: auth.test ok, user=${auth.user} (${selfUserId}), team=${auth.team}`);
  console.error(`slack-listen: include_subtypes default=${INCLUDE_SUBTYPES_DEFAULT} (per-agent filter, set on the stream binary)`);
  await socket.start();
}

function shutdown(signal) {
  console.error(`slack-listen: ${signal} received, shutting down`);
  stopHeartbeat();
  socket
    .disconnect()
    .catch((err) => console.error(`slack-listen: disconnect error: ${err.message}`))
    .finally(() => {
      clearSingletonFiles();
      process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

main().catch((err) => {
  console.error(`slack-listen: fatal: ${err?.data?.error || err?.message || err}`);
  stopHeartbeat();
  clearSingletonFiles();
  process.exit(1);
});
