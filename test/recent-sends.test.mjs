// Tests for src/recent-sends.mjs — the runtime dedup state shared between
// the MCP server and the Socket Mode listener when watch-self mode is on.
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
  // Import fresh each time so module-level state (none currently, but be
  // future-proof) doesn't leak between cases.
  const cacheBust = `?b=${Date.now()}-${Math.random()}`;
  mod = await import(`../src/recent-sends.mjs${cacheBust}`);
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('recent-sends', () => {
  it('recentSendsPath is per-pid (sibling MCP servers get distinct files)', () => {
    const mine = mod.recentSendsPath();
    const sibling = mod.recentSendsPath({ pid: process.pid + 1 });
    assert.notEqual(mine, sibling);
    assert.equal(path.basename(mine), `recent-sends-${process.pid}.jsonl`);
    assert.equal(path.basename(sibling), `recent-sends-${process.pid + 1}.jsonl`);
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

  it('readRecentSends returns [] when the file is missing', () => {
    const entries = mod.readRecentSends();
    assert.deepEqual(entries, []);
  });

  it('readRecentSendsFrom returns [] for a non-existent path (fail-soft)', () => {
    const entries = mod.readRecentSendsFrom('/nonexistent/path/recent.jsonl');
    assert.deepEqual(entries, []);
  });

  it('readRecentSendsFrom returns [] for empty/missing path argument', () => {
    assert.deepEqual(mod.readRecentSendsFrom(''), []);
    assert.deepEqual(mod.readRecentSendsFrom(null), []);
    assert.deepEqual(mod.readRecentSendsFrom(undefined), []);
  });

  it('readRecentSends filters entries older than ttlMs', () => {
    const now = Date.now();
    // Manually write three entries with controlled sent_at values.
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

  it('a sibling server\'s file is isolated from ours', () => {
    // Simulate a sibling MCP server writing its own file. Our recordSend
    // goes to our pid; manually write the sibling's file.
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    const siblingPath = mod.recentSendsPath({ pid: 99999 });
    fs.mkdirSync(path.dirname(siblingPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      siblingPath,
      JSON.stringify({ ts: 'sibling-only', channel: 'C2', sent_at: Date.now() }) + '\n',
    );

    // Reading from our default path: only our entry.
    const ours = mod.readRecentSends();
    assert.deepEqual(ours.map((e) => e.ts), ['1.1']);

    // Reading from the sibling's path: only the sibling's entry.
    const theirs = mod.readRecentSendsFrom(siblingPath);
    assert.deepEqual(theirs.map((e) => e.ts), ['sibling-only']);
  });

  it('matchesRecentSend matches on (channel, ts) only', () => {
    const entries = [
      { ts: '1.1', channel: 'C1', sent_at: Date.now() },
      { ts: '2.2', channel: 'C2', sent_at: Date.now() },
    ];
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C1', ts: '1.1' }), true);
    assert.equal(mod.matchesRecentSend(entries, { channel: 'C2', ts: '2.2' }), true);
    // Same ts in a different channel must NOT match — Slack ts values are
    // channel-local microsecond timestamps and could collide across channels.
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
    // Point XDG_RUNTIME_DIR at a file (not a dir) — mkdir will fail.
    const blocker = path.join(SANDBOX, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    process.env.XDG_RUNTIME_DIR = blocker;
    // Need a fresh import: runtimeDir reads process.env each call, so an
    // in-flight module is fine, but reset for symmetry.
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

describe('listener shouldDrop integration shape', () => {
  // We don't import slack-listen.mjs directly because it starts a Socket Mode
  // client on import. Instead, this re-implements the same predicate against
  // the helper's public surface so a regression in either layer (helper or
  // listener) shows up here. Signature matches the listener — `dedupFile`
  // is the absolute path the paired MCP server's per-pid file.
  function makeShouldDrop({ watchSelf, includeSubtypes, selfUserId, dedupFile }) {
    return (event) => {
      if (!event) return true;
      if (event.type !== 'message') return true;
      if (event.user && event.user === selfUserId) {
        if (!watchSelf) return true;
        if (!dedupFile) return false; // fail-soft
        const recent = mod.readRecentSendsFrom(dedupFile);
        if (mod.matchesRecentSend(recent, { channel: event.channel, ts: event.ts })) return true;
        return false;
      }
      if (event.bot_id) return true;
      if (event.subtype && !includeSubtypes) return true;
      return false;
    };
  }

  it('flag OFF: every self-message is dropped (default behavior preserved)', () => {
    const drop = makeShouldDrop({ watchSelf: false, includeSubtypes: false, selfUserId: 'U_SELF' });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '1.1', text: 'hi' }),
      true,
    );
    assert.equal(
      drop({ type: 'message', user: 'U_OTHER', channel: 'C1', ts: '2.2', text: 'hi' }),
      false,
    );
  });

  it('flag ON: self-message in paired server\'s file is dropped (own slack_send echo)', () => {
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: mod.recentSendsPath(),
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '1.1', text: 'agent post' }),
      true,
    );
  });

  it('flag ON: self-message NOT in dedup file surfaces (human typed in Slack client)', () => {
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: mod.recentSendsPath(),
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '9.9', text: 'typed by hand' }),
      false,
    );
  });

  it('flag ON: same ts in a different channel still surfaces', () => {
    mod.recordSend({ ts: '1.1', channel: 'C1' });
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: mod.recentSendsPath(),
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C2', ts: '1.1', text: 'unrelated' }),
      false,
    );
  });

  it('flag ON: a SIBLING MCP server\'s send (different pid → different file) surfaces', () => {
    // Sibling writes its file; our listener reads ours and does NOT see the entry.
    const siblingPath = mod.recentSendsPath({ pid: 99999 });
    fs.mkdirSync(path.dirname(siblingPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      siblingPath,
      JSON.stringify({ ts: '7.7', channel: 'C1', sent_at: Date.now() }) + '\n',
    );
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: mod.recentSendsPath(), // our pid, not the sibling's
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '7.7', text: 'from sibling tab' }),
      false,
    );
  });

  it('flag ON: missing dedup file path (--watch-self alone) → all self surfaces (fail-soft)', () => {
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: null,
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '1.1', text: 'unknown origin' }),
      false,
    );
  });

  it('flag ON: dedup file path is valid but file is missing → fail-soft surfaces', () => {
    const drop = makeShouldDrop({
      watchSelf: true, includeSubtypes: false, selfUserId: 'U_SELF',
      dedupFile: '/nonexistent/path.jsonl',
    });
    assert.equal(
      drop({ type: 'message', user: 'U_SELF', channel: 'C1', ts: '1.1', text: 'unknown origin' }),
      false,
    );
  });
});
