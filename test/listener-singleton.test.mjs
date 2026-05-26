// Tests for src/listener-singleton.mjs — the helper that coordinates
// the one-listener-per-machine daemon model.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const ORIG_XDG = process.env.XDG_RUNTIME_DIR;
let SANDBOX;
let mod;

beforeEach(async () => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-self-mcp-singleton-'));
  process.env.XDG_RUNTIME_DIR = SANDBOX;
  const cacheBust = `?b=${Date.now()}-${Math.random()}`;
  mod = await import(`../src/listener-singleton.mjs${cacheBust}`);
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('listener-singleton paths', () => {
  it('all runtime files live under $XDG_RUNTIME_DIR/slack-self-mcp', () => {
    const dir = path.join(SANDBOX, 'slack-self-mcp');
    assert.equal(mod.heartbeatPath(), path.join(dir, 'listener.heartbeat'));
    assert.equal(mod.pidFilePath(), path.join(dir, 'listener.pid'));
    assert.equal(mod.spawnLockPath(), path.join(dir, 'listener.spawn.lock'));
    assert.equal(mod.listenerLogPath(), path.join(dir, 'listener.log'));
    assert.equal(mod.eventsPath(), path.join(dir, 'events.jsonl'));
    assert.equal(mod.eventsRotatedPath(), path.join(dir, 'events.1.jsonl'));
  });
});

describe('singletonAlive / heartbeat', () => {
  it('returns false when no heartbeat file exists', () => {
    assert.equal(mod.singletonAlive(), false);
    assert.equal(mod.heartbeatAgeMs(), null);
  });

  it('returns true when heartbeat is fresh', () => {
    mod.writeHeartbeat();
    assert.equal(mod.singletonAlive(), true);
    const age = mod.heartbeatAgeMs();
    assert.ok(age !== null && age >= 0 && age < 2000);
  });

  it('returns false when heartbeat is older than HEARTBEAT_TTL_MS', () => {
    mod.writeHeartbeat();
    // Backdate the file
    const old = new Date(Date.now() - (mod.HEARTBEAT_TTL_MS + 5000));
    fs.utimesSync(mod.heartbeatPath(), old, old);
    assert.equal(mod.singletonAlive(), false);
  });

  it('writeHeartbeat touches mtime on each call (existing file)', async () => {
    mod.writeHeartbeat();
    const first = fs.statSync(mod.heartbeatPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    mod.writeHeartbeat();
    const second = fs.statSync(mod.heartbeatPath()).mtimeMs;
    assert.ok(second > first, `expected ${second} > ${first}`);
  });

  it('writeHeartbeat creates file with mode 0600', () => {
    mod.writeHeartbeat();
    const st = fs.statSync(mod.heartbeatPath());
    assert.equal(st.mode & 0o777, 0o600);
  });
});

describe('pid file', () => {
  it('returns null when missing', () => {
    assert.equal(mod.singletonPid(), null);
  });

  it('roundtrips through writePidFile', () => {
    mod.writePidFile(12345);
    assert.equal(mod.singletonPid(), 12345);
  });

  it('returns null on malformed contents', () => {
    fs.mkdirSync(path.dirname(mod.pidFilePath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(mod.pidFilePath(), 'not-a-pid\n');
    assert.equal(mod.singletonPid(), null);
  });
});

describe('clearSingletonFiles', () => {
  it('removes heartbeat + pidfile if present, no-op if absent', () => {
    mod.writeHeartbeat();
    mod.writePidFile(42);
    mod.clearSingletonFiles();
    assert.equal(fs.existsSync(mod.heartbeatPath()), false);
    assert.equal(fs.existsSync(mod.pidFilePath()), false);
    // No-op second call
    assert.doesNotThrow(() => mod.clearSingletonFiles());
  });
});

describe('ensureRunning', () => {
  function writeStubSingleton({ heartbeatDelayMs = 0, exitAfterMs = 200 } = {}) {
    // Tiny script that writes a heartbeat after a delay then exits. Lets us
    // exercise ensureRunning without running the real Socket Mode listener.
    const stub = path.join(SANDBOX, 'stub-singleton.mjs');
    const body = `
import { writeHeartbeat, writePidFile } from '${mod.SINGLETON_LISTENER_PATH.replace(/slack-listen\\.mjs$/, '')}listener-singleton.mjs'.replace('${mod.SINGLETON_LISTENER_PATH.replace(/slack-listen\\.mjs$/, '')}listener-singleton.mjs', new URL('../src/listener-singleton.mjs', import.meta.url).href);
`;
    // The above template is too clever and brittle; do it the simple way:
    fs.writeFileSync(stub, simpleStubBody({ heartbeatDelayMs, exitAfterMs }));
    return stub;
  }

  function simpleStubBody({ heartbeatDelayMs, exitAfterMs }) {
    // Stub imports the helper from the repo's src/, writes a heartbeat,
    // sleeps, exits. Uses absolute import path so XDG override propagates
    // (env is inherited).
    const helperPath = new URL('../src/listener-singleton.mjs', import.meta.url).pathname;
    return `
import { writeHeartbeat, writePidFile } from '${helperPath}';
async function main() {
  if (${heartbeatDelayMs} > 0) await new Promise(r => setTimeout(r, ${heartbeatDelayMs}));
  writePidFile();
  writeHeartbeat();
  await new Promise(r => setTimeout(r, ${exitAfterMs}));
}
main().catch(err => { console.error(err); process.exit(1); });
`;
  }

  it('returns alreadyRunning when heartbeat is fresh', async () => {
    mod.writeHeartbeat();
    mod.writePidFile(999);
    const result = await mod.ensureRunning({ singletonPath: '/nonexistent/path' });
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.pid, 999);
    assert.ok(result.heartbeat_age_ms >= 0);
  });

  it('spawns a fresh singleton and returns spawned=true with the pid', async () => {
    const stubPath = path.join(SANDBOX, 'stub.mjs');
    fs.writeFileSync(stubPath, simpleStubBody({ heartbeatDelayMs: 100, exitAfterMs: 500 }));
    const result = await mod.ensureRunning({ singletonPath: stubPath });
    assert.equal(result.spawned, true, JSON.stringify(result));
    assert.ok(result.pid > 0);
    assert.equal(result.warning, undefined, `unexpected warning: ${result.warning}`);
    // Give the stub time to exit so it doesn't leak.
    await new Promise(r => setTimeout(r, 600));
  });

  it('returns spawned with a warning if the child does not heartbeat within window', async () => {
    const stubPath = path.join(SANDBOX, 'stub-slow.mjs');
    // Stub never writes a heartbeat — just sleeps.
    fs.writeFileSync(stubPath, `await new Promise(r => setTimeout(r, 3000));`);
    const result = await mod.ensureRunning({ singletonPath: stubPath });
    assert.equal(result.spawned, true);
    assert.equal(result.warning, 'no_heartbeat_within_first_attempt');
  });

  it('cleans up the spawn lock after success', async () => {
    const stubPath = path.join(SANDBOX, 'stub.mjs');
    fs.writeFileSync(stubPath, simpleStubBody({ heartbeatDelayMs: 50, exitAfterMs: 200 }));
    await mod.ensureRunning({ singletonPath: stubPath });
    assert.equal(fs.existsSync(mod.spawnLockPath()), false);
    await new Promise(r => setTimeout(r, 250));
  });

  it('cleans up the spawn lock after warning path too', async () => {
    const stubPath = path.join(SANDBOX, 'stub-slow.mjs');
    fs.writeFileSync(stubPath, `await new Promise(r => setTimeout(r, 3000));`);
    await mod.ensureRunning({ singletonPath: stubPath });
    assert.equal(fs.existsSync(mod.spawnLockPath()), false);
  });

  it('two concurrent ensureRunning calls only spawn once', async () => {
    const stubPath = path.join(SANDBOX, 'stub-race.mjs');
    fs.writeFileSync(stubPath, simpleStubBody({ heartbeatDelayMs: 100, exitAfterMs: 800 }));
    const [a, b] = await Promise.all([
      mod.ensureRunning({ singletonPath: stubPath }),
      mod.ensureRunning({ singletonPath: stubPath }),
    ]);
    const spawnedCount = [a, b].filter((r) => r.spawned === true).length;
    const peerCount = [a, b].filter((r) => r.spawnedByPeer === true || r.alreadyRunning === true).length;
    assert.equal(spawnedCount, 1, `expected exactly 1 spawn, got ${spawnedCount} | a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    assert.equal(peerCount, 1, `expected exactly 1 peer/already, got ${peerCount}`);
    await new Promise(r => setTimeout(r, 900));
  });
});
