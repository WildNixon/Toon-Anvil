/**
 * The live table, as a set of panels either player screen can mount.
 *
 * The fight, the dice, and the state of the world used to live only on the
 * Party screen, while everything a player DOES lived on their sheet. So the
 * cause of a thing and its effect were never on screen together: you rolled
 * on one screen and went to another to find out what it did.
 *
 * These panels are the fight half, extracted so the sheet can carry them in
 * a rail beside the character. Extracted rather than copied, because two
 * renderers for one initiative order is exactly how two views end up
 * disagreeing about whose turn it is - the same reason the fight itself is
 * drawn by the DM's own runnerPanel in read-only mode.
 *
 * Nothing here writes. The server refuses a player's write to `encounters`
 * whatever a screen offers, and these panels do not offer it.
 */

import { getState, el, sign } from '../../core/store.js';
import { rollHistory, onRoll } from './rollcard.js';
import * as session from '../../core/session.js';
import * as sfx from '../../core/sfx.js';
import { runnerPanel, adopt, pull } from '../../modes/dm/runner.js';
import { diceRail } from './dicerail.js';
import { activeCampaign, currentRegion } from '../../core/campaign.js';
import { weatherFor } from '../../core/weather.js';
import { db, dataFile } from '../../core/db.js';

// One copy of the world, shared by every screen showing it. Two modules
// each holding their own would drift the moment one refreshed and the
// other did not.
let campaign = null;      // the REDACTED campaign - the server stripped it
let mapRecord = null;     // likewise: revealed pins only, no notes
let dmTables = null;
let record = null;        // the redacted encounter, kept for the turn nudge
let wasMyTurn = false;

/** The kinds a screen showing this must re-read on. */
export const LIVE_KINDS = ['encounters', 'table', 'characters', 'campaigns',
  'maps', 'events'];

export async function refreshLive() {
  record = await pull();
  // A cleared encounter comes back as null. Adopting an empty snapshot
  // rather than leaving the last one on screen is the honest answer: the
  // fight ended.
  adopt(record || { combatants: [], round: 0, turn: 0, started: false });

  campaign = await activeCampaign();
  if (!dmTables) dmTables = await dataFile('dm-tables.json', null);
  mapRecord = campaign?.mapId
    ? await db.get('maps', campaign.mapId).catch(() => null)
    : null;
}

export const liveCampaign = () => campaign;
export const liveMap = () => mapRecord;
/** The redacted encounter itself, for screens that need its combatants. */
export const liveRecord = () => record;
/** Is there a fight worth showing at all? */
export const fightIsOn = () => !!(record?.started
  || (record?.combatants || []).length);

/** Is the active combatant one of THIS seat's claimed characters? */
export function isMyTurn() {
  if (!record?.started || !Array.isArray(record.combatants)) return false;
  const current = record.combatants[record.turn || 0];
  const mine = session.ownedCharacterIds();
  return !!(current && mine && mine.has?.(current.characterId || current.id));
}

/**
 * The "your turn" banner, and the buzz that goes with it.
 *
 * The buzz fires on the TRANSITION into your turn, not on every redraw -
 * and `wasMyTurn` lives in this module rather than in each screen, so a
 * player with the sheet's rail open does not get buzzed twice for one turn
 * just because two panels drew it.
 */
export function turnBanner() {
  const mine = isMyTurn();
  if (mine && !wasMyTurn) {
    try { navigator.vibrate?.(160); } catch { /* not on this device */ }
    // The same edge, for ears and for laptops: a sting where sound is on,
    // and the tab title carries the cue until the next screen paints it.
    sfx.play('your-turn');
    try { document.title = '● Your turn · Toon Anvil'; } catch { /* fine */ }
  }
  wasMyTurn = mine;
  if (!mine) return null;
  return el('div', { class: 'your-turn', role: 'status' }, 'Your turn!');
}

export function fightPanel(redraw) {
  return runnerPanel({
    readOnly: true,
    mine: session.ownedCharacterIds(),
    redraw,
  });
}

export function dicePanel() {
  return diceRail(getState().characters || []);
}

/**
 * The day and the sky: in-world facts everyone at a real table feels, so
 * they are always shared. Computed client-side from the campaign's seed -
 * the same pure function the DM's Deck runs.
 */
export function worldStrip() {
  if (!campaign) return null;
  const region = currentRegion(campaign);
  const strip = el('div', { class: 'strip' });
  const factions = () => {
    for (const f of campaign.factions || []) {
      strip.append(el('span', {
        class: `chip ${f.standing > 2 ? 'ok' : f.standing < -2 ? 'bad' : ''}`,
        title: 'How they currently regard the party',
      }, `${f.name} ${f.standing >= 0 ? '+' : ''}${f.standing}`));
    }
  };
  if (!region) {
    // A campaign fresh off a book has a name and a day before it has any
    // region - the players should still see the world exists.
    strip.append(el('span', { class: 'grow' },
      `Day ${campaign.day} — ${campaign.name}`));
    factions();
    // It has clocks before it has regions too, and the pressure is world
    // state either way, so both branches show it.
    const early = clockStrip();
    if (early) strip.append(early);
    return strip;
  }
  const sky = weatherFor(dmTables,
    { seed: campaign.seed, day: campaign.day, region });
  strip.append(el('span', { class: 'grow' },
    `Day ${campaign.day} — ${region.name}`
    + (sky ? `: ${sky.summary.toLowerCase()}` : '')));
  if (sky?.event) {
    strip.append(el('span', { class: 'mono', style: 'font-size:11px' },
      sky.event));
  }
  factions();
  const clocks = clockStrip();
  if (clocks) strip.append(clocks);
  return strip;
}

/**
 * The pressure the DM has chosen to show. Read-only, and only ever the
 * public ones - the server stripped the rest before this client saw the
 * record, so there is nothing here to filter.
 */
export function clockStrip() {
  const shown = (campaign?.clocks || []).filter((c) => c.public);
  if (!shown.length) return null;
  const wrap = el('span', { class: 'clock-strip' });
  for (const c of shown) {
    wrap.append(el('span', { class: 'mono', style: 'font-size:11px' }, c.label));
    const segs = el('span', {
      class: 'clock-segs',
      'aria-label': `${c.label} — ${c.filled} of ${c.size} filled`,
    });
    for (let i = 0; i < c.size; i += 1) {
      segs.append(el('span', {
        class: `clock-seg${i < c.filled ? ' on' : ''}`, 'aria-hidden': 'true',
      }));
    }
    wrap.append(segs);
  }
  return wrap;
}

/**
 * The rail: the whole live table, folded, for the side of a sheet.
 *
 * Returns elements in DOM order. The CALLER must append them AFTER its own
 * content - the gym reads the first `main input[type=number]` as the damage
 * field and uses "Adjust HP" to know the sheet is loaded, so nothing may
 * come before the character. On a phone the fight belongs at the top when
 * it is your turn, and that reordering is done in CSS with `order`, never
 * by moving these ahead in the document.
 */
export function railPanels(redraw, { act = null } = {}) {
  const out = [];
  // The table panels exist only when there is a table. Solo play still gets
  // the rail for its own roll history: that panel needs no server, and the
  // commonest way this app is used should not be the one that loses the
  // feature. A fold labelled "The fight" with nothing behind it, though, is
  // worse than no fold - hence the gate here rather than empty furniture.
  const atTable = session.isOpen() && !session.isDm();
  if (atTable) {
    const banner = turnBanner();
    if (banner) out.push(banner);
    // The act bar goes directly under the banner and ABOVE the initiative
    // order: the banner says it is your turn, so the next thing on the
    // screen should be how to take it. Not folded - a turn you have to open
    // a disclosure to take is the friction this was built to remove.
    if (act && isMyTurn() && fightIsOn()) {
      const bar = act();
      if (bar) out.push(bar);
    }
    const world = worldStrip();
    if (world) out.push(fold('The world', world, false));
    if (fightIsOn()) {
      out.push(fold('The fight', fightPanel(redraw), true));
      out.push(fold('Dice', dicePanel(), true));
      const done = doneStrip(record?.round || 0);
      if (done) out.push(done);
    }
  }
  // Open when there is room. In a fight the rail already carries two open
  // folds and your card is on screen right now anyway; out of a fight the
  // rail is nearly empty and history is the thing you want, because "what
  // did I roll for that" gets asked about thirty seconds later - by which
  // time the card has gone.
  out.push(fold('Your rolls', myRollsPanel(), !(atTable && fightIsOn())));
  return out;
}

/**
 * This seat's own recent rolls, with what each total was made of.
 *
 * The dice rail beside it is the TABLE's rolls - everyone's, newest first,
 * totals only. This is yours, with the arithmetic, because the question it
 * answers is different: not "what did Kim get" but "wait, why was mine +7".
 *
 * It updates itself on a push rather than waiting for a redraw. A skill tap
 * does not redraw the sheet - nothing about the character changed - so a
 * panel that only repainted on draw() would show the roll before last.
 */
function myRollsPanel() {
  const box = el('div', { class: 'panel rivets' });
  const list = el('div', {});
  box.append(list);

  const paint = () => {
    list.innerHTML = '';
    const rolls = rollHistory().slice(-8).reverse();
    if (!rolls.length) {
      list.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0' },
        'Your rolls land here, with the sums.'));
      return;
    }
    for (const r of rolls) {
      const row = el('div', {
        class: `dice-row${r.crit ? ' crit' : ''}${r.fumble ? ' fumble' : ''}`,
      });
      row.append(el('span', { class: 'dice-who' }, r.label));
      row.append(el('span', { class: 'dice-label' },
        r.why || (r.mod ? sign(r.mod) : '')));
      row.append(el('span', { class: 'dice-total mono' }, String(r.total)));
      list.append(row);
    }
  };
  paint();

  // Self-cancelling: once this panel is off the page a redraw has replaced
  // it, and a listener held by a detached node is a leak with opinions.
  const off = onRoll(() => {
    if (!list.isConnected) { off(); return; }
    paint();
  });
  return box;
}

/**
 * Who has said they are done, this round.
 *
 * The other half of End turn. A player cannot advance the shared encounter -
 * the server refuses it and that stays - so "I'm done" is an event, and this
 * is the thing that makes the event worth logging. Without a screen showing
 * it, End turn would be a button that writes to a file nobody opens.
 *
 * Scoped to the CURRENT round on purpose. The event log is append-only and
 * outlives the session, so an unscoped read would show everyone as done
 * from the moment round two began - the same trap that had the dice rail
 * showing last session's dice.
 *
 * Mounted by both sides: the player rail, and the DM's Stage. The round is
 * an ARGUMENT rather than read from this module's `record`, because only the
 * player side populates that - the DM's Stage holds the authoritative fight
 * in runner.js. A shared component reading one side's private state is a
 * component that silently shows nothing on the other.
 */
export function doneStrip(round = 0) {
  if (!round) return null;
  const strip = el('div', { class: 'strip' });
  strip.append(el('span', { class: 'mono', style: 'font-size:11px' },
    `Round ${round}`));
  const list = el('span', { class: 'grow' });
  strip.append(list);

  // The timestamp field is `ts` - the same one rollRows() parses. Reading
  // `at` here would silently disable the session scope and let a previous
  // session's "done" marks through, which is the exact bug this scoping is
  // here to avoid.
  const from = session.current()?.createdAt
    ? Date.parse(session.current().createdAt) : null;
  db.queryEvents({ limit: 200 }).then((events) => {
    const seen = new Set();
    for (const e of events || []) {
      if (e.type !== 'turn_done') continue;
      if (from && Date.parse(e.ts) < from) continue;
      if ((e.payload?.round || 0) !== round) continue;
      const who = e.payload?.who;
      if (who) seen.add(who);
    }
    if (!seen.size) {
      list.append(el('span', { class: 'muted', style: 'font-size:11px' },
        'Nobody has called their turn yet.'));
      return;
    }
    for (const who of seen) {
      list.append(el('span', { class: 'chip ok', title: 'Said they are done' },
        `${who} ✓`));
    }
  }).catch(() => { /* the strip simply stays empty */ });
  return strip;
}

/** A rail section that remembers nothing and folds away when ignored. */
function fold(label, body, open) {
  const box = el('details', { class: 'rail-fold', open: open || null });
  box.append(el('summary', {}, label));
  box.append(body);
  return box;
}
