/**
 * The dice rail - everyone sees the nat 20 the moment it lands.
 *
 * Player d20 taps log a `roll` event; the rail is a read of the last few,
 * type-gated, on the player's Table and the DM's Stage. The payload is
 * allow-listed at the SOURCE (safeRollPayload), because the event stream is
 * shared with every seat: a roll says what die and what total, never
 * anything a screen was trusted to keep quiet.
 */

import { el, getState } from '../../core/store.js';
import { db } from '../../core/db.js';
import { colourOf, current } from '../../core/session.js';
import * as sfx from '../../core/sfx.js';

// The newest roll the rail has shown, so the next build can tell a fresh
// landing from a redraw. Module-level: the Stage and a sheet rail on one
// seat must echo one crit once, the same reason wasMyTurn lives in
// liveside.js rather than in each screen.
let topId = null;
let primed = false;

/** The only keys a roll event may carry. Everything else is dropped. */
export const SAFE_ROLL_KEYS = [
  'kind', 'label', 'faces', 'nat', 'total', 'advantage', 'disadvantage',
  'crit', 'fumble',
];

export function safeRollPayload(raw) {
  const out = {};
  for (const k of SAFE_ROLL_KEYS) if (k in (raw || {})) out[k] = raw[k];
  return out;
}

/**
 * Newest-first display rows from a raw event list. Pure.
 *
 * `since` is the moment THIS table opened. The log is append-only and
 * outlives any one session, so without a boundary the rail opens showing
 * the last session's dice - and, at a real table, rolls from characters
 * who no longer exist, attributed to "Someone". A table that just opened
 * has not rolled anything yet, and should say so.
 */
export function rollRows(events, characters = [], limit = 20, since = null) {
  const names = new Map((characters || []).map((c) => [c.id, c.name]));
  const from = since ? Date.parse(since) : null;
  return (events || [])
    .filter((e) => e.type === 'roll')
    .filter((e) => !from || Date.parse(e.ts) >= from)
    .slice(-limit)
    .reverse()
    .map((e) => ({
      id: e.id,
      characterId: e.characterId || null,
      who: names.get(e.characterId) || 'Someone',
      label: e.payload?.label || 'Roll',
      total: e.payload?.total,
      crit: !!e.payload?.crit,
      fumble: !!e.payload?.fumble,
      advantage: !!e.payload?.advantage,
      disadvantage: !!e.payload?.disadvantage,
    }));
}

/**
 * The rail panel. Fetches its own events and fills in when they arrive -
 * callers just mount it. Re-render on live changes is the caller's job
 * (both hosts already redraw on the `events` change kind).
 */
export function diceRail(characters = []) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Dice'));
  const list = el('div', { class: 'dice-rail', 'aria-label': 'Recent rolls' });
  panel.append(list);
  // Scoped to this table's own session - see rollRows().
  const since = current()?.createdAt || null;
  db.queryEvents({ limit: 400 }).then((events) => {
    const rows = rollRows(events, characters, 20, since);
    if (!rows.length) {
      list.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0' },
        'No rolls yet. The first d20 lands here.'));
      return;
    }
    // Did a roll just land? The rail is rebuilt on every events change, so
    // "new" is the top row's id changing since the last build. Somebody
    // ELSE's crit gets a quieter echo of the roller's sting - the roller
    // already heard the loud one from their own roll card.
    const fresh = primed && rows[0].id !== topId;
    if (fresh && rows[0].crit && rows[0].characterId !== getState().characterId) {
      sfx.play('crit', { gain: 0.5 });
    }
    topId = rows[0].id;
    primed = true;
    for (const r of rows) {
      const seat = colourOf(r.characterId);
      const row = el('div', {
        class: `dice-row${r.crit ? ' crit' : ''}${r.fumble ? ' fumble' : ''}`
          + (fresh && r.id === topId ? ' fresh' : ''),
        dataset: seat ? { colour: seat } : {},
        style: seat ? `border-left:3px solid ${seat};padding-left:7px` : '',
      });
      row.append(el('span', { class: 'dice-who' }, r.who));
      row.append(el('span', { class: 'dice-label' }, r.label));
      row.append(el('span', { class: 'dice-total mono' }, String(r.total)));
      if (r.crit) row.append(el('span', { class: 'dice-flag' }, 'crit!'));
      if (r.fumble) row.append(el('span', { class: 'dice-flag' }, 'fumble'));
      list.append(row);
    }
  }).catch(() => {
    list.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0' },
      'The dice feed is unavailable.'));
  });
  return panel;
}
