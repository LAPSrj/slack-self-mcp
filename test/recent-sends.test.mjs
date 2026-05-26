// Tests for src/recent-sends.mjs — the shared dedup state the singleton
// listener uses to suppress echoes of our own outbound posts.
//
// Each test gets its own XDG_RUNTIME_DIR pointing into a per-test tmpdir,
// so writes don't collide with a real running MCP server on the same machine.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const ORIG_XDG = process.env.XDG_RUNTIME_DIR;
let SANDBOX;
let mod;

beforeEach(async () => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-self-mcp-test-'));
  process.env.XDG_RUNTIME_DIR = SANDBOX;
  const cacheBust = `?b=${Date.now()}-${Math.random()}`;
  mod = await import(`../src/recent-sends.mjs${cacheBust}`);
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('recent-sends (shared, singleton-scope)', () => {
  it('recentSendsPath returns a single shared path (no pid suffix)', () => {
    const p = mod.recentSendsPath();
    assert.equal(path.basename(p), 'recent-sends.jsonl');
    // Stable across calls — not per-pid.
    assert.equal(mod.recentSendsPath(), p);
  });

  it('recordSend creates the file with mode 0600 inside a 0700 dir', () => {
    const p = mod.recordSend({ ts: '1234.5678', channel: 'C111' });
    assert.equal(p, mod.recentSendsPath());
    const st = fs.statSync(p);
    assert.equal(st.mode & 0o777, 0o600);
    const dirSt = fs.statSync(path.dirname(p));
    assert.equal(dirSt.mode & 0o777, 0o700);
  });

  it('recordSend appends one JSON line per call', () => {
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    mod.recordSend({ ts: '2.2', channel: 'C2' });
    mod.recordSend({ ts: '3.3', channel: 'C3' });
    const lines = fs.readFileSync(mod.recentSendsPath(), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.ts), ['1.1', '2.2', '3.3']);
    for (const e of parsed) assert.equal(typeof e.sent_at, 'number');
  });

  it('multiple "MCP servers" appending to the same shared file are all visible to readers', () => {
    // Simulate two sibling servers (we can't actually fork here, but recordSend
    // appends with O_APPEND so the same effect — three calls, three entries).
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    mod.recordSend({ ts: '2.2', channel: 'C2' });
    mod.recordSend({ ts: '3.3', channel: 'C3' });
    const fresh = mod.readRecentSends();
    assert.deepEqual(fresh.map((e) => e.ts), ['1.1', '2.2', '3.3']);
  });

  it('readRecentSends returns [] when the file is missing (fail-soft)', () => {
    assert.deepEqual(mod.readRecentSends(), []);
  });

  it('readRecentSends filters entries older than ttlMs', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.recentSendsPath()), { recursive: true, mode: 0o700 });
    const lines = [
      JSON.stringify({ ts: 'old', channel: 'C1', sent_at: now - 10 * 60 * 1000 }),
      JSON.stringify({ ts: 'mid', channel: 'C1', sent_at: now - 2 * 60 * 1000 }),
      JSON.stringify({ ts: 'new', channel: 'C1', sent_at: now }),
    ].join('\n') + '\n';
    fs.writeFileSync(mod.recentSendsPath(), lines, { mode: 0o600 });

    const fresh = mod.readRecentSends({ ttlMs: 5 * 60 * 1000, now });
    assert.deepEqual(fresh.map((e) => e.ts), ['mid', 'new']);
  });

  it('readRecentSends skips malformed lines without throwing', () => {
    fs.mkdirSync(path.dirname(mod.recentSendsPath()), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const lines = [
      'not-json',
      JSON.stringify({ ts: 'good', channel: 'C1', sent_at: now }),
      '{"missing":"channel","ts":"x","sent_at":' + now + '}',
      '',
      JSON.stringify({ ts: 'also-good', channel: 'C2', sent_at: now }),
    ].join('\n') + '\n';
    fs.writeFileSync(mod.recentSendsPath(), lines);
    const fresh = mod.readRecentSends({ now });
    assert.deepEqual(fresh.map((e) => e.ts).sort(), ['also-good', 'good']);
  });

  it('matchesRecentSend matches on (channel, ts) only', () => {
    const entries = [
      { ts: '1.1', channel: 'C1', sent_at: Date.now() },
      { ts: '2.2', channel: 'C2', sent_at: Date.now() },
    ];
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C1', ts: '1.1' }), true);
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C2', ts: '2.2' }), true);
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C3', ts: '1.1' }), false);
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C1', ts: '9.9' }), false);
    assert.equal(mod.matchesRecentSend([], { channel: 'C1', ts: '1.1' }), false);
  });

  it('pruneRecentSends drops stale entries and rewrites the file', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.recentSendsPath()), { recursive: true, mode: 0o700 });
    const lines = [
      JSON.stringify({ ts: 'old', channel: 'C1', sent_at: now - 10 * 60 * 1000 }),
      JSON.stringify({ ts: 'fresh', channel: 'C1', sent_at: now }),
    ].join('\n') + '\n';
    fs.writeFileSync(mod.recentSendsPath(), lines);

    const ok = mod.pruneRecentSends({ ttlMs: 5 * 60 * 1000, now });
    assert.equal(ok, true);
    const after = fs.readFileSync(mod.recentSendsPath(), 'utf8').trim().split('\n');
    assert.equal(after.length, 1);
    assert.equal(JSON.parse(after[0]).ts, 'fresh');
  });

  it('pruneRecentSends deletes the file when all entries are stale', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(mod.recentSendsPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      mod.recentSendsPath(),
      JSON.stringify({ ts: 'old', channel: 'C1', sent_at: now - 10 * 60 * 1000 }) + '\n',
    );
    const ok = mod.pruneRecentSends({ ttlMs: 60 * 1000, now });
    assert.equal(ok, true);
    assert.equal(fs.existsSync(mod.recentSendsPath()), false);
  });

  it('recordSend tolerates a missing/unwritable runtime dir (returns null)', () => {
    const blocker = path.join(SANDBOX, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    process.env.XDG_RUNTIME_DIR = blocker;
    const result = mod.recordSend({ ts: '1.1', channel: 'C1' });
    assert.equal(result, null);
  });

  it('recordSend ignores empty/invalid inputs', () => {
    assert.equal(mod.recordSend({ ts: '', channel: 'C1' }), null);
    assert.equal(mod.recordSend({ ts: '1.1', channel: '' }), null);
    assert.equal(mod.recordSend({ ts: null, channel: 'C1' }), null);
    assert.equal(fs.existsSync(mod.recentSendsPath()), false);
  });
});
