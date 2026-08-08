/**
 * Who is using this browser.
 *
 * With no table open this module answers "nobody, and it does not matter" -
 * single-player has no login and must not grow one. The moment a DM opens a
 * table, every browser needs a token to write anything, and this is where that
 * token lives.
 *
 * The token is stored in localStorage so a player who reloads mid-session is
 * not asked to rejoin. It is a bearer token for a game at a table, not a
 * credential worth defending: the honest description, which the UI repeats, is
 * that a join code keeps a stranger on the same wifi from wandering in - it is
 * not authentication and this project does not claim it is.
 */

import { serverBase } from './db.js';

const TOKEN_KEY = 'toonanvil.token';

let cached = null;

export function token() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: the session lasts as long as the tab */ }
}

/** Headers for an authenticated request. Empty when there is no token. */
export function authHeaders() {
  const t = token();
  return t ? { 'X-Toon-Token': t } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(`${serverBase()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

/* ------------------------------------------------------------------ */

/**
 * The current table and my place at it.
 *
 * Never throws: with no server, or an old build, the answer is simply "no
 * table", which is the same state solo play is already in.
 */
export async function refresh() {
  try {
    cached = await api('/api/table');
  } catch {
    cached = { open: false, me: null, profiles: [] };
  }
  return cached;
}

export function current() { return cached; }
export function isOpen() { return Boolean(cached?.open); }
export function me() { return cached?.me || null; }

/** Everyone is the DM until a table says otherwise - solo play is admin. */
export function isDm() { return !isOpen() || cached?.me?.role === 'dm'; }
export function isPlayer() { return isOpen() && cached?.me?.role === 'player'; }

/** Joined, or looking at a table we have not been let into yet. */
export function needsJoin() { return isOpen() && !cached?.me; }

/** Characters this browser may edit. DM: all of them. */
export function ownedCharacterIds() {
  if (!isOpen() || isDm()) return null;          // null means "no restriction"
  return new Set(cached?.me?.characterIds || []);
}

export function mayEdit(character) {
  const owned = ownedCharacterIds();
  if (owned === null) return true;
  return owned.has(character?.id) || character?.ownerId === cached?.me?.id;
}

/* ------------------------------------------------------------------ */

export async function openTable(name = 'DM') {
  const out = await api('/api/table/open', {
    method: 'POST', body: JSON.stringify({ name }),
  });
  if (out.token) setToken(out.token);
  await refresh();
  return out;
}

export async function closeTable() {
  const out = await api('/api/table/close', { method: 'POST' });
  setToken(null);
  await refresh();
  return out;
}

export async function join({ code, name, profileId = null }) {
  const out = await api('/api/table/join', {
    method: 'POST', body: JSON.stringify({ code, name, profileId }),
  });
  if (out.ok && out.token) setToken(out.token);
  await refresh();
  return out;
}

export async function leave() {
  await api('/api/table/leave', { method: 'POST' }).catch(() => {});
  setToken(null);
  await refresh();
}

/** Bind a character to a profile - mine, or anyone's if I am the DM. */
export async function claim(characterId, profileId = null) {
  const out = await api('/api/table/claim', {
    method: 'POST', body: JSON.stringify({ characterId, profileId }),
  });
  await refresh();
  return out;
}
