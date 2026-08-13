/**
 * Six seats, one at a time - which is also how a turn order works.
 *
 * Every frame of this app on this origin shares one localStorage token slot
 * (session.js), so a second live frame silently rewrites the first one's
 * seat. And a token must never ride in a URL, so there is no per-frame
 * override to reach for. Six simultaneous clients are therefore not
 * possible, and this drives them SEQUENTIALLY instead.
 *
 * That is not a workaround so much as the honest shape of the thing: at a
 * real table one person acts at a time, and the DM's screen is what everyone
 * looks at in between.
 *
 * The one trick worth knowing: the token goes into localStorage BEFORE the
 * iframe is created. Same origin, same store, so the app boots already
 * seated - one boot per seat instead of the load-then-set-then-reload dance
 * uiflows.js's runPlayerView has to do. That halves the boot count, which is
 * most of the wall clock in a cost run.
 *
 * Tokens live in memory here and are never written to disk or to a served
 * file. The bench is opened fresh each run.
 */

import { sleep, waitFor } from './uiflows.js';
import { stubDialogs, sweepFrames } from './probe.js';

const TOKEN_KEY = 'toonanvil.token';
const ROLE_KEY = 'toonanvil.role';

export class SeatDead extends Error {
  constructor(seatId, why) {
    super(`seat ${seatId} is not live: ${why}`);
    this.name = 'SeatDead';
    this.seatId = seatId;
  }
}

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Toon-Token': token } : {}),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * A table, five claimed characters, and a fight already running.
 *
 * The fight is not decoration. Most of the DM catalogue asks about one, and
 * a bench without it measures a screen no table would ever be looking at -
 * which is exactly how the initiative control came out wrong the first time
 * the Python tier ran.
 */
export async function openBench({ players = 5 } = {}) {
  await api('/api/table/close', { method: 'POST' }).catch(() => {});
  const opened = await api('/api/table/open', {
    method: 'POST', body: { name: 'Night DM' },
  });
  const dm = { id: 'dm', role: 'dm', name: 'Night DM', token: opened.token };
  const seats = [dm];

  const names = ['Kim', 'Ash', 'Rue', 'Tam', 'Vex'].slice(0, players);
  for (let i = 0; i < names.length; i += 1) {
    const characterId = `night-pc-${i + 1}`;
    await api(`/api/characters/${characterId}`, {
      method: 'PUT', token: dm.token,
      body: {
        id: characterId, name: names[i],
        classes: [{ class: 'fighter', subclass: null, level: 5 }],
        abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
        inventory: [], spells: [], conditions: [],
      },
    });
    const joined = await api('/api/table/join', {
      method: 'POST', body: { code: opened.code, name: names[i] },
    });
    await api('/api/table/claim', {
      method: 'POST', token: joined.token, body: { characterId },
    });
    seats.push({
      id: `p${i + 1}`, role: 'player', name: names[i],
      token: joined.token, characterId,
    });
  }

  // The DM says go. Without this, the lobby latch (which postdates this
  // bench) parks every seat in the queue at boot - and the liveness gate
  // then reports a whole cycle of honest-looking SeatDead. A bench is a
  // table mid-session, so it starts like one.
  await api('/api/table/start', {
    method: 'POST', token: dm.token, body: { started: true },
  });

  const combatants = seats.slice(1).map((s, i) => ({
    id: `c${i + 1}`, characterId: s.characterId, name: s.name,
    init: 20 - i, hp: 38 - i * 3, maxHp: 38, side: 'ally', conditions: [],
  }));
  combatants.push({
    id: 'm1', name: 'Gym Ogre', init: 11,
    hp: 13, maxHp: 59, side: 'enemy', conditions: [],
  });
  await api('/api/encounters/current', {
    method: 'PUT', token: dm.token,
    body: {
      id: 'current', started: true, round: 3, turn: 0,
      showMonsterHp: false, combatants,
    },
  });

  return {
    code: opened.code,
    seats,
    seat: (id) => seats.find((s) => s.id === id),
    close: () => api('/api/table/close', { method: 'POST' }).catch(() => {}),
  };
}

function mkFrame(width, height) {
  const f = document.createElement('iframe');
  f.src = '/index.html';
  f.dataset.seatFrame = '1';
  f.style.cssText = 'position:fixed;left:-10000px;top:0;border:0;'
    + `width:${width}px;height:${height}px`;
  document.body.append(f);
  return f;
}

/**
 * Is this seat actually seated, and is the screen it wants actually there?
 *
 * The most dangerous failure in a run like this is quiet: if the table dies,
 * every seat boots to the join gate and every question scores zero, drawing
 * a beautiful and completely false cliff. So a dead seat throws and the
 * caller EXCLUDES the cycle rather than recording a pile of honest-looking
 * zeroes.
 */
async function assertSeatLive(seat, doc) {
  const table = await api('/api/table', { token: seat.token });
  if (!table?.open) throw new SeatDead(seat.id, 'the table is not open');
  if (!table.me) throw new SeatDead(seat.id, 'this token has no seat');
  const ready = await waitFor(() => {
    const main = doc.querySelector('main');
    if (!main) return null;
    const t = main.textContent || '';
    if (/could not start/i.test(t)) return 'boot-failure';
    if (doc.querySelector('.welcome')) return 'gate';
    return seat.role === 'dm'
      ? (/Encounter|At the table|round/i.test(t) ? true : null)
      : (/Abilities|Adjust HP/i.test(t) ? true : null);
  }, { timeout: 20000 });
  if (ready === 'boot-failure') throw new SeatDead(seat.id, 'the app failed to boot');
  if (ready === 'gate') throw new SeatDead(seat.id, 'it was offered the join gate');
  if (!ready) throw new SeatDead(seat.id, 'its screen never became ready');
  return true;
}

/**
 * Run `fn` inside one seat's frame, and always give the token back.
 *
 * The finally is not politeness. This page shares its localStorage with the
 * app, so leaving a player token behind would silently reseat the operator's
 * own browser as somebody else.
 */
export async function withSeat(bench, seatId, fn, { width = 390, height = 844 } = {}) {
  const seat = bench.seat(seatId);
  if (!seat) throw new Error(`no seat ${seatId}`);
  const keepToken = localStorage.getItem(TOKEN_KEY);
  const keepRole = localStorage.getItem(ROLE_KEY);
  let frame = null;
  try {
    // BEFORE the frame exists: same origin, same store, so it boots seated.
    localStorage.setItem(TOKEN_KEY, seat.token);
    localStorage.setItem(ROLE_KEY, seat.role === 'dm' ? 'dm' : 'player');
    frame = mkFrame(width, height);
    await new Promise((r) => { frame.onload = r; setTimeout(r, 20000); });
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    stubDialogs(win);
    await assertSeatLive(seat, doc);
    return await fn({ doc, win, frame, seat });
  } finally {
    frame?.remove();
    if (keepToken === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, keepToken);
    if (keepRole === null) localStorage.removeItem(ROLE_KEY);
    else localStorage.setItem(ROLE_KEY, keepRole);
  }
}

/** Two identical consecutive readings, because modes render in stages. */
export function settler(doc, { quiet = 200, timeout = 6000 } = {}) {
  return async () => {
    const read = () => (doc.querySelector('main')?.textContent || '').length;
    const deadline = Date.now() + timeout;
    let last = -1;
    while (Date.now() < deadline) {
      const now = read();
      if (now === last && now > 0) return true;
      last = now;
      await sleep(quiet);
    }
    return false;
  };
}

/** Frames a previous cycle failed to remove. A leak, counted not ignored. */
export function sweep() {
  return sweepFrames(document);
}

/** The campaign size this measurement belongs to, read rather than assumed. */
export async function currentSize(token) {
  const camps = await api('/api/campaigns', { token }).catch(() => []);
  const active = (Array.isArray(camps) ? camps : []).find((c) => c.active)
    || (Array.isArray(camps) ? camps : [])[0] || {};
  const map = active.mapId
    ? await api(`/api/maps/${active.mapId}`, { token }).catch(() => null) : null;
  return {
    day: active.day ?? null,
    factions: (active.factions || []).length,
    clocks: (active.clocks || []).length,
    regions: (active.regions || []).length,
    loreEntries: (active.lore || []).length,
    pins: ((map || {}).pins || []).length,
    campaigns: Array.isArray(camps) ? camps.length : 0,
    campaignBytes: JSON.stringify(active).length,
  };
}
