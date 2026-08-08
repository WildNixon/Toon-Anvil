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

/* ------------------------------------------------------------------ */
/* the seat: player or Dungeon Master                                  */
/* ------------------------------------------------------------------ */

const ROLE_KEY = 'toonanvil.role';

// A sandbox seat lives here and only here - trying the DM screen in a
// sandbox must not change what the real session shows tomorrow.
let roleMemory = null;

/** The sandbox's seat rule, or null when this is not a sandbox. */
function ephemeralSeat() {
  const p = new URLSearchParams(location.search);
  if (p.get('storage') !== 'memory') return null;
  // Default DM: a sandbox exists to try everything. ?seat=player narrows it,
  // ?seat=ask shows the first-run welcome (the gym uses this to test it).
  return p.get('seat') || 'dm';
}

/** The seat chosen on THIS device, before any table has a say. */
export function localRole() {
  const eph = ephemeralSeat();
  if (eph === 'dm' || eph === 'player') return roleMemory ?? eph;
  if (eph === 'ask') return roleMemory;
  try { return localStorage.getItem(ROLE_KEY); } catch { return null; }
}

export function setLocalRole(role) {
  if (ephemeralSeat()) { roleMemory = role; return; }
  try {
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch { /* private mode: the seat lasts as long as the tab */ }
}

/**
 * Who is the DM, as one pure rule.
 *
 * The table's seat always wins: joining somebody's game as a player makes you
 * a player there no matter what this device remembers. With no table, the
 * remembered local seat decides. This chooses which SCREENS exist - it is
 * navigation, not security. The server refuses a player's writes regardless
 * of what any browser believes about itself.
 */
export function resolveSeat({ tableOpen, tableRole, localRole: local }) {
  if (tableOpen) return tableRole === 'dm' ? 'dm' : 'player';
  return local === 'dm' ? 'dm' : 'player';
}

export function isDm() {
  return resolveSeat({
    tableOpen: isOpen(),
    tableRole: cached?.me?.role || null,
    localRole: localRole(),
  }) === 'dm';
}
export function isPlayer() { return !isDm(); }

/** No table, no chosen seat: the first-run welcome should ask. */
export function needsSeat() { return !isOpen() && !localRole(); }

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
