// Resolve a free-form target string to a Slack channel ID.
//
// Inputs accepted:
//   #channel-name, C..., G... (channels)
//   @handle, U..., W...        (users → DM via conversations.open)
//   email                      (users.lookupByEmail, then fuzzy)
//   bare string                (search channels + users)
//
// Returns either { channel_id, type, display, ... } on a unique match,
// or { error: 'no_match' | 'ambiguous', input, candidates: [...], hint, more_available? }.
//
// All directory lookups are cached for the process lifetime. Channel/user
// lists are fetched lazily and refreshed only on explicit cache-bust (not
// implemented — long-lived MCP servers should be restarted to re-sync).

const CACHE = {
  resolved: new Map(),    // input → { channel_id, type, ... }
  channels: null,         // [{ id, name, is_private, is_im, is_mpim }]
  users: null,            // [{ id, name, real_name, display_name, email, deleted, is_bot }]
  dms: new Map(),         // user_id → channel_id
  userById: new Map(),    // user_id → { name, real_name, display_name, email }
};

// Lookup a user by ID for display purposes. Pulls from the bulk list if it's
// already populated (resolver path), otherwise falls back to users.info and
// caches by id. Never throws — returns nulls on failure.
export async function lookupUserName(client, userId) {
  if (!userId) return null;
  if (CACHE.userById.has(userId)) return CACHE.userById.get(userId);
  if (CACHE.users) {
    const hit = CACHE.users.find((u) => u.id === userId);
    if (hit) {
      const entry = { name: hit.name, real_name: hit.real_name, display_name: hit.display_name, email: hit.email };
      CACHE.userById.set(userId, entry);
      return entry;
    }
  }
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user ?? {};
    const entry = {
      name: u.name ?? null,
      real_name: u.real_name ?? u.profile?.real_name ?? null,
      display_name: u.profile?.display_name || u.profile?.display_name_normalized || null,
      email: u.profile?.email ?? null,
    };
    CACHE.userById.set(userId, entry);
    return entry;
  } catch (_) {
    const entry = { name: null, real_name: null, display_name: null, email: null };
    CACHE.userById.set(userId, entry);
    return entry;
  }
}

function clearCachedResolution(input) {
  CACHE.resolved.delete(input);
}

async function listAllChannels(client) {
  if (CACHE.channels) return CACHE.channels;
  const out = [];
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const c of res.channels ?? []) {
      out.push({
        id: c.id,
        name: c.name ?? null,
        is_private: !!c.is_private,
        is_im: !!c.is_im,
        is_mpim: !!c.is_mpim,
        user: c.user ?? null,
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  CACHE.channels = out;
  return out;
}

async function listAllUsers(client) {
  if (CACHE.users) return CACHE.users;
  const out = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 1000, cursor });
    for (const u of res.members ?? []) {
      if (u.deleted) continue;
      out.push({
        id: u.id,
        name: u.name ?? null,
        real_name: u.real_name ?? u.profile?.real_name ?? null,
        display_name: u.profile?.display_name || u.profile?.display_name_normalized || null,
        email: u.profile?.email ?? null,
        is_bot: !!u.is_bot,
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  CACHE.users = out;
  return out;
}

async function openDm(client, userId) {
  if (CACHE.dms.has(userId)) return CACHE.dms.get(userId);
  const res = await client.conversations.open({ users: userId });
  const id = res.channel?.id;
  if (!id) throw new Error(`conversations.open returned no channel.id for user ${userId}`);
  CACHE.dms.set(userId, id);
  return id;
}

function scoreMatch(needle, haystack) {
  if (!haystack) return null;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 0;
  if (h.startsWith(n)) return 1;
  if (h.includes(n)) return 2;
  return null;
}

function bestScore(needle, fields) {
  let best = null;
  for (const f of fields) {
    const s = scoreMatch(needle, f);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

function searchChannels(channels, needle) {
  const stripped = needle.startsWith('#') ? needle.slice(1) : needle;
  const results = [];
  for (const c of channels) {
    if (c.is_im || c.is_mpim) continue;
    if (!c.name) continue;
    const s = scoreMatch(stripped, c.name);
    if (s !== null) {
      results.push({
        score: s,
        target_id: c.id,
        type: c.is_private ? 'private_channel' : 'public_channel',
        display: `#${c.name}`,
        name: c.name,
      });
    }
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

function searchUsers(users, needle) {
  const stripped = needle.startsWith('@') ? needle.slice(1) : needle;
  const results = [];
  for (const u of users) {
    if (u.is_bot) continue; // sends-as-user; bot DMs are noisy
    const s = bestScore(stripped, [u.name, u.display_name, u.real_name, u.email]);
    if (s !== null) {
      results.push({
        score: s,
        target_id: u.id,
        type: 'user',
        display: u.name ? `@${u.name}` : `@${u.id}`,
        name: u.name,
        real_name: u.real_name,
        email: u.email,
      });
    }
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

const ID_RE = /^[CGDUW][A-Z0-9]{6,}$/;
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;

// Trim 10 candidates max and report whether more existed.
function cap(list, n = 10) {
  if (list.length <= n) return { candidates: list, more_available: false };
  return { candidates: list.slice(0, n), more_available: true };
}

function stripCandidateScores(list) {
  return list.map(({ score, ...rest }) => rest);
}

// Public: resolve a target. Returns { channel_id, type, display, ... } on hit,
// or { error, input, candidates, hint, more_available? } on miss/ambiguity.
export async function resolveTarget(client, rawInput) {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    return { error: 'no_match', input: String(rawInput ?? ''), candidates: [], hint: 'target must be a non-empty string' };
  }
  const input = rawInput.trim();
  if (CACHE.resolved.has(input)) return CACHE.resolved.get(input);

  // 1. Already a channel ID — verify membership/access.
  if (CHANNEL_ID_RE.test(input)) {
    try {
      const info = await client.conversations.info({ channel: input });
      const c = info.channel;
      const result = {
        channel_id: c.id,
        type: c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private_channel' : 'public_channel',
        display: c.name ? `#${c.name}` : c.id,
        name: c.name ?? null,
      };
      CACHE.resolved.set(input, result);
      return result;
    } catch (err) {
      return {
        error: 'no_match',
        input,
        candidates: [],
        hint: `conversations.info failed for ${input}: ${err.data?.error || err.message}`,
      };
    }
  }

  // 2. Already a user ID — open DM.
  if (USER_ID_RE.test(input)) {
    try {
      const channel_id = await openDm(client, input);
      const users = await listAllUsers(client);
      const u = users.find((x) => x.id === input);
      const result = {
        channel_id,
        type: 'user',
        display: u?.name ? `@${u.name}` : input,
        user_id: input,
        name: u?.name ?? null,
        real_name: u?.real_name ?? null,
      };
      CACHE.resolved.set(input, result);
      return result;
    } catch (err) {
      return {
        error: 'no_match',
        input,
        candidates: [],
        hint: `conversations.open failed for ${input}: ${err.data?.error || err.message}`,
      };
    }
  }

  // 3. Email — try exact lookup first.
  if (looksLikeEmail(input)) {
    try {
      const res = await client.users.lookupByEmail({ email: input });
      const userId = res.user?.id;
      if (userId) {
        const channel_id = await openDm(client, userId);
        const result = {
          channel_id,
          type: 'user',
          display: res.user.name ? `@${res.user.name}` : userId,
          user_id: userId,
          name: res.user.name ?? null,
          real_name: res.user.real_name ?? null,
          email: input,
        };
        CACHE.resolved.set(input, result);
        return result;
      }
    } catch (err) {
      // fall through to fuzzy
      if (err.data?.error && err.data.error !== 'users_not_found') {
        return {
          error: 'no_match',
          input,
          candidates: [],
          hint: `users.lookupByEmail failed: ${err.data.error}`,
        };
      }
    }
  }

  // 4. #channel-name — search channels only.
  if (input.startsWith('#')) {
    const channels = await listAllChannels(client);
    const hits = searchChannels(channels, input);
    if (hits.length === 1 && hits[0].score === 0) {
      const channel_id = hits[0].target_id;
      const result = { channel_id, type: hits[0].type, display: hits[0].display, name: hits[0].name };
      CACHE.resolved.set(input, result);
      return result;
    }
    const { candidates, more_available } = cap(hits);
    return {
      error: hits.length === 0 ? 'no_match' : 'ambiguous',
      input,
      candidates: stripCandidateScores(candidates),
      more_available,
      hint: 're-call slack_send with target set to one of the target_id values',
    };
  }

  // 5. @handle — search users only.
  if (input.startsWith('@')) {
    const users = await listAllUsers(client);
    const hits = searchUsers(users, input);
    return await finalizeUserSearch(client, input, hits);
  }

  // 6. Bare string — search channels + users.
  const [channels, users] = await Promise.all([listAllChannels(client), listAllUsers(client)]);
  const channelHits = searchChannels(channels, input);
  const userHits = searchUsers(users, input);

  // Exact unique hit shortcut.
  const exact = [...channelHits, ...userHits].filter((h) => h.score === 0);
  if (exact.length === 1) {
    const hit = exact[0];
    if (hit.type === 'user') {
      const channel_id = await openDm(client, hit.target_id);
      const result = { channel_id, type: 'user', display: hit.display, user_id: hit.target_id, name: hit.name, real_name: hit.real_name };
      CACHE.resolved.set(input, result);
      return result;
    }
    const result = { channel_id: hit.target_id, type: hit.type, display: hit.display, name: hit.name };
    CACHE.resolved.set(input, result);
    return result;
  }

  const merged = [...channelHits, ...userHits].sort((a, b) => a.score - b.score);
  const { candidates, more_available } = cap(merged);
  return {
    error: merged.length === 0 ? 'no_match' : 'ambiguous',
    input,
    candidates: stripCandidateScores(candidates),
    more_available,
    hint: 're-call slack_send with target set to one of the target_id values',
  };
}

async function finalizeUserSearch(client, input, hits) {
  if (hits.length === 1 && hits[0].score === 0) {
    const channel_id = await openDm(client, hits[0].target_id);
    const result = {
      channel_id,
      type: 'user',
      display: hits[0].display,
      user_id: hits[0].target_id,
      name: hits[0].name,
      real_name: hits[0].real_name,
    };
    CACHE.resolved.set(input, result);
    return result;
  }
  const { candidates, more_available } = cap(hits);
  return {
    error: hits.length === 0 ? 'no_match' : 'ambiguous',
    input,
    candidates: stripCandidateScores(candidates),
    more_available,
    hint: 're-call slack_send with target set to one of the target_id values',
  };
}

// Public: full search engine, used by slack_resolve.
export async function searchTargets(client, rawInput) {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    return { matches: [] };
  }
  const input = rawInput.trim();

  // ID inputs short-circuit to a single match.
  if (CHANNEL_ID_RE.test(input) || USER_ID_RE.test(input)) {
    const r = await resolveTarget(client, input);
    if (r.error) return { matches: [], error: r.error, hint: r.hint };
    return {
      matches: [
        {
          target_id: r.user_id ?? r.channel_id,
          type: r.type,
          display: r.display,
          name: r.name ?? null,
          real_name: r.real_name ?? null,
        },
      ],
    };
  }

  if (looksLikeEmail(input)) {
    try {
      const res = await client.users.lookupByEmail({ email: input });
      if (res.user) {
        return {
          matches: [
            {
              target_id: res.user.id,
              type: 'user',
              display: res.user.name ? `@${res.user.name}` : res.user.id,
              name: res.user.name ?? null,
              real_name: res.user.real_name ?? null,
              email: input,
            },
          ],
        };
      }
    } catch (_) {
      // fall through
    }
  }

  let hits;
  if (input.startsWith('#')) {
    hits = searchChannels(await listAllChannels(client), input);
  } else if (input.startsWith('@')) {
    hits = searchUsers(await listAllUsers(client), input);
  } else {
    const [channels, users] = await Promise.all([listAllChannels(client), listAllUsers(client)]);
    hits = [...searchChannels(channels, input), ...searchUsers(users, input)].sort((a, b) => a.score - b.score);
  }
  const { candidates, more_available } = cap(hits);
  return { matches: stripCandidateScores(candidates), more_available };
}

export const __testing = { CACHE, clearCachedResolution };
