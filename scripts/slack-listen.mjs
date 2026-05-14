#!/usr/bin/env node
// Slack Socket Mode listener. Emits one JSON line per filtered message
// event to stdout — designed for Claude Code's Monitor tool.
//
// Filters:
//   - drops messages from the token-holder user (avoids feedback loops)
//   - drops messages with a subtype (edits, joins, etc.) and bot_messages
//     unless SLACK_LISTEN_INCLUDE_SUBTYPES=1
//
// Env:
//   SLACK_USER_TOKEN  — xoxp-… for user/channel name resolution + auth.test
//   SLACK_APP_TOKEN   — xapp-… for the socket connection
//
// Diagnostics go to stderr. Stdout is the structured event stream only.

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

import { runtimeTokensPath, readTokens } from '../src/runtime-tokens.mjs';

// Token resolution order: process env first (explicit > implicit), then the
// runtime tokens file the MCP server writes at startup. Monitor strips env
// when it spawns children, so the runtime file is the normal path when the
// listener is launched via the slack_listen_instructions Monitor command.
let USER_TOKEN = process.env.SLACK_USER_TOKEN;
let APP_TOKEN = process.env.SLACK_APP_TOKEN;
const INCLUDE_SUBTYPES = process.env.SLACK_LISTEN_INCLUDE_SUBTYPES === '1';

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
const channelCache = new Map(); // channel_id → { name, is_im, is_mpim }

let selfUserId = null;

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

function emit(line) {
  // Single newline-terminated JSON line; flushed by stdout's default line buffering.
  process.stdout.write(line + '\n');
}

function shouldDrop(event) {
  if (!event) return true;
  if (event.type !== 'message') return true;
  if (event.user && event.user === selfUserId) return true;
  if (event.bot_id) return true;
  if (event.subtype && !INCLUDE_SUBTYPES) return true;
  return false;
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
    text: event.text ?? '',
    thread_ts: event.thread_ts ?? null,
    subtype: event.subtype ?? null,
    files,
  };
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
    emit(JSON.stringify(out));
  } catch (err) {
    console.error(`slack-listen: shape failed: ${err.message}`);
  }
});

socket.on('connected', () => {
  console.error('slack-listen: connected');
});
socket.on('disconnected', (err) => {
  console.error(`slack-listen: disconnected${err ? `: ${err.message ?? err}` : ''}`);
});
socket.on('unable_to_socket_mode_start', (err) => {
  console.error(`slack-listen: unable_to_socket_mode_start: ${err?.message ?? err}`);
});
socket.on('error', (err) => {
  console.error(`slack-listen: error: ${err?.message ?? err}`);
});

async function main() {
  const auth = await web.auth.test();
  selfUserId = auth.user_id;
  console.error(`slack-listen: auth.test ok, user=${auth.user} (${selfUserId}), team=${auth.team}`);
  await socket.start();
}

function shutdown(signal) {
  console.error(`slack-listen: ${signal} received, shutting down`);
  socket
    .disconnect()
    .catch((err) => console.error(`slack-listen: disconnect error: ${err.message}`))
    .finally(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error(`slack-listen: fatal: ${err?.data?.error || err?.message || err}`);
  process.exit(1);
});
