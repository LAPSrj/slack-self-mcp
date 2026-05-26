// Singleton-listener coordination. One slack-listen daemon per machine
// owns the Socket Mode connection and writes shaped+enriched events to
// events.jsonl; every MCP server boot + every per-agent stream binary
// uses ensureRunning() to bring it up if it's not already alive.
//
// Liveness is decided by heartbeat freshness alone (singleton touches
// listener.heartbeat every 10s; we consider it alive if mtime < 30s).
// listener.pid is informational. spawn.lock prevents concurrent
// double-spawns when several MCP boots see a stale heartbeat at once.
//
// All files live in the same per-user runtime dir as tokens.env and
// recent-sends.jsonl: $XDG_RUNTIME_DIR/slack-self-mcp/ (or /tmp/...-<uid>/).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HEARTBEAT_TTL_MS = 30_000;
export const HEARTBEAT_TICK_MS = 10_000;
const FIRST_HEARTBEAT_WAIT_MS = 1500;
const SPAWN_LOCK_TIMEOUT_MS = 2000;
const HEARTBEAT_POLL_MS = 50;

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(__filename), '..');
export const SINGLETON_LISTENER_PATH = path.join(PACKAGE_ROOT, 'scripts', 'slack-listen.mjs');

function runtimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'slack-self-mcp');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return path.join(os.tmpdir(), `slack-self-mcp-${uid}`);
}

export function heartbeatPath() { return path.join(runtimeDir(), 'listener.heartbeat'); }
export function pidFilePath() { return path.join(runtimeDir(), 'listener.pid'); }
export function spawnLockPath() { return path.join(runtimeDir(), 'listener.spawn.lock'); }
export function listenerLogPath() { return path.join(runtimeDir(), 'listener.log'); }
export function eventsPath() { return path.join(runtimeDir(), 'events.jsonl'); }
export function eventsRotatedPath() { return path.join(runtimeDir(), 'events.1.jsonl'); }
export function streamHeartbeatDir() { return path.join(runtimeDir(), 'stream-heartbeats'); }

function ensureDir() {
  fs.mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeDir(), 0o700); } catch (_) { /* best effort */ }
}

export function heartbeatAgeMs() {
  try {
    const st = fs.statSync(heartbeatPath());
    return Date.now() - st.mtimeMs;
  } catch (_) { return null; }
}

export function singletonAlive() {
  const age = heartbeatAgeMs();
  return age !== null && age < HEARTBEAT_TTL_MS;
}

export function singletonPid() {
  try {
    const raw = fs.readFileSync(pidFilePath(), 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) { return null; }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHeartbeat(ttlMs) {
  const deadline = Date.now() + ttlMs;
  while (Date.now() < deadline) {
    if (singletonAlive()) return true;
    await sleep(HEARTBEAT_POLL_MS);
  }
  return singletonAlive();
}

// Best-effort detached spawn. logFd is opened append-mode so the daemon's
// stderr/stdout land in listener.log. The spawning process must close its
// own copy after spawn returns — child inherits its own fd.
function spawnDetached({ singletonPath, env }) {
  ensureDir();
  const logFd = fs.openSync(listenerLogPath(), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [singletonPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...env },
    });
    child.unref();
    return child.pid;
  } finally {
    try { fs.closeSync(logFd); } catch (_) { /* best effort */ }
  }
}

// Acquire a short-lived O_EXCL lock on spawn.lock. Returns the fd on
// success or null on contention. Callers MUST close + unlink in a finally.
function tryAcquireSpawnLock() {
  try {
    return fs.openSync(
      spawnLockPath(),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

function releaseSpawnLock(fd) {
  if (fd !== null && fd !== undefined) {
    try { fs.closeSync(fd); } catch (_) { /* best effort */ }
  }
  try { fs.unlinkSync(spawnLockPath()); } catch (_) { /* best effort */ }
}

// Ensures a singleton slack-listen daemon is running. Returns:
//   { alreadyRunning: true,  pid, heartbeat_age_ms }
//   { spawned:        true,  pid, heartbeat_age_ms, warning? }
//   { error: '<code>', ... } on hard failure (caller decides whether to surface)
//
// Options:
//   singletonPath: override the default listener path (tests only).
//   env: extra env vars to pass to the spawned child (e.g. SLACK_USER_TOKEN
//        when caller has them; otherwise child inherits via process.env).
export async function ensureRunning({ singletonPath = SINGLETON_LISTENER_PATH, env = {} } = {}) {
  ensureDir();

  if (singletonAlive()) {
    return { alreadyRunning: true, pid: singletonPid(), heartbeat_age_ms: heartbeatAgeMs() };
  }

  let lockFd = tryAcquireSpawnLock();
  if (lockFd === null) {
    // Concurrent spawn in flight — wait for the winner's heartbeat.
    if (await waitForHeartbeat(SPAWN_LOCK_TIMEOUT_MS)) {
      return {
        alreadyRunning: true, pid: singletonPid(),
        heartbeat_age_ms: heartbeatAgeMs(), spawnedByPeer: true,
      };
    }
    // Spawn lock is stuck (peer crashed before posting heartbeat). Reclaim.
    try { fs.unlinkSync(spawnLockPath()); } catch (_) { /* best effort */ }
    lockFd = tryAcquireSpawnLock();
    if (lockFd === null) {
      return { error: 'spawn_lock_contention' };
    }
  }

  try {
    fs.writeSync(lockFd, `${process.pid}\n${Date.now()}\n`);
    // Last-chance recheck — singleton may have come up between our liveness
    // check and lock acquisition.
    if (singletonAlive()) {
      return {
        alreadyRunning: true, pid: singletonPid(),
        heartbeat_age_ms: heartbeatAgeMs(),
      };
    }
    const childPid = spawnDetached({ singletonPath, env });
    const ok = await waitForHeartbeat(FIRST_HEARTBEAT_WAIT_MS);
    return {
      spawned: true,
      pid: singletonPid() ?? childPid,
      heartbeat_age_ms: heartbeatAgeMs(),
      ...(ok ? {} : { warning: 'no_heartbeat_within_first_attempt' }),
    };
  } finally {
    releaseSpawnLock(lockFd);
  }
}

// === Daemon-side API (called by the singleton process itself) ===

export function writeHeartbeat() {
  ensureDir();
  const now = new Date();
  const target = heartbeatPath();
  try {
    fs.utimesSync(target, now, now);
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.writeFileSync(target, '', { mode: 0o600 });
    } else { throw err; }
  }
}

export function writePidFile(pid = process.pid) {
  ensureDir();
  fs.writeFileSync(pidFilePath(), String(pid) + '\n', { mode: 0o600 });
}

export function clearSingletonFiles() {
  for (const p of [heartbeatPath(), pidFilePath()]) {
    try { fs.unlinkSync(p); } catch (_) { /* best effort */ }
  }
}
