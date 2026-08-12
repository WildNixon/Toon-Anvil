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

/**
 * One call to the table API, which NEVER throws on a dead server.
 *
 * It used to let a network failure reject, and every caller awaited it
 * without a catch - so with the server stopped, pressing a button did
 * absolutely nothing: no error, no toast, no change, and any `busy` flag the
 * caller had set stayed set, which quietly bricked every later press too.
 * A screen that says everything is fine is the worst shape a failure takes.
 *
 * A refusal (403, 409) is a fact about who you are and comes back as one.
 * A transport failure is a fact about the SERVER, and comes back saying so.
 */
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${serverBase()}${path}`, {
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      ...opts,
    });
  } catch {
    return {
      status: 0,
      offline: true,
      error: 'The server is not answering. It may have stopped - restart it '
        + 'with "python run.py".',
    };
  }
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
  // Default HERO seat: the sandbox opens as the player app, and the seat
  // plaque is one click from the DM shell. (It used to default to DM, but
  // under pure shells that would boot a sandbox with no Build - and both
  // the person and the test harness reach for Build first.)
  // ?seat=dm boots the DM shell; ?seat=ask shows the first-run welcome.
  return p.get('seat') || 'player';
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

/* ------------------------------------------------------------------ */
/* the forge and the grants                                            */
/* ------------------------------------------------------------------ */

/** Is character building open? Meaningless (false) with no table. */
export function forgeOpen() { return Boolean(cached?.forgeOpen); }

/** Grants visible to THIS browser - the server already scoped them. */
export function grants() { return cached?.grants || {}; }

/** The level this character may reach, or null. */
export function myGrant(characterId) {
  const g = grants()[characterId];
  return g === undefined ? null : g;
}

/** Does any character this profile owns hold a grant? Drives the nav. */
export function hasAnyGrant() {
  const ids = cached?.me?.characterIds || [];
  return ids.some((id) => id in grants());
}

/** DM only - the server refuses anyone else. */
export async function setForge(open) {
  const out = await api('/api/table/forge', {
    method: 'POST', body: JSON.stringify({ open }),
  });
  await refresh();
  return out;
}

/** DM only. characterId 'party' grants every player's character at once. */
export async function grant({ characterId, toLevel = null, revoke = false }) {
  const out = await api('/api/table/grant', {
    method: 'POST', body: JSON.stringify({ characterId, toLevel, revoke }),
  });
  await refresh();
  return out;
}

/**
 * Which modes exist for whom - one pure rule, testable as a table.
 *
 * Two shells. The seat picks one, whole: the DM's app is the captain's
 * screens (Stage, Deck, World, Story, Setup) and nothing else; the player's
 * app is about what they control - Build only while the forge is open or a
 * grant is waiting, the solo Combat tracker never while a table runs the
 * real fight. Settings' gear serves both. The seat plaque in the top bar is
 * the switch (solo) and the lock (at a table).
 *
 * Navigation, not security: the server refuses what it refuses regardless.
 */
export function navFor({ tableOpen, seat, forgeOpen: forge, hasGrant }, modes) {
  const shell = seat === 'dm' ? 'dm' : 'player';
  return modes.filter((m) => {
    if (m.gear) return true;                       // Settings serves both shells
    // The lobby is the one screen both seats share: hosting and joining are
    // the same room from two sides, and hiding it from the DM shell would
    // mean the person running the game cannot see who has turned up.
    if (m.always) return true;
    // THE hard split: a mode belongs to one shell, and the seat picks the
    // shell. The DM's app is the same solo and at a table - that is the
    // whole point of it being an app rather than a tab.
    if ((m.shell || 'player') !== shell) return false;
    if (m.tableOnly && !tableOpen) return false;
    if (m.soloOnly && tableOpen) return false;
    if (m.id === 'build' && tableOpen && !forge && !hasGrant) return false;
    return true;
  });
}

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

/**
 * The seat colour behind a character, or null. One lookup for every
 * surface that tints by owner - rail rows, runner rows, party vitals,
 * roll cards - so they cannot drift apart on what "whose" means.
 */
export function colourOf(characterId) {
  if (!characterId) return null;
  for (const p of cached?.profiles || []) {
    if ((p.characterIds || []).includes(characterId)) return p.colour || null;
  }
  return null;
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

/**
 * Begin the session, or send everyone back to the lobby.
 *
 * Separate from opening: a table can be open for ten minutes while people
 * pick characters. Starting is the moment the DM says go, and every seat is
 * watching this one flag so five phones leave the queue together instead of
 * being told to navigate one at a time.
 */
export async function setStarted(started = true) {
  const out = await api('/api/table/start', {
    method: 'POST', body: JSON.stringify({ started }),
  });
  await refresh();
  return out;
}

export function started() { return Boolean(cached?.started); }

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
