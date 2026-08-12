/**
 * The cost tier: how many taps does an answer cost?
 *
 * The Python tier next door asks whether a fact is in the payload at all.
 * This asks the harder and more useful question - whether a person sitting
 * at a table can GET to it - and the two merge on question id:
 *
 *     reachable = available AND (taps is not null)
 *
 * DECLARED PATHS, NOT SEARCH. "Fewest taps to X" is a shortest-path problem
 * over a graph whose edges MUTATE STATE. A breadth-first search would be
 * enormously expensive and, worse, destructive: clicking "End the encounter
 * and clear everyone?" partway through would wreck the fixture for every
 * later question in the cycle. So each entry carries up to three
 * hand-written routes and an answer predicate; the walker follows a route
 * counting taps and checks the predicate, and takes the cheapest route that
 * worked.
 *
 * The cost of that choice, stated plainly: if the app grows a BETTER route,
 * this will not notice and the number will not improve. Adding a route is a
 * three-line diff and a deliberate act. It buys a grader that cannot destroy
 * its own fixture and is cheap enough to run a hundred times a night.
 *
 * This module imports probe.js and nothing else from the app. No app module,
 * no location.hash, no navigation helper - see probe.js for why.
 */

import {
  tap, tappable, intersectsViewport, screenful, visibleText, NotTappable,
} from './probe.js';

/* ------------------------------------------------------------------ */
/* finding things, by what a person would look for                     */
/* ------------------------------------------------------------------ */

const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** A nav button, by its visible label. */
const nav = (label) => (doc) =>
  [...doc.querySelectorAll('#modes button')]
    .find((b) => txt(b).toLowerCase() === label.toLowerCase()) || null;

/** Any button whose label matches, exactly first then by prefix. */
const btn = (label, within = null) => (doc) => {
  const root = within ? doc.querySelector(within) : doc;
  const all = [...(root?.querySelectorAll('button') || [])];
  return all.find((b) => txt(b) === label)
    || all.find((b) => txt(b).startsWith(label)) || null;
};

/** A tab in a kit.js tab row. */
const tabNamed = (label) => (doc) =>
  [...doc.querySelectorAll('.tabs button, [role="tab"]')]
    .find((b) => txt(b) === label) || null;

/** A <details> summary, so a fold can be opened as a real tap. */
const fold = (label) => (doc) =>
  [...doc.querySelectorAll('details > summary')]
    .find((s) => txt(s).toLowerCase().includes(label.toLowerCase())) || null;

/** Does the visible text of `main` match? The default answer predicate. */
const says = (re) => (doc) => re.test(visibleText(doc));

/** Is a selector present and actually on screen?
 *
 * INTERSECTS rather than contains: a panel taller than a phone is never
 * wholly inside the viewport, and asking for containment marked every DM
 * answer unreachable - including the zero-tap control. */
const shows = (sel) => (doc, win) => {
  const el = doc.querySelector(sel);
  return Boolean(el) && intersectsViewport(el, win);
};

/* ------------------------------------------------------------------ */
/* the catalogues                                                      */
/* ------------------------------------------------------------------ */
//
// `paths` are ordered cheapest-first only by convention; the walker takes
// the minimum that actually worked, so ordering is a hint and not a claim.
// An empty `paths` means "already on screen" - zero taps, which is a real
// reading and must never be confused with "no data".

export const DM_QUESTIONS = [
  { id: 'initiative_order', paths: [[]],
    answer: shows('.cockpit-main') },
  { id: 'whose_turn', paths: [[]], answer: says(/round/i) },
  { id: 'ogre_hp', paths: [[]], answer: says(/ogre/i) },
  { id: 'who_has_acted', paths: [[fold('Called their turn')]],
    answer: says(/called their turn|nobody has called/i) },
  { id: 'party_ac', paths: [[fold('The party')]], answer: says(/\bAC\b/) },
  { id: 'party_passive_perception', paths: [[fold('The party')]],
    answer: says(/passive/i) },
  { id: 'party_hp_now', paths: [[fold('The party')]], answer: says(/\bHP\b/i) },
  { id: 'party_saves', paths: [[fold('The party')]], answer: says(/\bSTR\b/) },
  { id: 'party_resistances', paths: [[fold('The party')]],
    answer: says(/resist|senses/i) },
  { id: 'recent_rolls', paths: [[fold('Dice')]], answer: says(/dice|no rolls/i) },
  { id: 'prepared_encounters', paths: [[fold('Prepared')]],
    answer: says(/prepared|save as prepared/i) },
  { id: 'day_and_weather', paths: [[nav('Deck')]], answer: says(/day\s*\d+/i) },
  { id: 'current_region', paths: [[nav('Deck')]], answer: says(/the party/i) },
  { id: 'clock_state', paths: [[nav('Deck')]], answer: says(/clock/i) },
  { id: 'faction_standing_now', paths: [[nav('Deck')]], answer: says(/faction/i) },
  { id: 'faction_agenda', paths: [[nav('Deck')]], answer: says(/agenda|unknown/i) },
  { id: 'faction_standing_history', paths: [[nav('Deck')]],
    answer: (doc) => Boolean(doc.querySelector('canvas')) },
  { id: 'gold_spent_by_day', paths: [[nav('Deck')]],
    answer: (doc) => Boolean(doc.querySelector('canvas')) },
  { id: 'hidden_pins', paths: [[nav('Deck')]], answer: says(/hidden from players/i) },
  { id: 'region_note', paths: [[nav('Deck')]], answer: says(/NOTE-NEVER-RENDERED/) },
  { id: 'campaign_lore', paths: [[nav('Deck')], [nav('Story')], [nav('World')]],
    answer: says(/LORE-NEVER-RENDERED/) },
  { id: 'npc_disposition', paths: [[nav('Deck')], [nav('Story')]],
    answer: says(/disposition/i) },
  { id: 'monster_statblock',
    paths: [[nav('World'), tabNamed('Bestiary')]], answer: says(/armor class/i) },
  { id: 'condition_meaning_dm',
    paths: [[nav('World'), tabNamed('Rules')]], answer: says(/restrained/i) },
  { id: 'encounter_difficulty',
    paths: [[nav('World'), tabNamed('Encounter')]], answer: says(/budget/i) },
  { id: 'spotlight_balance', paths: [[nav('Story')]], answer: says(/SPOTLIGHT/) },
  { id: 'crit_rate', paths: [[nav('Story')]], answer: says(/crit rate|%/i) },
  { id: 'session_count', paths: [[nav('Story')]], answer: says(/session \d+ of/i) },
  { id: 'session_pacing', paths: [[nav('Story')]], answer: says(/last session/i) },
  { id: 'damage_taken_total', paths: [[nav('Story')]], answer: says(/dmg taken/i) },
  { id: 'death_saves_made', paths: [[nav('Story')]], answer: says(/death save/i) },
  { id: 'rest_cadence', paths: [[nav('Story')]], answer: says(/long rest/i) },
  { id: 'encounter_outcome', paths: [[nav('Story')]], answer: says(/encounter ended/i) },
  { id: 'gold_earned', paths: [[nav('Story')], [nav('Deck')]], answer: says(/sold|earned/i) },
  { id: 'party_wealth', paths: [[fold('The party')], [nav('Deck')]],
    answer: says(/\bgp\b/) },
  { id: 'clock_history', paths: [[nav('Deck')], [nav('Story')]],
    answer: says(/clock.*per day|filling/i) },
];

export const PLAYER_INTENTS = [
  { id: 'my_turn_now', paths: [[]], answer: shows('.your-turn') },
  { id: 'roll_an_attack',
    paths: [[(doc) => actBarButton(doc, /\s[+-]\d+$/)], [tabNamed('Overview'), btn('Roll')]],
    answer: (doc) => Boolean(doc.defaultView.document
      .querySelector('#rollcards .rollcard')) },
  { id: 'end_my_turn', paths: [[btn('End turn')]], answer: says(/./) },
  { id: 'my_hp', paths: [[]], answer: says(/HP\s*\d+\s*of\s*\d+/i) },
  { id: 'my_ac_why', paths: [[]], answer: says(/AC \d+ =/) },
  { id: 'skill_why', paths: [[]], answer: says(/expertise|prof/i) },
  { id: 'attack_bonus_why', paths: [[]], answer: says(/DEX \+|STR \+/) },
  { id: 'my_resistances', paths: [[]], answer: says(/resistant to|immune to/i) },
  { id: 'my_reactions', paths: [[tabNamed('Features')]], answer: says(/reaction/i) },
  { id: 'slots_left', paths: [[tabNamed('Spells')]], answer: says(/of \d+/) },
  { id: 'cast_a_spell', paths: [[tabNamed('Spells'), btn('Cast')]], answer: says(/cast/i) },
  { id: 'spell_text', paths: [[tabNamed('Spells')]], answer: says(/casting time|duration/i) },
  { id: 'spend_a_hit_die', paths: [[btn('Short rest')]], answer: says(/hit dice.*spend/i) },
  { id: 'condition_meaning_player', paths: [[]], answer: says(/restrained:/i) },
  { id: 'did_i_hit', paths: [[(doc) => actBarButton(doc, /\s[+-]\d+$/)]],
    answer: says(/\bhit\b|\bmiss(ed)?\b/i) },
  { id: 'how_much_damage', paths: [[(doc) => actBarButton(doc, /\s[+-]\d+$/)]],
    answer: says(/\d+ damage/i) },
  { id: 'enemy_hp_band', paths: [[fold('The fight')]], answer: says(/bloodied|unhurt|hurt/i) },
  { id: 'enemy_hp_number', paths: [[fold('The fight')]], answer: says(/\b59\b/) },
  { id: 'my_party_hp', paths: [[fold('The fight')], [nav('Party')]], answer: says(/\bHP\b/i) },
  { id: 'the_day', paths: [[fold('The world')], [nav('Party')]], answer: says(/day\s*\d+/i) },
  { id: 'faction_agenda_player', paths: [[fold('The world')], [nav('Party')]],
    answer: says(/SECRETAGENDA/) },
  { id: 'hidden_pin_player', paths: [[nav('Party')]], answer: says(/HIDDENPIN/) },
  { id: 'record_rp_beat', paths: [[nav('Roleplay'), btn('Made a promise')]],
    answer: says(/promise/i) },
  { id: 'record_rp_in_fight',
    paths: [[btn('Made a promise')]],   // from Play, without leaving the fight
    answer: says(/promise/i) },
];

/** The act bar's attack buttons carry their bonus, e.g. "Rapier +8". */
function actBarButton(doc, re) {
  const bar = [...doc.querySelectorAll('.cockpit-rail .panel')]
    .find((p) => /your turn/i.test(txt(p.querySelector('.lvl'))));
  return [...(bar?.querySelectorAll('button') || [])]
    .find((b) => re.test(txt(b))) || null;
}

export const ALL = [...DM_QUESTIONS, ...PLAYER_INTENTS];

/** The same drift guard the Python tier applies, from the same file. */
export function assertNoDrift(catalogue) {
  const want = new Set(catalogue.questions.map((q) => q.id));
  const have = new Set(ALL.map((q) => q.id));
  const missing = [...want].filter((id) => !have.has(id)).sort();
  const extra = [...have].filter((id) => !want.has(id)).sort();
  if (missing.length || extra.length) {
    throw new Error('reach catalogue drift — refusing to measure.'
      + `\n  no path for: ${missing.join(', ')}`
      + `\n  path with no catalogue entry: ${extra.join(', ')}`);
  }
  return want.size;
}

/* ------------------------------------------------------------------ */
/* walking one question                                                */
/* ------------------------------------------------------------------ */

/**
 * The three vetoes, applied to the screen the answer LANDED on.
 *
 * Conjunctive on purpose: the two degenerate solutions here are "print every
 * number onto one page" (one tap for everything, unusable) and "a
 * two-hundred-button act bar" (likewise). Killing them with separate,
 * independent rules means gaming one buys nothing.
 */
export function vetoes(doc, win, caps) {
  const s = screenful(doc, win);
  const out = [];
  // Legibility is MEASURED AND REPORTED, never vetoed on. Calibration
  // against the shipped app found a 10px floor on every screen - the
  // `.lvl` badges, chips and mono hints the whole design is built from.
  // A 13px veto therefore rejected every screen in the app, including the
  // control that is meant to cost zero taps, which is a grader measuring
  // its own opinion rather than the app. minFontPx rides along on the row
  // so a real shrink still shows up in the report.
  if (caps && s.choices > caps.CHOICE_CAP) {
    out.push(`density: ${s.choices} choices > ${caps.CHOICE_CAP}`);
  }
  if (caps && s.numbers > caps.NUMBER_CAP) {
    out.push(`density: ${s.numbers} numbers > ${caps.NUMBER_CAP}`);
  }
  return { vetoed: out, screenful: s };
}

/**
 * Walk one declared route, counting only taps a person could have made.
 *
 * A step that is present but untappable throws rather than being skipped:
 * "reachable in 3 taps" and "the button is under a modal backdrop" are
 * different facts and must not collapse into the same number.
 */
async function walk(doc, win, steps, settle) {
  let taps = 0;
  let scrolls = 0;
  for (const find of steps) {
    const el = find(doc, win);
    if (!el) return { ok: false, why: 'a step in the route was not on screen', taps };
    const v = tappable(el, win);
    if (!v.ok && v.scrollable) {
      // Scrolling is real work but it is not a tap. Counted separately so
      // it can never quietly inflate or deflate the headline number.
      el.scrollIntoView({ block: 'center' });
      scrolls += 1;
      await settle();
    }
    try {
      tap(el, win);
    } catch (e) {
      if (e instanceof NotTappable) return { ok: false, why: e.why, taps };
      throw e;
    }
    taps += 1;
    await settle();
  }
  return { ok: true, taps, scrolls };
}

/**
 * Measure one question. Returns a row, or null when no route worked.
 *
 * `reset` puts the frame back to a known screen between routes, because a
 * route that navigated away would otherwise poison the next attempt.
 */
export async function measure(q, { doc, win, settle, reset, caps }) {
  let best = null;
  for (const steps of q.paths) {
    if (reset) { await reset(); }
    const r = await walk(doc, win, steps, settle);
    if (!r.ok) continue;
    if (!q.answer(doc, win)) continue;
    const { vetoed, screenful: s } = vetoes(doc, win, caps);
    const row = {
      questionId: q.id,
      taps: r.taps,
      scrollsBefore: r.scrolls,
      vetoed,
      choices: s.choices,
      numbers: s.numbers,
      minFontPx: s.minFontPx,
      resultVisibleWithoutScroll: r.scrolls === 0 ? 1 : 0,
    };
    // A vetoed screen is not reachable, however few taps it took.
    if (vetoed.length) row.taps = null;
    if (best === null || (row.taps !== null && row.taps < best.taps)) best = row;
  }
  return best;
}
