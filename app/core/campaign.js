/**
 * The campaign record - the world the Deck drives.
 *
 * One record holds the in-game day, the seed the sky is computed from, the
 * regions with their price dials, the factions with their standings and
 * SECRET agendas, and where the party currently stands. The DM writes it
 * (campaigns is a shared kind - the server refuses players), everyone reads
 * it, and the server strips the secrets from what players receive.
 *
 * `active` lives ON the record, not in localStorage: the players' screens on
 * other machines must find the campaign the DM means.
 */

import { db } from './db.js';

/** The Deck's last-viewed campaign on THIS browser (a hint, not authority). */
export const CAMPAIGN_KEY = 'toonanvil.campaign';

export async function listCampaigns() {
  try { return await db.list('campaigns'); } catch { return []; }
}

/** The campaign the table is playing: active flag first, pointer second. */
export async function activeCampaign() {
  const all = await listCampaigns();
  if (!all.length) return null;
  const flagged = all.find((c) => c.active);
  if (flagged) return flagged;
  try {
    const pointed = all.find((c) => c.id === localStorage.getItem(CAMPAIGN_KEY));
    if (pointed) return pointed;
  } catch { /* private mode */ }
  return all[0];
}

export async function saveCampaign(c) {
  await db.put('campaigns', c);
  return c;
}

/** DM only in effect: flips `active` onto one record, off the rest. */
export async function setActive(id) {
  const all = await listCampaigns();
  for (const c of all) {
    const should = c.id === id;
    if (Boolean(c.active) !== should) {
      // eslint-disable-next-line no-await-in-loop
      await db.put('campaigns', { ...c, active: should });
    }
  }
  try { localStorage.setItem(CAMPAIGN_KEY, id); } catch { /* fine */ }
}

export function newCampaign(name) {
  const seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0);
  return {
    id: `camp-${name.toLowerCase().replace(/\W+/g, '-').slice(0, 24)}-${
      Date.now().toString(36).slice(-4)}`,
    name,
    active: false,
    day: 1,
    // The seed every day's weather is computed from. Public on purpose:
    // players compute the sky client-side, and the only thing this number
    // predicts is the weather.
    seed,
    currentRegionId: null,
    regions: [],
    factions: [],
    mapId: null,
    lore: [],
    createdAt: new Date().toISOString(),
  };
}

export function currentRegion(c) {
  if (!c) return null;
  return (c.regions || []).find((r) => r.id === c.currentRegionId)
    || (c.regions || [])[0] || null;
}

const clampMod = (m) => Math.min(2, Math.max(0.5, Number(m) || 1));

/** The price multiplier where the party stands. 1 with no campaign. */
export function priceModFor(c) {
  const region = currentRegion(c);
  return region ? clampMod(region.priceMod) : 1;
}

export function newRegion(name, terrain = 'forest') {
  return {
    id: `reg-${name.toLowerCase().replace(/\W+/g, '-').slice(0, 20)}-${
      Math.random().toString(36).slice(2, 5)}`,
    name, terrain, priceMod: 1.0, note: '',
  };
}

/**
 * Stamp the campaign's in-world day onto an event payload, pure and
 * non-mutating. Wealth events (purchase, sale, gold_change) were once
 * logged without a day or a campaign, which quietly reduced the Deck's
 * "coin spent, by day" chart to a single bucket at day zero.
 */
export function stampDay(payload, campaign) {
  return campaign ? { ...payload, day: campaign.day } : payload;
}

/* ------------------------------------------------------------------ */
/* clocks - pressure that advances with the day                        */
/* ------------------------------------------------------------------ */

/**
 * A clock is a promise with a countdown: the ritual completes, the siege
 * lands, the rumour reaches the wrong ear. Segments fill; when the last
 * one does, something happens in the world.
 *
 * `public` decides whether the players see it at all - the redactor strips
 * the rest server-side, so a secret clock is not merely undrawn.
 * `advanceOnDay` ties it to the calendar; a clock without it moves only
 * when the DM taps it.
 */
export function newClock(label, size = 6) {
  return {
    id: `clk-${String(label).toLowerCase().replace(/\W+/g, '-').slice(0, 20)}-${
      Date.now().toString(36).slice(-4)}`,
    label: String(label || 'Pressure').slice(0, 60),
    size: Math.max(2, Math.min(12, Math.floor(size) || 6)),
    filled: 0,
    public: false,
    advanceOnDay: false,
    factionId: null,
  };
}

/** Fill (or empty, with a negative n) segments. Pure; clamped to 0..size. */
export function tickClock(clock, n = 1) {
  const size = Math.max(1, Math.floor(Number(clock.size) || 6));
  const now = Math.floor(Number(clock.filled) || 0) + Math.floor(n);
  return { ...clock, size, filled: Math.min(size, Math.max(0, now)) };
}

/**
 * Advance every clock tied to the calendar by one segment.
 *
 * Returns the new list AND the clocks that STRUCK on this tick - a clock
 * reaching its last segment is a story beat, so the caller logs those
 * rather than the arithmetic. A clock already full does not strike twice.
 */
export function advanceDayClocks(clocks = []) {
  const out = [];
  const struck = [];
  for (const c of clocks) {
    if (!c?.advanceOnDay) { out.push(c); continue; }
    const before = tickClock(c, 0);
    const after = tickClock(c, 1);
    out.push(after);
    if (after.filled >= after.size && before.filled < before.size) {
      struck.push(after);
    }
  }
  return { clocks: out, struck };
}

const FACTION_COLOURS = ['#8e2a1c', '#2f5d50', '#8a6a24', '#2e4a6b',
  '#6b2e5f', '#5c5c34'];

export function newFaction(name, index = 0) {
  return {
    id: `fac-${name.toLowerCase().replace(/\W+/g, '-').slice(0, 20)}-${
      Math.random().toString(36).slice(2, 5)}`,
    name,
    standing: 0,
    // The one SECRET field: stripped by the server for players.
    agenda: '',
    public: false,
    colour: FACTION_COLOURS[index % FACTION_COLOURS.length],
  };
}
