// Dedup state for the singleton listener's self-echo suppression. Every
// MCP server on this machine appends each successful outbound post here;
// the singleton listener reads + filters by TTL and drops events whose
// (channel, ts) matches a record — so events.jsonl never contains echoes
// of our own chat.postMessage / files.uploadV2 / chat.update calls.
//
// SHARED across all MCP server processes for this user. Per-pid scoping
// was an artifact of the per-tab-listener era (V1); under the singleton
// model, all tabs share the user token, so all sends are "ours" and
// should be deduped equally.
//
// Layout:  $XDG_RUNTIME_DIR/slack-self-mcp/recent-sends.jsonl
// Fallback dir: /tmp/slack-self-mcp-<uid>/                  (mkdir -m 0700)
// File mode: 0600
// Format:   one JSON object per line: {"ts":"…","channel":"…","sent_at":<ms>}
//
// Concurrency: writes are POSIX appendFileSync (O_APPEND) — atomic for
// line-sized writes under PIPE_BUF (4096 B), so concurrent MCP-server
// appends are safe. Pruning rewrites the file via tmp+rename and is
// best-effort — a concurrent append racing a prune may be lost (worst
// case: one self-event leaks through, which is the safer failure mode).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BYTES = 64 * 1024; // prune trigger; well above steady-state size

function runtimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, 'slack-self-mcp');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return path.join(os.tmpdir(), `slack-self-mcp-${uid}`);
}

export function recentSendsPath() {
  return path.join(runtimeDir(), 'recent-sends.jsonl');
}

function ensureDir() {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }
  return dir;
}

// Append one record. Returns the path on success, null on failure. Never
// throws — dedup state is best-effort by design; caller should log on null.
export function recordSend({ ts, channel, sent_at }) {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  if (typeof channel !== 'string' || channel.length === 0) return null;
  const entry = {
    ts,
    channel,
    sent_at: typeof sent_at === 'number' ? sent_at : Date.now(),
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    ensureDir();
    const target = recentSendsPath();
    fs.appendFileSync(target, line, { mode: 0o600 });
    // Re-assert mode in case the file was created with a different umask
    // or pre-existed with looser perms.
    try { fs.chmodSync(target, 0o600); } catch (_) { /* best effort */ }
    maybePrune(target);
    return target;
  } catch (_) {
    return null;
  }
}

// Read all entries within `ttlMs` of `now`. Returns [] on missing /
// unreadable / empty file. Never throws.
export function readRecentSends({ ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const target = recentSendsPath();
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    return [];
  }
  const cutoff = now - ttlMs;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || typeof entry.ts !== 'string' || typeof entry.channel !== 'string') continue;
    if (typeof entry.sent_at !== 'number' || entry.sent_at < cutoff) continue;
    out.push(entry);
  }
  return out;
}

// True when (channel, ts) matches any entry in `entries`. O(n) — n is small
// (handful of recent sends per process).
export function matchesRecentSend(entries, { channel, ts }) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  for (const e of entries) {
    if (e.channel === channel && e.ts === ts) return true;
  }
  return false;
}

// Rewrite the file keeping only entries within `ttlMs`. Best-effort, racy
// against concurrent appends — see file header. Returns true on success,
// false on failure or skip. Exported for tests + manual use.
export function pruneRecentSends({ ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const target = recentSendsPath();
  if (!fs.existsSync(target)) return false;
  const fresh = readRecentSends({ ttlMs, now });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (fresh.length === 0) {
      // Empty result → drop the file entirely (next record() recreates it).
      try { fs.unlinkSync(target); } catch (_) { /* best effort */ }
      return true;
    }
    const body = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch (_) { /* best effort */ }
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    return false;
  }
}

function maybePrune(target) {
  try {
    const st = fs.statSync(target);
    if (st.size > MAX_BYTES) pruneRecentSends();
  } catch (_) { /* best effort */ }
}
