#!/usr/bin/env node
// Per-agent Slack event stream binary. Tails the machine-wide singleton
// listener's events.jsonl and applies per-agent filters before emitting
// to stdout. One process per Monitor invocation; lightweight (no Socket
// Mode connection of its own — the singleton owns that).
//
// On startup: ensures the singleton is running (idempotent spawn via
// src/listener-singleton.mjs). On steady state: rotation-aware tail of
// events.jsonl, filter, emit, repeat. Maintains its own per-pid heartbeat
// file under stream-heartbeats/ so ops tooling can see who's listening.
//
// CLI flags (filters):
//   --watch-self            include events authored by the token-holder
//                           (default: drop them — matches today's listener)
//   --no-self               explicit form of the default
//   --include-subtypes      include subtype-bearing events (default: drop)
//   --channel <C…>          filter to one channel ID
//   --thread <ts>           filter to one thread (events whose thread_ts
//                           matches, plus the parent itself whose own ts
//                           matches)
//
// CLI flags (positioning / overrides):
//   --events-file <path>    override events.jsonl path (testing)
//
// Synthetic events (slack_connected / slack_disconnected) ALWAYS pass
// through — consumers need them to detect gaps.

import fs from 'node:fs';
import {
  HEARTBEAT_TICK_MS,
  eventsPath as defaultEventsPath,
  streamHeartbeatDir,
  ensureRunning,
} from '../src/listener-singleton.mjs';

const POLL_INTERVAL_MS = 100;       // tail poll cadence; sub-second latency
const READ_CHUNK_BYTES = 64 * 1024;

export function parseArgs(argv) {
  const out = {
    watchSelf: false,
    includeSubtypes: false,
    channel: null,
    thread: null,
    eventsFile: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--watch-self':
        out.watchSelf = true; break;
      case '--no-self':
        out.watchSelf = false; break;
      case '--include-subtypes':
        out.includeSubtypes = true; break;
      case '--channel':
        out.channel = argv[++i] ?? null; break;
      case '--thread':
        out.thread = argv[++i] ?? null; break;
      case '--events-file':
        out.eventsFile = argv[++i] ?? null; break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        console.error(`slack-listen-stream: unknown flag: ${arg}`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.error('Usage: slack-listen-stream.mjs [options]');
  console.error('  --watch-self           include self-authored events (default: drop)');
  console.error('  --no-self              explicit form of default');
  console.error('  --include-subtypes     include subtype-bearing events (default: drop)');
  console.error('  --channel <C…>         filter to one channel ID');
  console.error('  --thread <ts>          filter to one thread (matches thread_ts or parent ts)');
  console.error('  --events-file <path>   override events.jsonl path (testing)');
}

export function passesFilters(event, flags) {
  // Synthetic events always pass — they signal stream health.
  if (event && typeof event.event === 'string') return true;
  // Defensive: drop anything that isn't a shaped message event.
  if (!event || typeof event.ts !== 'string') return false;
  // Self filter
  if (event.is_self && !flags.watchSelf) return false;
  // Subtype filter — bot_id-bearing events (bot_message etc.) count as subtyped
  // for the include-subtypes gate.
  const subtypish = event.subtype || event.bot_id;
  if (subtypish && !flags.includeSubtypes) return false;
  // Channel filter
  if (flags.channel && event.channel !== flags.channel) return false;
  // Thread filter: include events whose thread_ts matches, plus the parent
  // message itself (event.ts === thread ts).
  if (flags.thread && event.thread_ts !== flags.thread && event.ts !== flags.thread) return false;
  return true;
}

// Tail the file with rotation-awareness.
// State: { fd, inode, offset }. On read returning 0 bytes, we check
// whether the path's current inode differs from ours (rename happened)
// or whether the current file size is smaller than our offset (truncation).
// In either case, close + reopen and reset offset.
function tailLoop(filePath, flags) {
  let state = openFresh(filePath, /*atEnd*/ true);
  if (!state) {
    console.error(`slack-listen-stream: could not open events file: ${filePath}`);
    process.exit(1);
  }
  let lineBuffer = '';

  function readChunk() {
    if (!state) return;
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytes;
    try {
      bytes = fs.readSync(state.fd, buf, 0, READ_CHUNK_BYTES, state.offset);
    } catch (err) {
      console.error(`slack-listen-stream: read failed: ${err.message}`);
      closeState();
      state = openFresh(filePath, false);
      return;
    }
    if (bytes > 0) {
      state.offset += bytes;
      lineBuffer += buf.toString('utf8', 0, bytes);
      flushLines();
      return;
    }
    // 0 bytes read — check for rotation.
    handleRotationCheck();
  }

  function handleRotationCheck() {
    let pathStat;
    try { pathStat = fs.statSync(filePath); }
    catch (err) {
      if (err.code === 'ENOENT') {
        // events.jsonl is briefly missing during rotate. Try again next tick.
        return;
      }
      console.error(`slack-listen-stream: stat failed: ${err.message}`);
      return;
    }
    // Inode change → rename (rotation) happened. Drain remaining bytes off
    // the old fd (none here since we just read 0), then reopen.
    if (pathStat.ino !== state.inode) {
      closeState();
      state = openFresh(filePath, false);
      return;
    }
    // Same inode but file shrank → truncation. Reset offset.
    if (pathStat.size < state.offset) {
      state.offset = 0;
    }
    // Otherwise: just waiting for new bytes, no action needed.
  }

  function closeState() {
    if (state && state.fd != null) {
      try { fs.closeSync(state.fd); } catch (_) { /* best effort */ }
    }
    state = null;
  }

  function flushLines() {
    let nl;
    while ((nl = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, nl);
      lineBuffer = lineBuffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch (err) {
        console.error(`slack-listen-stream: skip malformed line (${err.message}): ${line.slice(0, 120)}…`);
        continue;
      }
      if (passesFilters(event, flags)) {
        process.stdout.write(line + '\n');
      }
    }
  }

  const interval = setInterval(readChunk, POLL_INTERVAL_MS);
  // Stop the tail on signals so cleanup runs cleanly.
  function teardown() { clearInterval(interval); closeState(); }
  process.on('SIGTERM', teardown);
  process.on('SIGINT', teardown);
  process.on('SIGHUP', teardown);
}

// Open events.jsonl, optionally seeking to the end. Returns
// { fd, inode, offset } or null on hard failure.
function openFresh(filePath, atEnd) {
  try {
    // Create if missing — agents may boot before the singleton has emitted
    // anything yet. Mode 0600 in case we're the file creator.
    const fd = fs.openSync(filePath, 'a+', 0o600);
    const st = fs.fstatSync(fd);
    return { fd, inode: st.ino, offset: atEnd ? st.size : 0 };
  } catch (err) {
    console.error(`slack-listen-stream: openFresh(${filePath}) failed: ${err.message}`);
    return null;
  }
}

// Per-pid stream-binary heartbeat for diagnostics. Cheap touch every
// HEARTBEAT_TICK_MS so ops tooling can see active stream binaries.
function startStreamHeartbeat() {
  const dir = streamHeartbeatDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }
  const hbPath = `${dir}/${process.pid}.heartbeat`;
  fs.writeFileSync(hbPath, '', { mode: 0o600 });
  const timer = setInterval(() => {
    const now = new Date();
    try { fs.utimesSync(hbPath, now, now); }
    catch (err) {
      if (err.code === 'ENOENT') {
        try { fs.writeFileSync(hbPath, '', { mode: 0o600 }); } catch (_) { /* best effort */ }
      }
    }
  }, HEARTBEAT_TICK_MS);
  timer.unref();
  function cleanup() {
    try { fs.unlinkSync(hbPath); } catch (_) { /* best effort */ }
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('exit', cleanup);
}

async function main() {
  const flags = parseArgs(process.argv);
  const filePath = flags.eventsFile ?? defaultEventsPath();

  // Ensure the singleton is running. ensureRunning() inherits SLACK_* env
  // vars from us via process.env; if our env was stripped (Monitor child),
  // the singleton's own fallback (reading runtime tokens file) takes over.
  const result = await ensureRunning();
  if (result.error) {
    console.error(`slack-listen-stream: singleton ensure failed: ${result.error}`);
    process.exit(1);
  }
  if (result.warning) {
    console.error(`slack-listen-stream: singleton spawned but no heartbeat yet — ${result.warning} (pid=${result.pid})`);
  }
  if (result.alreadyRunning) {
    console.error(`slack-listen-stream: singleton alive (pid=${result.pid}, heartbeat_age=${result.heartbeat_age_ms}ms)`);
  } else if (result.spawned) {
    console.error(`slack-listen-stream: spawned singleton (pid=${result.pid})`);
  }

  startStreamHeartbeat();
  tailLoop(filePath, flags);
}

// Only run main() when invoked directly, not when imported (e.g. by tests).
// import.meta.url is file://… for direct invocation; argv[1] is the script path.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`slack-listen-stream: fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
