// Shared handoff of Slack tokens from the MCP server (which has them in env)
// to the Socket Mode listener (which is spawned by Monitor and inherits a
// stripped env). Tokens land in the user's runtime tmpfs, mode 0600 — see
// README §Listener for the threat-model rationale.
//
// File layout:  $XDG_RUNTIME_DIR/slack-self-mcp/tokens.env
// Fallback:     /tmp/slack-self-mcp-<uid>/tokens.env  (mkdir -m 0700)
// Format:       dotenv-style KEY=value, one per line. Quotes/escapes not used
//               (the server controls what's written; tokens are opaque ASCII).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN_KEYS = ['SLACK_USER_TOKEN', 'SLACK_APP_TOKEN'];

function runtimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, 'slack-self-mcp');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return path.join(os.tmpdir(), `slack-self-mcp-${uid}`);
}

export function runtimeTokensPath() {
  return path.join(runtimeDir(), 'tokens.env');
}

export function writeTokens(tokens) {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Force 0700 even if the dir pre-existed with looser perms.
  try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }

  const lines = [];
  for (const k of TOKEN_KEYS) {
    const v = tokens[k];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (v.includes('\n')) throw new Error(`refusing to write ${k}: contains newline`);
    lines.push(`${k}=${v}`);
  }
  const body = lines.join('\n') + '\n';

  const target = runtimeTokensPath();
  // Atomic-ish write: tmp file then rename. Mode is set on creation.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, target);
  // Re-assert mode in case umask altered it.
  try { fs.chmodSync(target, 0o600); } catch (_) { /* best effort */ }
  return target;
}

export function readTokens() {
  const target = runtimeTokensPath();
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const out = {};
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1);
    if (TOKEN_KEYS.includes(k)) out[k] = v;
  }
  return out;
}

export function removeTokens() {
  try { fs.unlinkSync(runtimeTokensPath()); } catch (_) { /* best effort */ }
}
