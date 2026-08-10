/**
 * The event log - the spine of the app.
 *
 * Every mode is a producer or a consumer of this one append-only stream.
 * Combat writes `crit` and `kill`; Shop writes `purchase`; RP writes
 * `promise_made`. The Chronicle is not a diary the player remembers to fill
 * in, it is a *view* over what the other modes already recorded.
 *
 * That inversion is what makes the DM export worth reading: because promises,
 * secrets and NPC meetings are typed events rather than free text, the export
 * can compute OPEN THREADS - the promise with no matching `promise_kept`, the
 * NPC met once and never revisited - which is exactly the hook list a DM wants.
 *
 * Events are immutable. Corrections are new events, never edits.
 */

import { db } from './db.js';

/* ------------------------------------------------------------------ */
/* taxonomy                                                            */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = {
  // --- session / progression
  session_start:      { cat: 'session',     label: 'Session began' },
  session_end:        { cat: 'session',     label: 'Session ended' },
  level_up:           { cat: 'progression', label: 'Levelled up' },
  feature_gained:     { cat: 'progression', label: 'Gained a feature' },
  rest_short:         { cat: 'progression', label: 'Short rest' },
  rest_long:          { cat: 'progression', label: 'Long rest' },
  inspiration_gained: { cat: 'progression', label: 'Gained Heroic Inspiration' },
  inspiration_spent:  { cat: 'progression', label: 'Spent Heroic Inspiration' },

  // --- combat
  encounter_start:    { cat: 'combat', label: 'Encounter began' },
  encounter_end:      { cat: 'combat', label: 'Encounter ended' },
  initiative:         { cat: 'combat', label: 'Rolled initiative' },
  // Deliberately NOT notable: twenty of these land per session, and the
  // Chronicle's job is the story, not the arithmetic. The dice rail is the
  // reader of this type.
  roll:               { cat: 'combat', label: 'Rolled the dice' },
  attack:             { cat: 'combat', label: 'Attacked' },
  crit:               { cat: 'combat', label: 'Critical hit', notable: true },
  fumble:             { cat: 'combat', label: 'Natural 1' },
  damage_dealt:       { cat: 'combat', label: 'Dealt damage' },
  damage_taken:       { cat: 'combat', label: 'Took damage' },
  healed:             { cat: 'combat', label: 'Healed' },
  kill:               { cat: 'combat', label: 'Defeated a foe', notable: true },
  downed:             { cat: 'combat', label: 'Dropped to 0 HP', notable: true },
  death_save:         { cat: 'combat', label: 'Death saving throw', notable: true },
  spell_cast:         { cat: 'combat', label: 'Cast a spell' },
  resource_spent:     { cat: 'combat', label: 'Spent a resource' },
  condition_gained:   { cat: 'combat', label: 'Gained a condition' },
  condition_cleared:  { cat: 'combat', label: 'Lost a condition' },
  concentration_broken: { cat: 'combat', label: 'Lost concentration' },
  homebrew_trigger:   { cat: 'combat', label: 'Homebrew feature fired', notable: true },

  // --- shop / wealth
  purchase:           { cat: 'shop', label: 'Bought something' },
  sale:               { cat: 'shop', label: 'Sold something' },
  haggle:             { cat: 'shop', label: 'Haggled' },
  gold_change:        { cat: 'shop', label: 'Wealth changed' },
  item_gained:        { cat: 'shop', label: 'Gained an item' },
  item_lost:          { cat: 'shop', label: 'Lost an item' },
  attuned:            { cat: 'shop', label: 'Attuned to an item' },

  // --- roleplay  (the thread-bearing types)
  npc_met:            { cat: 'rp', label: 'Met someone', thread: 'npc', notable: true },
  npc_relationship:   { cat: 'rp', label: 'Relationship shifted', thread: 'npc' },
  dialogue_beat:      { cat: 'rp', label: 'Conversation' },
  choice_made:        { cat: 'rp', label: 'Made a choice', notable: true },
  promise_made:       { cat: 'rp', label: 'Made a promise', thread: 'open', notable: true },
  promise_kept:       { cat: 'rp', label: 'Kept a promise', thread: 'close', notable: true },
  promise_broken:     { cat: 'rp', label: 'Broke a promise', thread: 'close', notable: true },
  secret_learned:     { cat: 'rp', label: 'Learned a secret', thread: 'open', notable: true },
  secret_used:        { cat: 'rp', label: 'Used a secret', thread: 'close' },
  quest_step:         { cat: 'rp', label: 'Quest progressed' },
  quest_complete:     { cat: 'rp', label: 'Quest completed', thread: 'close' },
  location_visited:   { cat: 'rp', label: 'Visited somewhere' },

  // --- manual
  journal:            { cat: 'journal', label: 'Journal entry' },

  // --- the world (campaign state the DM drives from the Deck)
  day_advanced:       { cat: 'world', label: 'A day passed', notable: true },
  // Notable because the app only logs a clock STRIKING, never every
  // segment - the Chronicle wants the moment the ritual completes, not
  // the arithmetic that got there.
  clock_advanced:     { cat: 'world', label: 'A clock struck', notable: true },
  faction_standing:   { cat: 'world', label: 'Faction standing shifted' },
  region_moved:       { cat: 'world', label: 'The party moved', notable: true },
  campaign_founded:   { cat: 'world', label: 'A campaign began', notable: true },
  section_filed:      { cat: 'world', label: 'Filed from a book' },
  price_changed:      { cat: 'world', label: 'Prices turned' },
};

export const CATEGORIES = {
  session: 'Session', progression: 'Progression', combat: 'Combat',
  shop: 'Wealth', rp: 'Roleplay', journal: 'Journal', world: 'The World',
};

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

const subscribers = new Set();
let context = { characterId: null, campaignId: null, sessionId: null };

/** Set the ambient character/campaign/session stamped onto later events. */
export function setContext(patch) {
  context = { ...context, ...patch };
  return context;
}
export function getContext() { return { ...context }; }

// A monotonic counter rather than Date.now()+Math.random(). Event ids have to
// be reproducible or a simulated campaign cannot be hashed and compared across
// runs - which is the whole basis of the tuning loop.
let seq = 0;
let idPrefix = 'e';

function uid() {
  seq += 1;
  return `${idPrefix}${seq.toString(36)}`;
}

/**
 * Reset the id counter. The emulator calls this between campaigns so run N is
 * byte-identical to run N regardless of what ran before it.
 */
export function resetIds(prefix = 'e') {
  seq = 0;
  idPrefix = prefix;
}

/** Deterministic clock for simulated runs; null restores wall-clock time. */
let clock = null;
export function setClock(fn) { clock = fn; }
const now = () => (clock ? clock() : new Date().toISOString());

/**
 * Append one event.
 *
 * @param {string} type  a key of EVENT_TYPES
 * @param {object} payload  type-specific detail
 * @param {object} [opts]  {summary, tags, characterId, campaignId, actor}
 */
export async function log(type, payload = {}, opts = {}) {
  if (!EVENT_TYPES[type]) {
    console.warn(`[events] unknown type "${type}" - add it to EVENT_TYPES`);
  }
  const ev = {
    id: uid(),
    ts: now(),
    type,
    cat: EVENT_TYPES[type]?.cat || 'journal',
    characterId: opts.characterId ?? context.characterId,
    campaignId: opts.campaignId ?? context.campaignId,
    sessionId: opts.sessionId ?? context.sessionId,
    actor: opts.actor || null,
    summary: opts.summary || describe(type, payload),
    tags: opts.tags || [],
    payload,
  };
  await db.appendEvents([ev]);
  for (const fn of subscribers) {
    try { fn(ev); } catch (err) { console.error('[events] subscriber threw', err); }
  }
  return ev;
}

/** Subscribe to newly logged events. Returns an unsubscribe function. */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** A short human sentence for an event, used when no summary is supplied. */
export function describe(type, p = {}) {
  switch (type) {
    case 'day_advanced':     return `Day ${p.day} dawns`;
    case 'faction_standing': return `${p.name || 'A faction'}: standing ${p.value}`;
    case 'region_moved':     return `The party crossed into ${p.regionName || 'a new region'}`;
    case 'campaign_founded': return `${p.name || 'A campaign'} begins${p.source ? `, from ${p.source}` : ''}`;
    case 'section_filed':    return `${p.title || 'A section'} filed as ${p.as}`;
    case 'price_changed':    return `${p.name || 'A region'}: prices x${p.value}`;
    case 'attack':      return `Attacked ${p.target || 'a target'}${p.hit === false ? ' and missed' : ''}`;
    case 'crit':        return `Critical hit on ${p.target || 'a target'}`;
    case 'fumble':      return `Rolled a natural 1${p.on ? ` on ${p.on}` : ''}`;
    case 'kill':        return `Defeated ${p.target || 'a foe'}`;
    case 'damage_dealt':return `Dealt ${p.amount} ${p.damageType || ''} damage to ${p.target || 'a foe'}`.replace(/\s+/g, ' ');
    case 'damage_taken':return `Took ${p.amount} ${p.damageType || ''} damage${p.from ? ` from ${p.from}` : ''}`.replace(/\s+/g, ' ');
    case 'healed':      return `Healed ${p.amount}`;
    // p.spell missing = a bare slot tile spend; "Cast undefined" once
    // reached the Chronicle verbatim.
    case 'spell_cast':  return `Cast ${p.spell || 'a spell'}${p.level ? ` at level ${p.level}` : ''}`;
    case 'resource_spent': return `Spent ${p.amount} ${p.resource}`;
    case 'death_save':  return `Death save: ${p.result}`;
    case 'downed':      return 'Dropped to 0 hit points';
    case 'level_up':    return `Reached level ${p.level}${p.class ? ` (${p.class})` : ''}`;
    case 'purchase':    return `Bought ${p.item}${p.price ? ` for ${p.price}` : ''}`;
    case 'sale':        return `Sold ${p.item}${p.price ? ` for ${p.price}` : ''}`;
    case 'haggle':      return `Haggled with ${p.vendor || 'a merchant'}`;
    case 'npc_met':     return `Met ${p.name}${p.where ? ` in ${p.where}` : ''}`;
    case 'promise_made':return `Promised ${p.to || 'someone'}: ${p.what}`;
    case 'promise_kept':return `Kept a promise to ${p.to || 'someone'}`;
    case 'promise_broken': return `Broke a promise to ${p.to || 'someone'}`;
    case 'secret_learned': return `Learned: ${p.what}`;
    case 'choice_made': return p.what || 'Made a choice';
    case 'location_visited': return `Visited ${p.name}`;
    case 'quest_step':  return `${p.quest}: ${p.step}`;
    case 'homebrew_trigger': return `${p.feature} triggered${p.result ? ` - ${p.result}` : ''}`;
    case 'rest_short':  return 'Took a short rest';
    case 'rest_long':   return 'Took a long rest';
    case 'journal':     return p.text ? String(p.text).slice(0, 120) : 'Journal entry';
    default:            return EVENT_TYPES[type]?.label || type;
  }
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

export async function query(filter = {}) {
  const events = await db.queryEvents(filter);
  let out = events;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    out = out.filter((e) => types.includes(e.type));
  }
  if (filter.cat) {
    const cats = Array.isArray(filter.cat) ? filter.cat : [filter.cat];
    out = out.filter((e) => cats.includes(e.cat));
  }
  if (filter.sessionId) out = out.filter((e) => e.sessionId === filter.sessionId);
  if (filter.since) out = out.filter((e) => e.ts >= filter.since);
  if (filter.notableOnly) out = out.filter((e) => EVENT_TYPES[e.type]?.notable);
  return out;
}

/** Group a flat event list into sessions, newest last. */
export function bySession(events) {
  const sessions = new Map();
  for (const ev of events) {
    const key = ev.sessionId || 'unsessioned';
    if (!sessions.has(key)) sessions.set(key, { id: key, events: [], start: ev.ts });
    const s = sessions.get(key);
    s.events.push(ev);
    s.end = ev.ts;
  }
  return [...sessions.values()];
}

/* ------------------------------------------------------------------ */
/* open threads - the reason the log is typed                          */
/* ------------------------------------------------------------------ */

/**
 * Derive unresolved narrative hooks from the stream.
 *
 * A thread is opened by an event (a promise, a secret) and closed by a later
 * one that references the same `threadKey`. Whatever is still open is what the
 * DM can pull on. NPCs are threaded separately: someone met once and never
 * mentioned again is a dangling introduction.
 */
export function openThreads(events) {
  const opened = new Map();
  const closed = new Set();
  const npcs = new Map();

  for (const ev of events) {
    const meta = EVENT_TYPES[ev.type];
    const key = ev.payload?.threadKey
      || ev.payload?.what
      || ev.payload?.name
      || ev.id;

    if (meta?.thread === 'open') {
      if (!opened.has(key)) opened.set(key, { key, event: ev, count: 0 });
      opened.get(key).count += 1;
    } else if (meta?.thread === 'close') {
      closed.add(key);
      if (ev.payload?.threadKey) closed.add(ev.payload.threadKey);
    }

    if (ev.type === 'npc_met' || ev.type === 'npc_relationship'
        || ev.type === 'dialogue_beat') {
      const name = ev.payload?.name || ev.payload?.npc;
      if (name) {
        if (!npcs.has(name)) {
          npcs.set(name, { name, first: ev.ts, last: ev.ts, mentions: 0, where: ev.payload?.where });
        }
        const n = npcs.get(name);
        n.mentions += 1;
        n.last = ev.ts;
      }
    }
  }

  const threads = [...opened.values()]
    .filter((t) => !closed.has(t.key))
    .map((t) => ({
      kind: t.event.type === 'secret_learned' ? 'secret' : 'promise',
      key: t.key,
      summary: t.event.summary,
      since: t.event.ts,
      payload: t.event.payload,
    }));

  const dangling = [...npcs.values()]
    .filter((n) => n.mentions === 1)
    .map((n) => ({
      kind: 'npc',
      key: n.name,
      summary: `${n.name} was met once and hasn't come up since`,
      since: n.first,
      payload: n,
    }));

  // Sort defensively. `since` comes from an event's timestamp, and the event
  // log is JSON Lines on disk that a person can edit, hand-merge or carry over
  // from an older schema. One row without a ts must not take the whole
  // Chronicle tab down with a TypeError - an undated thread sorts first and
  // stays visible, which is far better than showing nothing at all.
  return [...threads, ...dangling]
    .sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
}

/** Headline counts for a set of events - used by the Chronicle and the export. */
export function summarise(events) {
  const byType = {};
  for (const ev of events) byType[ev.type] = (byType[ev.type] || 0) + 1;

  const damageDealt = events
    .filter((e) => e.type === 'damage_dealt')
    .reduce((n, e) => n + (Number(e.payload?.amount) || 0), 0);
  const damageTaken = events
    .filter((e) => e.type === 'damage_taken')
    .reduce((n, e) => n + (Number(e.payload?.amount) || 0), 0);
  const spent = events
    .filter((e) => e.type === 'purchase')
    .reduce((n, e) => n + (Number(e.payload?.priceCp) || 0), 0);

  return {
    total: events.length,
    byType,
    kills: byType.kill || 0,
    crits: byType.crit || 0,
    spellsCast: byType.spell_cast || 0,
    damageDealt,
    damageTaken,
    copperSpent: spent,
    npcsMet: new Set(
      events.filter((e) => e.type === 'npc_met').map((e) => e.payload?.name)
    ).size,
    first: events[0]?.ts || null,
    last: events[events.length - 1]?.ts || null,
  };
}
