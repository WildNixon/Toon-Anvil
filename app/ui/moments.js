/**
 * MOMENTS - the layer where a thing that just happened is marked.
 *
 * The app records a great deal and celebrated almost none of it: damage
 * changed a number, going down swapped a panel, a natural twenty on a death
 * save quietly set HP to 1. The one ceremony - the level-up card - was a
 * one-off wired into app.js. This module is the reusable version: a pure
 * table from event to moment, one subscriber on the events bus, and one
 * layer to draw into.
 *
 * Two rules, both enforced by where things live:
 *
 *   - The layer (#moments) is a SIBLING of <main> and of #rollcards. The
 *     gym settles on main's text and reads the first .rollcard it finds;
 *     nothing here may change either. A moment is never text inside main
 *     and never a child of the roll stack.
 *   - Moments never use the toast. #toast is one element on one timer, and
 *     four flows assert its text; a celebration that stole it would silence
 *     a "table was closed" somebody needed to read.
 *
 * Stings ride along through sfx.play(), which refuses in words when sound
 * is off - so the VISUAL half of every moment shows for everyone and the
 * audible half only where this device asked for it.
 */

import { el, getState } from '../core/store.js';
import { subscribe as onEvent } from '../core/events.js';
import * as sfx from '../core/sfx.js';

/**
 * Event -> moment. Pure, and total over the events it knows: anything else
 * is null. `sting` is the sound; `title` means a card is shown for `ms`.
 *
 * The roll's own crit/fumble flags decide the dice sound. The engine also
 * logs separate crit/fumble events for attacks, which would make an attack
 * crit ring twice - so those types are deliberately silent here.
 */
export function momentFor(ev) {
  const type = ev?.type;
  const p = ev?.payload || {};
  switch (type) {
    case 'roll':
      return { kind: 'roll', sting: p.crit ? 'crit' : p.fumble ? 'fumble' : 'dice' };
    case 'damage_taken':
      return { kind: 'hit', sting: 'hit' };
    case 'healed':
      return { kind: 'heal', sting: 'heal' };
    case 'downed':
      return { kind: 'downed', sting: 'downed', ms: 2600,
        title: 'Down.', line: 'Zero hit points. Death saves from here.' };
    case 'death_save':
      return Number(p.roll) === 20
        ? { kind: 'revive', sting: 'revive', ms: 2500,
          title: 'Back on your feet', line: 'A natural twenty. One hit point, and the slate wiped.' }
        : { kind: 'death-tick', sting: 'death-tick' };
    case 'spell_cast':
      return { kind: 'cast', sting: 'spell-cast' };
    case 'level_up':
      return { kind: 'level', sting: 'level-up' };
    case 'rest_long':
      return { kind: 'rest', sting: 'rest-long', ms: 3000,
        title: 'A long rest.', line: 'A new day. Spent and wounded things come back.' };
    default:
      return null;
  }
}

/** The event types momentFor answers for - asserted against the taxonomy. */
export const MOMENT_EVENTS = ['roll', 'damage_taken', 'healed', 'downed',
  'death_save', 'spell_cast', 'level_up', 'rest_long'];

/**
 * Moments that are not events but edges - the table starting, a round
 * turning - named here so the seats that derive them fire the same card.
 */
export const SESSION_MOMENT = {
  kind: 'session', ms: 3000,
  title: 'The session begins', line: 'Everyone to their screens.',
};
export const roundMoment = (n) => ({
  kind: 'round', ms: 1400, title: `Round ${n}`,
});
// The DM's own screen only: the label is the spoiler the log never carries.
export const strikeMoment = (label) => ({
  kind: 'strike', ms: 3000, title: label, line: 'The clock strikes.',
});

let host = null;

function layer() {
  if (host && host.isConnected) return host;
  host = document.getElementById('moments');
  if (!host) {
    host = el('div', { id: 'moments', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/**
 * Show a moment with a title. Tap dismisses; it leaves on its own after ms.
 * Returns the element, so a caller can hold it if it wants to.
 */
export function show(moment) {
  if (!moment || !moment.title) return null;
  const box = layer();
  const wrap = el('div', { class: `moment moment-${moment.kind}`, role: 'status' });
  const card = el('div', { class: 'moment-card', onClick: () => wrap.remove() });
  card.append(el('div', { class: 'moment-title' }, moment.title));
  if (moment.line) card.append(el('div', { class: 'moment-line' }, moment.line));
  wrap.append(card);
  box.append(wrap);
  setTimeout(() => wrap.remove(), moment.ms || 2400);
  return wrap;
}

/**
 * The level-up card, moved here from app.js unchanged in shape: the gym
 * finds .levelup-overlay document-wide and expects it gone within ten
 * seconds, and its backdrop passes every click through so a celebration
 * can never block play.
 */
function levelUp(ev) {
  document.querySelector('.levelup-overlay')?.remove();
  const wrap = el('div', { class: 'levelup-overlay', role: 'status' });
  const card = el('div', { class: 'levelup-card', onClick: () => wrap.remove() });
  card.append(el('div', { class: 'lu-burst' },
    `Level ${ev.payload?.level ?? '?'}!`));
  const gained = (getState().derived?.features || [])
    .filter((f) => Number(f.level) === Number(ev.payload?.level))
    .map((f) => f.name).filter(Boolean).slice(0, 6);
  if (gained.length) {
    // Each feature rises on its own beat. The joined text reads exactly as
    // it did - "A · B · C" - so anything reading the card sees no change.
    const list = el('div', { class: 'lu-features' });
    gained.forEach((name, i) => {
      if (i) list.append(document.createTextNode(' · '));
      list.append(el('span', { class: 'lu-feature', style: `--i:${i}` }, name));
    });
    card.append(list);
  }
  card.append(el('div', { class: 'welcome-fine' }, 'tap to dismiss'));
  wrap.append(card);
  layer().append(wrap);
  setTimeout(() => wrap.remove(), 7000);
}

/** One subscriber for every moment. Called once from boot. */
export function install() {
  onEvent((ev) => {
    const m = momentFor(ev);
    if (!m) return;
    if (m.sting) sfx.play(m.sting);
    if (ev.type === 'level_up') levelUp(ev);
    else if (m.title) show(m);
  });
}
