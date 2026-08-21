/**
 * Application gym - graded integration testing for the app itself.
 *
 * The campaign emulator grades GAME BALANCE: is this subclass too strong. This
 * grades the APPLICATION: do the features work, do they work together, and do
 * they stay working. Different question, same discipline - pre-registered bars,
 * coverage that is measured rather than assumed, and failures that are named
 * instead of averaged away.
 *
 * Two tiers, because they catch different things and pretending they are one
 * measurement would flatter both:
 *
 *   logic  scripted through the real modules with a memory-backed store, a
 *          seeded RNG and a frozen clock. Deterministic, assertion-dense, and
 *          the place a wrong number shows up.
 *   ui     drives the actual rendered modes in the page. Few assertions and
 *          slower, but it is the only tier that catches a mode whose wiring
 *          broke while its logic stayed perfect.
 *
 * A suite that cannot run reports as ERROR, never as passing-with-zero-checks.
 * A scenario with no assertions is itself a failure: the harness refuses to
 * count an empty test as a green one, which is the oldest way a suite lies.
 */

import { seededRng } from '../core/rng.js';
import { d20 } from '../core/dice.js';
import { derive } from '../core/derive.js';
import { checkAll, INVARIANT_IDS } from './invariants.js';
import { serverBase } from '../core/db.js';

/* ------------------------------------------------------------------ */
/* assertion harness                                                   */
/* ------------------------------------------------------------------ */

/**
 * Per-scenario recorder.
 *
 * Every assertion is counted whether it passes or fails, so "3 checks, 3
 * passed" can be told apart from "0 checks, nothing failed" - the second is
 * not a pass and this harness will not report it as one.
 */
export class Check {
  constructor(scenario) {
    this.scenario = scenario;
    this.passed = 0;
    this.failures = [];
    this.touched = new Set();
    this.metrics = new Map();
  }

  /** Record that a feature was actually exercised. */
  feature(...names) { for (const n of names) this.touched.add(n); }

  ok(condition, label, detail = '') {
    if (condition) { this.passed += 1; return true; }
    this.failures.push({ label, detail });
    return false;
  }

  eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return this.ok(a === e, label, `expected ${e}, got ${a}`);
  }

  near(actual, expected, tol, label) {
    return this.ok(Math.abs(actual - expected) <= tol, label,
      `expected ${expected} +/- ${tol}, got ${actual}`);
  }

  /**
   * Record a MEASUREMENT, not a claim.
   *
   * ok/eq/near answer "is this right". This answers "how much", which has
   * no pass and no fail - so it deliberately does not touch `passed` or
   * `failures`, and the rule that a scenario asserting nothing is not a
   * pass stays exactly as it was. A scenario that only measures still
   * counts as empty, which is correct: it proved nothing.
   *
   * A non-finite value is refused LOUDLY rather than stored, because a NaN
   * that silently becomes 0 is how a chart ends up lying. `value` is
   * positional and is never ||-defaulted anywhere on this path: 0 is a
   * legitimate reading (already on screen, nothing spent) and must survive.
   *
   * `of` names the subject when one scenario measures many things - the
   * question id, the seat, the screen - so rows stay distinguishable.
   */
  metric(name, value, { unit = null, of = null } = {}) {
    if (!Number.isFinite(value)) {
      this.failures.push({
        label: `metric "${name}" was not a finite number`,
        detail: `${of ? `${of}: ` : ''}${String(value)}`,
      });
      return null;
    }
    const row = { name, value, unit, of };
    this.metrics.set(of ? `${name}@${of}` : name, row);
    return row;
  }

  /** Deep equality, for round-trip checks where a diff is the useful output. */
  same(a, b, label) {
    const diff = firstDifference(a, b);
    return this.ok(diff === null, label, diff || '');
  }

  get total() { return this.passed + this.failures.length; }
}

/** First differing path between two structures - far more useful than false. */
export function firstDifference(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path || '<root>'}: ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object') {
    return `${path || '<root>'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a) && a.length !== b.length) {
    return `${path}.length: ${a.length} vs ${b.length}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDifference(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A complete, valid character. Explicit so a schema change fails loudly. */
export function makeChar(over = {}) {
  return {
    id: over.id || 'gym-char',
    name: over.name || 'Gym Subject',
    ruleset: '2024',
    species: over.species ?? 'human',
    background: over.background ?? 'soldier',
    classes: over.classes || [{ class: 'fighter', level: 5, subclass: null }],
    abilities: over.abilities || { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
    abilityBonuses: over.abilityBonuses || {},
    skills: over.skills || ['athletics', 'perception'],
    feats: over.feats || [],
    hp: over.hp || {},
    hitDice: over.hitDice || {},
    inventory: over.inventory || [],
    currency: over.currency || { gp: 50 },
    spells: over.spells || { prepared: [], known: [] },
    slotState: over.slotState || {},
    resourceState: over.resourceState || {},
    toggles: over.toggles || {},
    conditions: over.conditions || [],
    exhaustion: over.exhaustion ?? 0,
    deathSaves: over.deathSaves || { successes: 0, failures: 0 },
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* suites                                                              */
/* ------------------------------------------------------------------ */

/**
 * Each scenario gets (check, ctx) where ctx carries the loaded compendium and
 * a seeded rng. Scenarios must not depend on each other's state; the runner
 * gives each a fresh Check and they are safe to reorder.
 */
export const SUITES = [

  /* ---------------- derivation ------------------------------------ */
  {
    id: 'derive',
    title: 'Derivation engine',
    why: 'Every screen and every export reads from derive(). If it is wrong or '
       + 'impure, everything downstream is wrong in the same way.',
    scenarios: [
      {
        id: 'purity',
        title: 'derive() is pure and repeatable',
        run(c, { sources }) {
          const ch = makeChar();
          const snapshot = structuredClone(ch);
          const a = derive(ch, sources);
          const b = derive(ch, sources);
          c.feature('derive');
          c.same(ch, snapshot, 'derive does not mutate the character it is given');
          c.same(a, b, 'derive is deterministic for identical input');
        },
      },
      {
        id: 'hp_scaling',
        title: 'Hit points follow class, level and Constitution',
        run(c, { sources }) {
          c.feature('derive', 'hp');
          const hp = (cls, level, con) => derive(
            makeChar({ classes: [{ class: cls, level, subclass: null }],
              abilities: { str: 10, dex: 10, con, int: 10, wis: 10, cha: 10 } }),
            sources,
          ).hp.max;
          // d10 fighter, con 10: 10 at L1, +6 per level after.
          c.eq(hp('fighter', 1, 10), 10, 'fighter L1 con10 = 10');
          c.eq(hp('fighter', 5, 10), 34, 'fighter L5 con10 = 34');
          // +2 con adds 2 per level, so +10 across five levels.
          c.eq(hp('fighter', 5, 14), 44, 'fighter L5 con14 = 44');
          c.eq(hp('wizard', 5, 10), 22, 'wizard L5 con10 = 22');
          c.ok(hp('fighter', 5, 10) > hp('wizard', 5, 10),
            'a d10 class out-scales a d6 class at equal level');
        },
      },
      {
        id: 'shield_ac',
        title: 'A shield adds two exactly once - it is never the body armour',
        run(c, { sources }) {
          c.feature('derive', 'ac', 'inventory');
          // The equipment list files Shield under kind:'armor' with ac '+2'.
          // Selecting it as the WORN armour once fed armorAc a base of 2 and
          // produced AC 4 for a hero holding nothing but a shield.
          const shield = { id: 'i-shield', name: 'Shield', kind: 'armor',
            ac: '+2', equipped: true };
          const chainShirt = { id: 'i-cs', name: 'Chain Shirt', kind: 'armor',
            ac: '13 + Dex modifier (max 2)', equipped: true };
          const dex14 = { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 };

          const both = derive(makeChar({
            abilities: dex14, inventory: [shield, chainShirt] }), sources);
          c.eq(both.ac, 17, 'chain shirt + shield at dex 14 = 13 + 2 + 2');
          c.ok(both.acSource !== 'Shield', 'the armour named is never the shield');

          const only = derive(makeChar({
            abilities: dex14, inventory: [shield] }), sources);
          c.eq(only.ac, 14, 'shield alone = unarmored 10 + dex 2 + shield 2');

          // Order independence: the bug was .find() order-dependent.
          const flipped = derive(makeChar({
            abilities: dex14, inventory: [chainShirt, shield] }), sources);
          c.eq(flipped.ac, both.ac, 'inventory order cannot change the answer');
        },
      },
      {
        id: 'hp_override',
        title: 'A rolled maximum wins, says so, and steps aside cleanly',
        run(c, { sources }) {
          c.feature('derive', 'hp', 'hp-override');
          const base = {
            classes: [{ class: 'fighter', level: 5, subclass: null }],
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          };
          const d0 = derive(makeChar(base), sources);
          c.eq(d0.hp.max, 34, 'the rules derive 34');
          c.ok(d0.hp.derived, 'and say the number is theirs');

          const d1 = derive(makeChar({ ...base, hp: { override: 60 } }), sources);
          c.eq(d1.hp.max, 60, 'an override of 60 wins');
          c.ok(!d1.hp.derived, 'and is flagged as not derived');

          const d2 = derive(makeChar({ ...base,
            hp: { override: 60, current: 50 } }), sources);
          c.eq(d2.hp.current, 50, 'current rides within the rolled maximum');

          const d3 = derive(makeChar({ ...base, hp: { current: 50 } }), sources);
          c.eq(d3.hp.current, 34, 'cleared, current clamps back to the rules');

          const d4 = derive(makeChar({ ...base, hp: { override: -5 } }), sources);
          c.eq(d4.hp.max, 1, 'a nonsense override still floors at one');
        },
      },
      {
        id: 'multiclass',
        title: 'Multiclassing sums levels without double-counting first-level HP',
        run(c, { sources }) {
          c.feature('derive', 'multiclass');
          const d = derive(makeChar({
            classes: [{ class: 'fighter', level: 3, subclass: null },
              { class: 'wizard', level: 2, subclass: null }],
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
          }), sources);
          c.eq(d.level, 5, 'total level is the sum of class levels');
          c.eq(d.proficiencyBonus, 3, 'proficiency comes from TOTAL level');
          // fighter: 10 + 2x6 = 22, wizard: 2x4 = 8. Max die once only.
          c.eq(d.hp.max, 30, 'only the first class gets its maximum hit die');
        },
      },
      {
        id: 'invariants',
        title: 'Derived state holds every invariant across a level sweep',
        run(c, { sources }) {
          c.feature('derive', 'invariants');
          let checked = 0;
          for (const cls of ['fighter', 'wizard', 'rogue', 'cleric', 'barbarian']) {
            for (let level = 1; level <= 20; level += 1) {
              const ch = makeChar({ classes: [{ class: cls, level, subclass: null }] });
              const d = derive(ch, sources);
              const v = checkAll({ character: ch, derived: d }, { cls, level });
              checked += 1;
              if (v.length) {
                c.ok(false, `${cls} L${level} invariants`,
                  v.map((x) => x.id).join(', '));
                return;
              }
            }
          }
          c.ok(checked === 100, `swept ${checked} class/level combinations`);
          c.ok(true, `all ${INVARIANT_IDS.length} invariants held throughout`);
        },
      },
    ],
  },

  /* ---------------- persistence ------------------------------------ */
  {
    id: 'persistence',
    title: 'Storage round-trip',
    why: 'A character that does not survive a save/load cycle byte-for-byte is '
       + 'a character that will quietly lose someone\'s work.',
    scenarios: [
      {
        id: 'roundtrip',
        title: 'Every record kind round-trips unchanged',
        async run(c, { db, KINDS }) {
          c.feature('storage');
          for (const kind of KINDS) {
            const rec = { id: `gym-${kind}`, name: `Gym ${kind}`,
              nested: { list: [1, 2, { deep: true }], when: '2026-01-01' } };
            await db.put(kind, rec);
            const back = await db.get(kind, rec.id);
            c.same(back, rec, `${kind} round-trips unchanged`);
          }
        },
      },
      {
        id: 'character_roundtrip',
        title: 'A played character survives save/load with its play state',
        async run(c, { db, sources }) {
          c.feature('storage', 'play-state');
          const ch = makeChar({ id: 'gym-played' });
          const d0 = derive(ch, sources);
          // Simulate real play state rather than a pristine character.
          ch.hp = { ...d0.hp, current: d0.hp.max - 9 };
          ch.conditions = ['poisoned'];
          ch.exhaustion = 2;
          ch.resourceState = { 'Second Wind': 1 };
          await db.put('characters', ch);
          const back = await db.get('characters', ch.id);
          c.same(back, ch, 'character round-trips with damage and conditions');
          const d1 = derive(back, sources);
          c.eq(d1.hp.current, d0.hp.max - 9, 'damage survives the round trip');
          c.eq(d1.exhaustion, 2, 'exhaustion survives the round trip');
          c.ok(d1.conditions.includes('poisoned'), 'conditions survive');
        },
      },
      {
        id: 'list_and_delete',
        title: 'Listing and deletion behave',
        async run(c, { db }) {
          c.feature('storage');
          await db.put('characters', makeChar({ id: 'gym-a', name: 'A' }));
          await db.put('characters', makeChar({ id: 'gym-b', name: 'B' }));
          const list = await db.list('characters');
          const ids = list.map((r) => r.id);
          c.ok(ids.includes('gym-a') && ids.includes('gym-b'), 'list returns saved records');
          await db.del('characters', 'gym-a');
          const after = (await db.list('characters')).map((r) => r.id);
          c.ok(!after.includes('gym-a'), 'deleted record is gone');
          c.ok(after.includes('gym-b'), 'deletion does not take neighbours with it');
        },
      },
    ],
  },

  /* ---------------- play loop -------------------------------------- */
  {
    id: 'play',
    title: 'Play loop',
    why: 'Damage, healing, rests and resource spending are the moment-to-moment '
       + 'app. They are also where state corruption shows up first.',
    scenarios: [
      {
        id: 'damage_heal',
        title: 'Damage and healing move HP correctly and clamp at the ends',
        async run(c, { sources, engine }) {
          c.feature('play', 'damage');
          const ch = makeChar();
          const d = derive(ch, sources);
          const max = d.hp.max;

          let s = engine.applyDamage({ hp: { current: max }, hpMax: max }, -7);
          c.eq(s.hp, max - 7, '7 damage removes exactly 7');

          s = engine.applyDamage({ hp: { current: 3 }, hpMax: max }, -50);
          c.eq(s.hp, 0, 'overkill floors at 0, never negative');
          c.ok(s.downed, 'dropping to 0 reports downed');

          s = engine.applyDamage({ hp: { current: max - 2 }, hpMax: max }, +10);
          c.eq(s.hp, max, 'healing cannot exceed maximum');

          s = engine.applyDamage({ hp: { current: max }, hpMax: max, temp: 5 }, -8);
          c.eq(s.temp, 0, 'temporary HP is consumed first');
          c.eq(s.hp, max - 3, 'only the remainder reaches real HP');
        },
      },
      {
        id: 'resistance',
        title: 'Resistance, immunity and vulnerability apply in the right order',
        run(c, { engine }) {
          c.feature('play', 'damage', 'resistance');
          const m = (n, type, o) => engine.mitigate(n, type, o).amount;
          c.eq(m(10, 'fire', { resistances: ['fire'] }), 5, 'resistance halves');
          c.eq(m(10, 'fire', { immunities: ['fire'] }), 0, 'immunity zeroes');
          c.eq(m(10, 'fire', { vulnerabilities: ['fire'] }), 20, 'vulnerability doubles');
          c.eq(m(7, 'fire', { resistances: ['fire'] }), 3, 'halving rounds down');
          c.eq(m(10, 'cold', { resistances: ['fire'] }), 10, 'wrong type is untouched');
          c.eq(m(10, null, { resistances: ['fire'] }), 10, 'untyped damage is never mitigated');
          c.eq(m(10, 'fire', { resistances: ['fire'], immunities: ['fire'] }), 0,
            'immunity beats resistance');
          c.eq(m(10, 'fire', { resistances: ['fire'], vulnerabilities: ['fire'] }), 10,
            'vulnerable then resistant nets out');
        },
      },
      {
        id: 'resources',
        title: 'Resource pools spend and refuse to overdraw',
        run(c, { sources, engine }) {
          c.feature('play', 'resources');
          const ch = makeChar();
          const d = derive(ch, sources);
          const pool = d.resources[0];
          c.ok(!!pool, 'a level 5 fighter has at least one resource pool');
          if (!pool) return;

          const spend = engine.spendResource(ch, d, pool.name, 1);
          c.ok(!spend.error, `${pool.name} can be spent`);
          c.eq(spend.resourceState[pool.name], pool.max - 1, 'spending decrements by one');

          const over = engine.spendResource(
            { ...ch, resourceState: { [pool.name]: 0 } }, d, pool.name, 1,
          );
          c.ok(!!over.error, 'an empty pool refuses to be spent');
          const missing = engine.spendResource(ch, d, 'No Such Pool', 1);
          c.ok(!!missing.error, 'an unknown pool refuses rather than inventing itself');
        },
      },
      {
        id: 'exhaustion',
        title: 'Exhaustion applies the 2024 penalty and is bounded',
        run(c, { sources }) {
          c.feature('play', 'conditions', 'exhaustion');
          const at = (n) => derive(makeChar({ exhaustion: n }), sources);
          const base = at(0);
          const three = at(3);
          c.eq(three.exhaustion, 3, 'exhaustion level is carried through');
          // 2024: -2 per level to d20 tests.
          const dropped = base.saves.str.mod - three.saves.str.mod;
          c.eq(dropped, 6, 'three levels of exhaustion cost 6 on d20 tests');
          c.ok(at(6).hp.max >= 1, 'exhaustion 6 does not produce an impossible sheet');
        },
      },
    ],
  },

  /* ---------------- dice and rng ----------------------------------- */
  {
    id: 'dice',
    title: 'Dice and randomness',
    why: 'Every measured number in this project rests on the RNG being uniform '
       + 'and reproducible. A biased die would quietly bend every result.',
    scenarios: [
      {
        id: 'determinism',
        title: 'The same seed produces the same stream, different seeds do not',
        run(c) {
          c.feature('rng');
          const a = seededRng(42);
          const b = seededRng(42);
          const x = seededRng(43);
          const rollN = (r, n) => Array.from({ length: n }, () => r.die(20));
          const ra = rollN(a, 50);
          c.same(rollN(b, 50), ra, 'identical seeds give identical rolls');
          c.ok(JSON.stringify(rollN(x, 50)) !== JSON.stringify(ra),
            'a different seed gives a different stream');
        },
      },
      {
        id: 'streams',
        title: 'Named sub-streams are independent',
        run(c) {
          c.feature('rng');
          const r = seededRng(7);
          const combat = r.stream('combat');
          const loot = r.stream('loot');
          const a = Array.from({ length: 30 }, () => combat.die(20));
          const b = Array.from({ length: 30 }, () => loot.die(20));
          c.ok(JSON.stringify(a) !== JSON.stringify(b),
            'two named streams do not produce the same sequence');
          const combat2 = seededRng(7).stream('combat');
          c.same(Array.from({ length: 30 }, () => combat2.die(20)), a,
            'a named stream is reproducible from the root seed');
        },
      },
      {
        id: 'uniformity',
        title: 'd20 is uniform - no modulo bias',
        run(c) {
          c.feature('rng', 'dice');
          const r = seededRng(99);
          const counts = new Array(21).fill(0);
          const N = 60000;
          for (let i = 0; i < N; i += 1) counts[r.die(20)] += 1;
          const expected = N / 20;

          // Chi-square, not "every face within X%".
          //
          // A percentage bound is the wrong instrument: at N=60000 one face is
          // expected to sit ~2.8 standard deviations out simply because there
          // are twenty of them, so a 5% bound fails on a PERFECTLY fair die
          // roughly as often as not. The first run of this gym did exactly
          // that - 5.13% - and the die was fine. Chi-square asks the question
          // that actually matters: is the whole distribution consistent with
          // uniform?
          let chi2 = 0;
          for (let f = 1; f <= 20; f += 1) {
            chi2 += ((counts[f] - expected) ** 2) / expected;
          }
          // 19 degrees of freedom; critical value at p=0.001 is 43.82. Modulo
          // bias on a 32-bit source produces a systematic excess far beyond it.
          c.ok(counts[0] === 0, 'a d20 never returns 0');
          c.ok(counts.slice(1, 21).every((n) => n > 0), 'every face appears');
          c.ok(chi2 < 43.82, 'face distribution is consistent with uniform (chi-square)',
            `chi2 = ${chi2.toFixed(2)} on 19 df, critical 43.82 at p=0.001`);
        },
      },
    ],
  },

  /* ---------------- events and chronicle --------------------------- */
  {
    id: 'chronicle',
    title: 'Event log and chronicle',
    why: 'The chronicle is the thing a player hands their DM. If events go '
       + 'missing or summarise wrongly, the export is fiction.',
    scenarios: [
      {
        id: 'log_and_query',
        title: 'Logged events come back out',
        async run(c, { events }) {
          c.feature('events', 'chronicle');
          events.resetIds('gym');
          let n = 0;
          const off = events.subscribe(() => { n += 1; });
          await events.log('damage_taken', { amount: 7, source: 'goblin' });
          await events.log('kill', { target: 'goblin' });
          await events.log('gold_spent', { amount: 250 });
          off?.();
          const all = await events.query({});
          const ids = all.map((e) => e.type);
          c.ok(ids.includes('damage_taken'), 'damage event is queryable');
          c.ok(ids.includes('kill'), 'kill event is queryable');
          c.ok(n >= 3, 'subscribers are notified of each event', `saw ${n}`);
        },
      },
      {
        id: 'summarise',
        title: 'The summary counts what actually happened',
        async run(c, { events }) {
          c.feature('chronicle');
          const list = [
            { type: 'kill', payload: { target: 'goblin' } },
            { type: 'kill', payload: { target: 'orc' } },
            { type: 'crit', payload: {} },
            { type: 'damage_dealt', payload: { amount: 12 } },
            { type: 'damage_taken', payload: { amount: 5 } },
            // Spending is a `purchase` priced in COPPER - that is how shop
            // mode logs it. An earlier version of this test invented a
            // "gold_spent" event and then reported the app as broken for not
            // counting it.
            { type: 'purchase', payload: { item: 'Rope', priceCp: 100 } },
            { type: 'npc_met', payload: { name: 'Dockmaster' } },
          ];
          const s = events.summarise(list);
          c.eq(s.kills, 2, 'two kills are counted as two');
          c.eq(s.crits, 1, 'one crit is counted as one');
          c.eq(s.damageDealt, 12, 'damage dealt is totalled');
          c.eq(s.damageTaken, 5, 'damage taken is totalled separately');
          c.eq(s.copperSpent, 100, 'purchases are totalled in copper');
          c.eq(s.npcsMet, 1, 'distinct NPCs are counted');
          c.eq(s.total, list.length, 'the total counts every event');
        },
      },
      {
        id: 'threads',
        title: 'Open threads are the promises with no resolution',
        run(c, { events }) {
          c.feature('chronicle', 'threads');
          // Shaped like real logged events: id, ts, summary and a threadKey.
          const ev = (id, type, what, ts) => ({
            id, type, ts, summary: what, payload: { what, threadKey: what },
          });
          const open = events.openThreads([
            ev('1', 'promise_made', 'find the sword', '2026-01-01T10:00:00Z'),
            ev('2', 'promise_made', 'pay the smith', '2026-01-01T11:00:00Z'),
            ev('3', 'promise_kept', 'pay the smith', '2026-01-02T09:00:00Z'),
          ]);
          c.ok(Array.isArray(open), 'openThreads returns a list');
          const keys = open.map((t) => t.key);
          c.ok(keys.includes('find the sword'), 'an unresolved promise stays open');
          c.ok(!keys.includes('pay the smith'), 'a kept promise is closed');

          // A row with no timestamp must not take the whole chronicle down.
          // events.jsonl is hand-editable on disk, so this is a real input.
          let survived = true;
          try {
            events.openThreads([
              { id: 'x', type: 'promise_made', payload: { what: 'undated' } },
              ev('y', 'promise_made', 'dated', '2026-01-01T10:00:00Z'),
            ]);
          } catch { survived = false; }
          c.ok(survived, 'an event with no timestamp does not crash the chronicle');
        },
      },
    ],
  },

  /* ---------------- homebrew pipeline ------------------------------ */
  {
    id: 'homebrew',
    title: 'Homebrew pipeline',
    why: 'This is the headline feature. Ingest, mapping and the emitters have '
       + 'to agree with the engine or the page it produces is decoration.',
    scenarios: [
      {
        id: 'formats',
        title: 'Every declared input format ingests',
        async run(c, { hb }) {
          c.feature('homebrew', 'ingest');
          const md = [
            '## Path of the Gym',
            '### Iron Discipline',
            'At 3rd level, you gain Resistance to Cold damage.',
            '### Heavy Hands',
            'At 6th level, your weapon attacks deal an extra 1d6 Force damage.',
          ].join('\n\n');
          const fromMd = hb.parse('markdown', md, { filename: 'gym.md' });
          c.ok(fromMd.features.length >= 2, 'markdown yields both features',
            `got ${fromMd.features.length}`);
          c.eq(fromMd.features[0].level, 3, 'the 2014 phrasing "At 3rd level" is read');

          const json = { id: 'gym-json', name: 'Gym JSON', class: 'fighter',
            desc: '#### Gym Feature\nAt 3rd level, you gain Resistance to Fire damage.' };
          const fromJson = hb.parse('open5e', json);
          c.ok(fromJson.features.length >= 1, 'open5e JSON yields a feature');

          // The plain-text adapter needs a body of real length under a
          // heading - it deliberately ignores a heading followed by a stub,
          // because in an unstructured document that is usually a caption.
          const txt = [
            'Gym Text Path',
            '',
            'Acid Skin',
            'Starting at 3rd level, your skin sloughs and reforms constantly.',
            'You gain Resistance to Acid damage, and creatures that grapple you',
            'take 1d4 Acid damage at the end of your turn.',
          ].join('\n');
          const fromTxt = hb.parse('text', txt, { filename: 'gym.txt' });
          c.ok(fromTxt.features.length >= 1, 'plain text yields a feature',
            `got ${fromTxt.features.length}`);
          c.eq(fromTxt.fidelity, 'low',
            'plain text is honestly reported as the lowest-fidelity path');
          c.ok(['low', 'medium', 'high'].includes(fromTxt.fidelity),
            'every adapter declares a fidelity');
        },
      },
      {
        id: 'mapping_to_mechanics',
        title: 'Prose becomes mechanics the engine can execute',
        async run(c, { hb, sources }) {
          c.feature('homebrew', 'mapping');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Path',
            '### Cold Blooded',
            'At 3rd level, you gain Resistance to Cold damage.',
            '### Searing Strikes',
            'At 6th level, your weapon attacks deal an extra 1d6 Fire damage.',
          ].join('\n\n'), { filename: 'g.md' })));
          brew.class = 'barbarian';

          const types = brew.features.flatMap((f) => (f.effects || []).map((e) => e.type));
          c.ok(types.includes('resistance'), 'a resistance sentence maps to a resistance');
          c.ok(types.includes('damage_rider'), 'a damage sentence maps to a rider');

          // The real test: does the ENGINE see it?
          const ch = makeChar({
            classes: [{ class: 'barbarian', level: 6, subclass: brew.id }],
          });
          const d = derive(ch, { ...sources, homebrew: [brew] });
          c.ok(d.resistances.includes('cold'),
            'the mapped resistance reaches the derived sheet');
          c.ok((d.damageRiders || []).length > 0,
            'the mapped rider reaches the derived sheet');

          // Collision precedence: a brew that shares a BUNDLED subclass id
          // must win, or the compendium's thinner copy silently shadows it.
          // That shadowing is exactly how every SRD corpus brew came to be
          // measured with empty effect lists.
          const shadow = { ...brew, id: 'path-of-the-berserker' };
          const ch2 = makeChar({
            classes: [{ class: 'barbarian', level: 6,
              subclass: 'path-of-the-berserker' }],
          });
          const d2 = derive(ch2, { ...sources, homebrew: [shadow] });
          c.ok(d2.resistances.includes('cold'),
            'on an id collision the ingested brew beats the bundled copy');
        },
      },
      {
        id: 'executable_registry',
        title: 'The executable registry is honest about what runs, per reaction',
        async run(c, { hb, exec }) {
          c.feature('homebrew', 'coverage', 'reactions');
          // Two reactions, one on each side of the bounded model: Riposte
          // triggers on a MISS - a bucket the loop does not dispatch - and
          // must land inert with the reason naming that bucket; the halve-
          // on-hit runs. The old set-membership invariant cannot survive
          // per-instance verdicts, so this scenario grew instance eyes.
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Reactions',
            '### Riposte',
            'At 3rd level, when a creature misses you with a melee attack, you can '
            + 'use your Reaction to strike back.',
            '### Stone Skin',
            'At 6th level, when an attacker hits you with a weapon attack, you '
            + 'can use your reaction to halve the damage that you take.',
          ].join('\n\n'), { filename: 'r.md' })));
          const split = exec.executableSplit(brew);
          c.ok(split.counts.total > 0, 'the split sees the brew\'s effects');
          c.eq(split.executed.reaction_option, 1, 'the supported reaction runs');
          c.eq(split.inert.reaction_option, 1, 'the unsupported one does not');
          c.ok(/missed_by_attack/.test(split.reasons.reaction_option || ''),
            'and the reason names the unmodelled trigger',
            split.reasons.reaction_option);
          for (const t of Object.keys(split.executed)) {
            if (t === 'reaction_option') continue;
            c.ok(exec.EXECUTABLE.has(t), `${t} is genuinely in the executable set`);
          }
          for (const t of Object.keys(split.inert)) {
            if (t === 'reaction_option') continue;
            c.ok(!exec.EXECUTABLE.has(t), `${t} is correctly reported as inert`);
          }
        },
      },
      {
        id: 'reaction_classifier',
        title: 'Reaction triggers and responses classify from their own sentences',
        async run(c, { hb }) {
          c.feature('homebrew', 'reactions');
          // Verbatim corpus phrasings - the review artifact for the
          // sentence-window classifier. One brew, one feature each.
          const md = [
            '## Gym Reaction Corpus',
            '### Retaliation',
            'At 3rd level, when you take damage from a creature that is within '
            + '5 feet of you, you can use your reaction to make a melee weapon '
            + 'attack against that creature.',
            '### Jester Style',
            'At 3rd level, when an attacker that you can see hits you with a '
            + 'weapon attack, you can use your reaction to halve the damage '
            + 'that you take.',
            '### Fight for Every Step',
            'At 6th level, when you take damage from a melee attack, you can '
            + 'use your reaction to brace yourself, reducing the damage you '
            + 'take from the attack by 1d6.',
            '### Adaptive Shroud',
            'At 6th level, when you take damage, you can use your reaction to '
            + 'gain resistance to the triggering damage type until the start '
            + 'of your next turn.',
            '### Stormshield',
            'At 6th level, when you take lightning or thunder damage, you can '
            + 'use your reaction to gain resistance to lightning and thunder '
            + 'damage until the end of your next turn.',
            '### Feline Reflexes',
            'At 3rd level, when a creature you can see misses you with an '
            + 'attack, you can use your reaction to take the Dodge action.',
            '### Cutting Words',
            'At 3rd level, when a creature that you can see within 60 feet of '
            + 'you makes an attack roll, an ability check, or a damage roll, '
            + 'you can use your reaction to expend one use of your inspiration.',
            '### Deflect Strike',
            'At 7th level, when an ally you can see within 30 feet is hit by '
            + 'a melee attack, you can use your reaction to reduce the damage '
            + 'by 1d10.',
            '### Improved Feline Reflexes',
            'At 11th level, when you take no damage after succeeding on a '
            + 'Dexterity saving throw against an effect, you can use your '
            + 'reaction to move away.',
          ].join('\n\n');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', md,
            { filename: 'rx.md' })));
          const rx = (name) => (brew.features.find((f) => f.name === name)
            ?.effects || []).find((e) => e.type === 'reaction_option');

          const pin = (name, trigger, respKind) => {
            const e = rx(name);
            c.ok(!!e, `${name} maps as a reaction`);
            if (!e) return null;
            c.eq(e.trigger, trigger, `${name} trigger is ${trigger}`);
            if (respKind) {
              c.eq(e.response?.kind, respKind, `${name} response is ${respKind}`);
            }
            return e;
          };
          pin('Retaliation', 'takes_damage', 'counterattack');
          const jester = pin('Jester Style', 'hit_by_attack', 'reduce_damage');
          c.ok(jester?.response?.halve === true, 'Jester Style halves');
          const brace = pin('Fight for Every Step', 'takes_damage', 'reduce_damage');
          c.eq(brace?.response?.dice, '1d6', 'Fight for Every Step reduces by 1d6');
          const shroud = pin('Adaptive Shroud', 'takes_damage', 'reduce_damage');
          c.ok(shroud?.response?.resist === true, 'Adaptive Shroud grants resistance');
          const storm = pin('Stormshield', 'takes_damage', 'reduce_damage');
          c.same(storm?.damageTypes, ['lightning', 'thunder'],
            'Stormshield only fires on its own damage types');
          pin('Feline Reflexes', 'missed_by_attack', null);
          pin('Cutting Words', 'roll_made', null);
          pin('Deflect Strike', 'ally_damaged', null);
          const neg = rx('Improved Feline Reflexes');
          c.eq(neg?.trigger, 'other',
            '"take NO damage" is the negation guard, not takes_damage');
        },
      },
      {
        id: 'action_payloads',
        title: 'Feature payloads parse: what an action does, not just that it exists',
        async run(c, { hb }) {
          c.feature('homebrew', 'reactions', 'payloads');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Payloads',
            '### Hard Shove',
            'At 3rd level, as a Bonus Action, you can force a creature within '
            + '30 feet to make a Wisdom saving throw. On a failure it is '
            + 'pushed 15 feet and has the Frightened condition.',
            '### Nova Burst',
            'At 5th level, as a Magic action, each creature within 10 feet of '
            + 'you must make a Dexterity saving throw, taking 2d6 fire damage '
            + 'on a failure.',
          ].join('\n\n'), { filename: 'pl.md' })));
          const eff = (name) => (brew.features.find((f) => f.name === name)
            ?.effects || []).find((e) => e.type === 'action_option');

          const shove = eff('Hard Shove');
          c.ok(!!shove, 'Hard Shove maps as an action');
          c.same(shove?.conditions, ['frightened'], 'the condition is named');
          c.eq(shove?.forcedMove, 15, 'the push distance is parsed');
          c.ok(!shove?.aoe, 'a single-target action is not an aoe');

          const nova = eff('Nova Burst');
          c.ok(!!nova, 'Nova Burst maps as an action');
          c.ok(nova?.aoe === true, 'each-creature phrasing is an aoe');
          c.eq(nova?.expectedDamage, 7, '2d6 averages to 7, deterministically');
        },
      },
      {
        id: 'dangling_costs',
        title: 'An action costing a resource nobody grants is reported',
        async run(c, { exec, sources }) {
          c.feature('homebrew', 'coverage');
          const brew = {
            id: 'gym-dangle', name: 'Dangler', class: 'fighter', ruleset: '2024',
            features: [{
              id: 'f1', name: 'Costly', level: 3, text: 'Spend 1 Vigour.',
              effects: [{ type: 'action_option', name: 'Costly', action: 'bonus',
                cost: { resource: 'Vigour', amount: 1 } }],
            }],
          };
          const d = derive(makeChar({
            classes: [{ class: 'fighter', level: 5, subclass: 'gym-dangle' }],
          }), { ...sources, homebrew: [brew] });
          const dangling = exec.danglingCosts(d);
          c.ok(dangling.length === 1, 'the unfunded cost is caught',
            JSON.stringify(dangling));
          c.ok(dangling[0]?.resource === 'Vigour', 'it names the missing resource');
        },
      },
      {
        id: 'emitters_agree',
        title: 'Every emitted format reports the same numbers as the engine',
        async run(c, { hb, sources }) {
          c.feature('homebrew', 'emitters', 'sheet');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Emit', '### Tough', 'At 3rd level, you gain Resistance to Cold damage.',
          ].join('\n\n'), { filename: 'e.md' })));
          brew.class = 'fighter';

          const level = 8;
          const data = hb.sheetData(brew, level, sources);
          const json = hb.sheetJson(brew, level, sources);
          const html = hb.sheetHtml(brew, level, sources);

          c.eq(json.ac, data.derived.ac, 'JSON AC matches the derived AC');
          // sheetJson emits hp as a plain number (the maximum), not an object.
          c.eq(json.hp, data.derived.hp.max,
            'JSON max HP matches the derived max HP');
          c.eq(json.proficiencyBonus, data.derived.proficiencyBonus,
            'JSON proficiency bonus matches the engine');
          c.eq(json.attacks.length, data.derived.attacks.length,
            'JSON lists every attack the engine derived');
          c.ok(html.includes(String(data.derived.ac)),
            'the HTML sheet prints the derived AC');
          c.ok(html.includes(String(data.derived.hp.max)),
            'the HTML sheet prints the derived max HP');
          c.ok(html.includes(brew.name), 'the HTML sheet is about the right subclass');

          const page = hb.emitHtml({ brew, coverage: { features: 1, live: 1 } });
          c.ok(page.includes('<!doctype html>') || page.includes('<!DOCTYPE html>'),
            'the emitted page is a complete document');
          c.ok(!/https?:\/\/(?!github\.com|creativecommons|www\.dndbeyond)/.test(
            page.replace(/<!--[\s\S]*?-->/g, '')),
          'the emitted page makes no external requests');
        },
      },
    ],
  },

  /* ---------------- combat engine ---------------------------------- */
  {
    id: 'combat',
    title: 'Combat engine',
    why: 'Attacks, crits, death saves and rests are the rules the app is '
       + 'trusted to get right. A wrong crit rule silently changes every '
       + 'balance number this project reports.',
    scenarios: [
      {
        id: 'castable_now',
        title: 'A spell is offered only when a slot could actually cast it',
        run(c, { engine }) {
          c.feature('combat', 'spells', 'slots');
          // The upcast rule, which the act bar asks BEFORE drawing a button
          // and castSpell asks when spending one. They were two copies of
          // this loop; a spell offered with no slot it can use is a button
          // whose only job is to answer "no slot high enough is left".
          const sc = (slotState) => ({ slots: [4, 3, 2], slotState });

          // Level 1 spent: a level 1 spell upcasts into the level 2 slot.
          c.eq(engine.slotForSpell(sc({ 1: 4, 2: 0, 3: 0 }), 1), 2,
            'a level 1 spell upcasts when its own slots are gone');
          c.eq(engine.slotForSpell(sc({ 1: 4, 2: 0, 3: 0 }), 3), 3,
            'and a level 3 spell still has its own');

          // Only level 1 left: nothing above it can be cast at all.
          c.eq(engine.slotForSpell(sc({ 1: 3, 2: 3, 3: 2 }), 1), 1,
            'a level 1 spell uses the level 1 slot it has');
          c.eq(engine.slotForSpell(sc({ 1: 3, 2: 3, 3: 2 }), 3), null,
            'a level 3 spell with only a level 1 slot left is NOT castable');

          // Nothing left: every levelled spell is out.
          const dry = sc({ 1: 4, 2: 3, 3: 2 });
          c.eq(engine.slotForSpell(dry, 1), null, 'no slots left, level 1 out');
          c.eq(engine.slotForSpell(dry, 3), null, 'no slots left, level 3 out');

          // Cantrips never consult this, and neither does a caster without
          // slots - both must answer null rather than throw.
          c.eq(engine.slotForSpell(sc({}), 0), null, 'level 0 is not a slot question');
          c.eq(engine.slotForSpell(null, 1), null, 'a non-caster does not crash');
          c.eq(engine.slotForSpell({ slots: [], slotState: {} }, 1), null,
            'a caster with no slot table is not offered levelled spells');
        },
      },
      {
        id: 'attack_resolution',
        title: 'Attack rolls hit, miss, crit and fumble by the book',
        run(c, { engine }) {
          c.feature('combat', 'attacks');
          const atk = { name: 'Longsword', attackBonus: 5, damage: '1d8',
            damageBonus: 3, damageTypes: ['slashing'] };
          // Force each outcome with a stub rng rather than rolling until it
          // happens - a test that waits for a 20 is a test that is sometimes
          // a different test. rollDie() only ever calls rng.die(sides).
          const fixed = (n) => ({ die: () => n, int: () => n - 1, float: () => 0.5,
            pick: (a) => a[0], stream() { return this; } });
          // The target is an OBJECT carrying ac, not a bare number.
          const crit = engine.resolveAttack(atk, { target: { ac: 10 }, rng: fixed(20) });
          c.ok(crit.crit, 'a natural 20 is a critical hit');
          c.ok(crit.hit, 'a critical hit hits regardless of AC');
          c.ok(crit.total > 0, 'a hit deals damage');

          const fumble = engine.resolveAttack(atk, { target: { ac: 1 }, rng: fixed(1) });
          c.ok(fumble.fumble, 'a natural 1 is a fumble');
          c.ok(!fumble.hit, 'a fumble misses even against AC 1');
          c.eq(fumble.total, 0, 'a miss deals no damage');

          const normal = engine.resolveAttack(atk, { target: { ac: 30 }, rng: fixed(10) });
          c.ok(!normal.hit, 'a 10 + 5 does not beat AC 30');
          c.ok(crit.events.some((e) => e.type === 'crit'),
            'a critical hit emits a crit event for the chronicle');
        },
      },
      {
        id: 'expected_damage_monotonic',
        title: 'Expected damage falls as target AC rises',
        run(c, { engine }) {
          c.feature('combat');
          const atk = { attackBonus: 5, damage: '1d8', damageBonus: 3 };
          const easy = engine.expectedDamage(atk, 10);
          const hard = engine.expectedDamage(atk, 20);
          c.ok(easy > hard, 'higher AC means less expected damage',
            `AC10 ${easy.toFixed(2)} vs AC20 ${hard.toFixed(2)}`);
          c.ok(easy > 0 && Number.isFinite(easy), 'expected damage is a finite number');
        },
      },
      {
        id: 'rests',
        title: 'Short and long rests restore the right things',
        run(c, { sources, engine }) {
          c.feature('combat', 'rests', 'resources');
          const ch = makeChar();
          const d = derive(ch, sources);
          const hurt = { ...ch, hp: { ...d.hp, current: 1 }, exhaustion: 2 };
          // Rests return {patch, events} - they never mutate the character.
          const long = engine.longRest(hurt, derive(hurt, sources));
          c.eq(long.patch.hp.current, d.hp.max, 'a long rest restores full HP');
          c.eq(long.patch.exhaustion, 1, 'a long rest removes one level of exhaustion');
          c.eq(long.patch.conditions.length, 0, 'a long rest clears conditions');
          c.ok(long.events.some((e) => e.type === 'rest_long'),
            'a long rest is recorded as an event');

          const short = engine.shortRest(hurt, derive(hurt, sources), { spendHitDice: 1 });
          c.ok(short.patch.hp.current >= 1, 'a short rest does not reduce HP');
          c.ok(short.patch.hp.current <= d.hp.max,
            'a short rest cannot exceed maximum HP');
        },
      },
      {
        id: 'death_saves',
        title: 'Death saves are bounded and reach a conclusion',
        run(c, { engine }) {
          c.feature('combat', 'death-saves');
          const rng = seededRng(11);
          const seen = new Set();
          for (let i = 0; i < 600; i += 1) {
            const r = engine.deathSave(rng);
            seen.add(r.outcome);
            c.ok(r.successes + r.failures <= 2,
              'a single death save never moves the track by more than two');
            if (c.failures.length) break;
          }
          // All four documented outcomes must be reachable, or a rule is dead.
          for (const outcome of ['revive', 'critical failure', 'success', 'failure']) {
            c.ok(seen.has(outcome), `death saves can produce "${outcome}"`);
          }
        },
      },
      {
        id: 'roll_tables',
        title: 'Roll tables use the die, not the entry count',
        run(c, { engine }) {
          c.feature('combat', 'tables');
          // A d20 table with 8 entries: entries 8+ must be far more likely
          // than 1/8 because every roll of 8-20 lands on the last row. Picking
          // an index instead of rolling the die would make it exactly 1/8.
          const table = { die: 'd20', name: 'gym',
            entries: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, text: `e${i + 1}` })) };
          const rng = seededRng(3);
          let last = 0;
          const N = 4000;
          for (let i = 0; i < N; i += 1) {
            if (engine.rollOnTable(table, rng).entry.n === 8) last += 1;
          }
          const share = last / N;
          c.ok(share > 0.5, 'a short d20 table concentrates on its last entry',
            `last entry came up ${(share * 100).toFixed(1)}% of the time`);
          c.ok(engine.rollOnTable(table, rng).short === true,
            'the table reports that it is shorter than its die');
        },
      },
    ],
  },

  /* ---------------- encounters -------------------------------------- */
  {
    id: 'encounters',
    title: 'Encounter construction',
    why: 'Encounters feed every simulated campaign. If they are malformed or '
       + 'unbounded, every downstream measurement inherits the fault.',
    scenarios: [
      {
        id: 'build',
        title: 'Encounters are built within bounds at every tier',
        run(c, { monsters, enc }) {
          c.feature('encounters');
          const rng = seededRng(21);
          for (const level of [1, 5, 11, 17]) {
            const e = enc.buildEncounter(monsters, [level, level, level, level], rng);
            c.ok(e.monsters.length >= 1, `level ${level}: at least one monster`);
            c.ok(e.monsters.length <= enc.MAX_MONSTERS_DEFAULT,
              `level ${level}: no more than the cap`,
              `got ${e.monsters.length}`);
            for (const m of e.monsters) {
              c.ok(m.hp > 0 && Number.isFinite(m.hp), `${m.name} has finite positive HP`);
              c.ok(Number.isFinite(m.ac), `${m.name} has a finite AC`);
            }
          }
        },
      },
      {
        id: 'monster_turn',
        title: 'Monsters act without producing impossible damage',
        run(c, { monsters, enc }) {
          c.feature('encounters', 'combat');
          const rng = seededRng(33);
          const e = enc.buildEncounter(monsters, [5, 5, 5, 5], rng);
          const party = [{ name: 'PC', hp: 40, hpMax: 40, ac: 16, saves: {} }];
          let turns = 0;
          for (const m of e.monsters) {
            const t = enc.monsterTurn(m, party, rng);
            turns += 1;
            for (const h of t.hits) {
              c.ok(h.amount >= 0 && Number.isFinite(h.amount),
                `${m.name} deals a finite non-negative amount`);
              c.ok(!!h.target, 'every hit names a target');
            }
          }
          c.ok(turns > 0, 'at least one monster took a turn');
        },
      },
    ],
  },

  /* ---------------- spells ------------------------------------------ */
  {
    id: 'spells',
    title: 'Spell mechanics',
    why: 'Half the classes are casters. The coverage gate only means something '
       + 'if the spells it calls executable genuinely execute.',
    scenarios: [
      {
        id: 'file_integrity',
        title: 'The extracted mechanics file is internally consistent',
        run(c, { mechanics, spells }) {
          c.feature('spells');
          const ids = Object.keys(mechanics);
          c.ok(ids.length > 300, 'mechanics exist for the whole SRD spell list',
            `${ids.length} entries`);
          const known = new Set(spells.map((s) => s.id));
          const orphans = ids.filter((id) => !known.has(id));
          c.eq(orphans.length, 0, 'every mechanic maps to a real spell');
          const executable = ids.filter((id) => mechanics[id].executable);
          c.ok(executable.length > 100, 'a substantial number are executable',
            `${executable.length} of ${ids.length}`);
        },
      },
      {
        id: 'executable_spells_execute',
        title: 'Spells marked executable actually resolve',
        run(c, { mechanics, spells, engine }) {
          c.feature('spells', 'combat');
          const rng = seededRng(77);
          const targets = [{ name: 'dummy', ac: 13, hp: 60, hpMax: 60, saves: {} }];
          let ran = 0;
          let failed = 0;
          for (const id of Object.keys(mechanics)) {
            const mech = mechanics[id];
            if (!mech.executable) continue;
            const spell = spells.find((s) => s.id === id);
            if (!spell) continue;
            try {
              const res = engine.resolveSpell(spell, mech, {
                caster: { saveDc: 15, attackBonus: 7, mod: 4 },
                targets, slotLevel: spell.level || null, rng,
              });
              ran += 1;
              if (!Number.isFinite(res.total ?? 0)) failed += 1;
            } catch { failed += 1; }
          }
          c.ok(ran > 100, 'a large sample of executable spells was resolved',
            `${ran} spells`);
          // The claim under test: "executable" is not decoration.
          c.eq(failed, 0, 'every executable spell resolved to a finite result');
        },
      },
    ],
  },

  /* ---------------- integration ------------------------------------- */
  {
    id: 'integration',
    title: 'Features working together',
    why: 'Each piece can be correct while the seams between them are not. '
       + 'These are the journeys a real user actually takes.',
    scenarios: [
      {
        id: 'metrics_are_measured_not_claimed',
        title: 'A measurement is recorded, a bad one is refused, and zero survives',
        run(c) {
          c.feature('gym', 'metrics');
          // A Check of its own, so asserting about failures does not fail US.
          const probe = new Check('probe');

          probe.metric('taps', 3, { unit: 'taps', of: 'q1' });
          c.eq(probe.metrics.get('taps@q1')?.value, 3, 'a reading is stored');
          c.eq(probe.passed, 0, 'measuring is not passing');
          c.eq(probe.failures.length, 0, 'and measuring is not failing');
          c.eq(probe.total, 0,
            'a scenario that only measures still asserted nothing');

          // The reading this whole channel exists to protect: already on
          // screen, nothing spent. A falsy-zero bug turns this into "no data".
          probe.metric('taps', 0, { of: 'already-visible' });
          c.eq(probe.metrics.get('taps@already-visible')?.value, 0,
            'zero is a reading, not an absence');

          // NaN must be refused loudly. A NaN that silently becomes 0 is how
          // a chart ends up lying about a screen nobody checked.
          const bad = probe.metric('taps', NaN, { of: 'broken' });
          c.eq(bad, null, 'a non-finite value is refused');
          c.ok(probe.failures.length === 1
            && /not a finite number/.test(probe.failures[0].label),
          'and it is refused LOUDLY, as a failure',
          JSON.stringify(probe.failures));
          c.ok(!probe.metrics.has('taps@broken'), 'nothing bad was stored');
          probe.metric('taps', Infinity, { of: 'also-broken' });
          c.eq(probe.failures.length, 2, 'Infinity is refused too');

          // `of` keeps rows for different subjects apart; without it one
          // scenario measuring 35 questions would report only the last.
          c.eq(probe.metrics.size, 2, 'each subject keeps its own row');

          // The aggregator: values kept whole, and a mean of nothing is null.
          const g = grade([{ id: 's', scenarios: [
            { id: 'a', total: 1, passed: 1, ok: true, failures: [], features: [],
              metrics: [{ name: 'taps', value: 0, unit: 'taps', of: 'x' },
                { name: 'taps', value: 4, unit: 'taps', of: 'y' }] },
          ] }]);
          c.eq(g.metrics.taps.n, 2, 'both readings counted');
          c.eq(g.metrics.taps.mean, 2, 'the zero is in the mean, not dropped');
          c.eq(g.metrics.taps.min, 0, 'min honours a legitimate zero');
          c.same(g.metrics.taps.values, [0, 4],
            'raw values survive, so a median and an IQR are still recoverable');
          c.ok(!g.bars.some((b) => b.id === 'taps'),
            'and a measurement gates NOTHING - BARS is the commit gate');
        },
      },
      {
        id: 'homebrew_to_sheet_to_sim',
        title: 'Homebrew flows ingest -> engine -> sheet -> simulation',
        async run(c, { hb, sources, sim, monsters, spells, mechanics }) {
          c.feature('integration', 'homebrew', 'sheet', 'simulation');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Integration Path',
            '### Frost Ward',
            'At 3rd level, you gain Resistance to Cold damage.',
            '### Rimeblade',
            'At 6th level, your weapon attacks deal an extra 1d6 Cold damage.',
          ].join('\n\n'), { filename: 'i.md' })));
          brew.class = 'fighter';

          // 1. the engine sees it
          const withBrew = { ...sources, homebrew: [brew] };
          const d = derive(makeChar({
            classes: [{ class: 'fighter', level: 6, subclass: brew.id }],
          }), withBrew);
          c.ok(d.resistances.includes('cold'), 'the brew reaches the derived sheet');

          // 2. the emitted sheet reports the same numbers
          const json = hb.sheetJson(brew, 6, sources);
          c.eq(json.ac, hb.sheetData(brew, 6, sources).derived.ac,
            'the exported sheet agrees with the engine');

          // 3. the simulator can run it
          const run = sim.runCampaign({
            classId: 'fighter', subclassId: brew.id, seed: 1,
            sources: withBrew, monsters, spells, mechanics, maxLevel: 6,
          });
          c.ok(Number.isFinite(run.metrics.stDpr), 'the simulation produces finite damage');
          c.ok(run.metrics.encounters > 0, 'the simulation actually fought something');
          c.eq(run.violations.length, 0, 'no invariant was violated during play',
            JSON.stringify(run.violations.slice(0, 2)));
        },
      },
      {
        id: 'campaign_determinism',
        title: 'The same seed reproduces a campaign exactly',
        run(c, { sources, sim, monsters, spells, mechanics }) {
          c.feature('integration', 'simulation', 'rng');
          const cfg = { classId: 'fighter', subclassId: null, seed: 4,
            sources, monsters, spells, mechanics, maxLevel: 8 };
          const a = sim.runCampaign(cfg);
          const b = sim.runCampaign(cfg);
          c.same(a.metrics, b.metrics, 'identical seeds give identical metrics');
          const d = sim.runCampaign({ ...cfg, seed: 5 });
          c.ok(JSON.stringify(d.metrics) !== JSON.stringify(a.metrics),
            'a different seed gives a different campaign');
        },
      },
      {
        id: 'reaction_ablation',
        title: 'A reaction changes the numbers only when it fires',
        run(c, { sources, sim, monsters, spells, mechanics }) {
          c.feature('integration', 'simulation', 'reactions');
          const mkBrew = (effects) => ({
            id: 'gym-react', name: 'Gym Reactor', class: 'fighter',
            ruleset: '2024',
            features: [{ id: 'f1', name: 'Stone Skin', level: 3,
              text: 'Gym fixture.', effects }],
          });
          const halver = mkBrew([{ type: 'reaction_option', name: 'Stone Skin',
            action: 'reaction', trigger: 'hit_by_attack',
            response: { kind: 'reduce_damage', halve: true } }]);
          const counter = mkBrew([{ type: 'reaction_option', name: 'Riposte',
            action: 'reaction', trigger: 'takes_damage',
            response: { kind: 'counterattack' } }]);
          const bare = mkBrew([{ type: 'narrative_only' }]);
          const run = (brew, seed) => sim.runCampaign({
            classId: 'fighter', subclassId: 'gym-react', seed,
            sources: { ...sources, homebrew: [brew] },
            monsters, spells, mechanics, maxLevel: 5,
          });

          for (const seed of [1, 2]) {
            const on = run(halver, seed);
            const off = run(bare, seed);
            c.ok(on.metrics.reactionsUsed > 0,
              `seed ${seed}: the halve-on-hit reaction fires`,
              `${on.metrics.reactionsUsed} uses`);
            c.eq(off.metrics.reactionsUsed, 0,
              `seed ${seed}: stripped, it cannot`);
            c.ok(on.metrics.damageTaken < off.metrics.damageTaken,
              `seed ${seed}: halving strictly lowers damage taken`,
              `${on.metrics.damageTaken} vs ${off.metrics.damageTaken}`);
          }

          const on2 = run(counter, 1);
          const off2 = run(bare, 1);
          c.ok(on2.metrics.damageDealt > off2.metrics.damageDealt,
            'a counterattack strictly raises damage dealt',
            `${on2.metrics.damageDealt} vs ${off2.metrics.damageDealt}`);

          c.same(run(halver, 1).metrics, run(halver, 1).metrics,
            'with a reaction in play, the same seed still reproduces exactly');
        },
      },
      {
        id: 'payload_weights',
        title: 'A feature action scores what it DOES, not that it happened',
        run(c, { sources, sim, monsters, spells, mechanics }) {
          c.feature('integration', 'simulation', 'payloads');
          c.eq(sim.featureControlScore({}), 1, 'acting at all is worth one');
          c.eq(sim.featureControlScore({ forcedMove: 15 }), 1.5,
            'a push is worth half a point more');
          c.eq(sim.featureControlScore({
            save: { ability: 'wis' }, conditions: ['frightened', 'prone'],
            forcedMove: 15,
          }), 4.5, 'save + two conditions + push = 4.5');

          // Twin brews, identical but for the payload: control must move.
          const mkBrew = (extra) => ({
            id: 'gym-payload', name: 'Gym Payload', class: 'fighter',
            ruleset: '2024',
            features: [{ id: 'f1', name: 'Warp Step', level: 3,
              text: 'Gym fixture.',
              effects: [{ type: 'action_option', name: 'Warp Step',
                action: 'bonus', cost: null, ...extra }] }],
          });
          const run = (brew) => sim.runCampaign({
            classId: 'fighter', subclassId: 'gym-payload', seed: 1,
            sources: { ...sources, homebrew: [brew] },
            monsters, spells, mechanics, maxLevel: 4,
          });
          const rich = run(mkBrew({
            save: { ability: 'wis', dc: 'spell' },
            conditions: ['frightened'], forcedMove: 15,
          }));
          const flat = run(mkBrew({}));
          // Policy scores feature actions identically regardless of payload
          // (bestAttackScore * 0.9), so both arms choose the same actions at
          // the same moments - only the per-use score differs. Strictness
          // is therefore deterministic, not probabilistic.
          c.ok(rich.metrics.control > flat.metrics.control,
            'the payload strictly raises measured control',
            `${rich.metrics.control} vs ${flat.metrics.control}`);
        },
      },
      {
        id: 'measure_smoke',
        title: 'measure() answers every axis, deterministically',
        run(c, { sources, monsters, spells, mechanics, vec }) {
          c.feature('simulation', 'vectors');
          const base = { sources, monsters, spells, mechanics, maxLevel: 3 };
          const a = vec.measure('fighter', null, base, 1);
          const b = vec.measure('fighter', null, base, 1);
          for (const ax of vec.AXES) {
            c.ok(Number.isFinite(a[ax]), `${ax} is a finite number`, String(a[ax]));
          }
          c.same(a, b, 'measuring twice gives the same numbers');
        },
      },
      {
        id: 'vectors_artifact_watchdog',
        title: 'The published corpus artifact stays internally sane',
        async run(c, { vec }) {
          c.feature('simulation', 'vectors');
          const v = await vec.loadVectors();
          if (!v) {
            // No artifact is an honest state (fresh clone) - what matters
            // is that the loader says so rather than inventing one.
            c.ok(true, 'no artifact on this server - the loader returned null');
            c.ok(v === null, 'null, not a fabricated shape');
            return;
          }
          c.same(v.axes, vec.AXES,
            'the artifact was built on the axes the code projects against');
          for (const ax of vec.AXES) {
            c.ok((v.stats?.[ax]?.sd ?? 0) > 0,
              `${ax} is alive - a dead axis separates nothing`);
          }
          const tie = v.diagnostics?.tieRate;
          c.ok(Number.isFinite(tie) && tie >= 0 && tie <= 1,
            `tieRate is recorded honestly (${tie})`);
          c.eq(v.vectors.length, v.counts.simulated + v.counts.cached,
            'every vector is accounted for');
        },
      },
      {
        id: 'play_persists',
        title: 'Damage taken in play survives a save, reload and re-derive',
        async run(c, { db, sources, engine }) {
          c.feature('integration', 'play', 'storage', 'derive');
          const ch = makeChar({ id: 'gym-journey' });
          const d0 = derive(ch, sources);
          const hit = engine.applyDamage(
            { hp: { current: d0.hp.max }, hpMax: d0.hp.max }, -11,
          );
          ch.hp = { ...d0.hp, current: hit.hp };
          await db.put('characters', ch);

          const back = await db.get('characters', ch.id);
          const d1 = derive(back, sources);
          c.eq(d1.hp.current, d0.hp.max - 11, 'the wound is still there after reload');
          c.eq(d1.hp.max, d0.hp.max, 'the maximum did not drift');

          // And re-deriving repeatedly must not heal it - the exact bug that
          // a stale stored maximum caused once already.
          const d2 = derive(derive(back, sources) && back, sources);
          c.eq(d2.hp.current, d0.hp.max - 11,
            're-deriving does not quietly restore hit points');
        },
      },
      {
        id: 'levelling',
        title: 'Levelling up raises HP and proficiency without losing play state',
        async run(c, { db, sources }) {
          c.feature('integration', 'derive', 'storage');
          const ch = makeChar({ id: 'gym-levelup',
            classes: [{ class: 'fighter', level: 4, subclass: null }] });
          const before = derive(ch, sources);
          ch.hp = { ...before.hp, current: before.hp.max - 5 };
          ch.conditions = ['frightened'];
          await db.put('characters', ch);

          const loaded = await db.get('characters', ch.id);
          loaded.classes = [{ class: 'fighter', level: 5, subclass: null }];
          const after = derive(loaded, sources);
          c.ok(after.hp.max > before.hp.max, 'levelling raises maximum HP');
          c.eq(after.proficiencyBonus, 3, 'level 5 raises proficiency to +3');
          c.eq(after.hp.current, before.hp.max - 5,
            'the wound carried over rather than being healed by levelling');
          c.ok(after.conditions.includes('frightened'), 'conditions survive levelling');
        },
      },
      {
        id: 'inventory_changes_ac',
        title: 'Equipping armour changes AC through the same engine',
        run(c, { sources, equipment }) {
          c.feature('integration', 'inventory', 'derive');
          // equipment is a DICT of categories (weapons / armor / gear), not a
          // flat list, and each armour's `ac` is prose like "11 + Dex modifier"
          // that derive() has to parse.
          const armours = equipment?.armor || [];
          c.ok(armours.length > 0, 'the compendium carries armour');
          const heavy = armours.find((a) => /chain mail|plate/i.test(a.name || ''));
          c.ok(!!heavy, 'a heavy armour exists to test with');
          if (!heavy) return;

          const naked = derive(makeChar(), sources);
          const armoured = derive(
            makeChar({ inventory: [{ ...heavy, equipped: true, qty: 1 }] }),
            sources,
          );
          c.ok(armoured.ac !== naked.ac, 'wearing armour changes AC',
            `naked ${naked.ac} vs ${heavy.name} ${armoured.ac}`);
          c.ok(armoured.ac >= 14, 'heavy armour produces a plausible AC',
            `${heavy.name} gave ${armoured.ac}`);
          c.ok(!!armoured.acSource, 'the sheet says WHERE the AC came from');
          c.ok(/\d/.test(String(heavy.ac)), 'armour AC is parsed from its prose value');
        },
      },
    ],
  },

  /* ---------------- DM tools --------------------------------------- */
  {
    id: 'dmtools',
    title: 'DM tools',
    why: 'These run a live session with no network. A loot table that can '
       + 'produce an illegal result, or a generator that is not reproducible '
       + 'from its seed, fails at the table where it cannot be debugged.',
    scenarios: [
      {
        id: 'hoards_are_legal',
        title: 'Hoards are legal and scale at every CR band',
        run(c, { tables, magicItems, dm }) {
          c.feature('dm', 'loot');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          let last = -1;
          for (const cr of [0, 2, 5, 9, 11, 15, 17, 24]) {
            const h = dm.loot.rollHoard({ tables, magicItems, cr, seed: 3 });
            c.ok(h.totalGp >= 0 && Number.isFinite(h.totalGp),
              `CR ${cr}: total is a finite non-negative number`, String(h.totalGp));
            c.ok(h.coins.every((x) => x.amount > 0),
              `CR ${cr}: no zero-coin entries`);
            c.ok(h.items.every((i) => i.name && i.rarity),
              `CR ${cr}: every magic item is a real item`);
            // Art objects are single pieces; two of one in a hoard is a bug.
            const art = h.valuables.filter((v) => v.kind === 'art').map((v) => v.name);
            c.eq(art.length, new Set(art).size, `CR ${cr}: no duplicated art object`);
            const ids = h.items.map((i) => i.id);
            c.eq(ids.length, new Set(ids).size, `CR ${cr}: no duplicated magic item`);
            last = h.totalGp;
          }
          c.ok(last > 0, 'the top band is worth something');
        },
      },
      {
        id: 'hoard_value_climbs',
        title: 'A higher CR is worth more, on average',
        run(c, { tables, magicItems, dm }) {
          c.feature('dm', 'loot');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          const mean = (cr) => {
            let sum = 0;
            for (let s = 0; s < 25; s += 1) {
              sum += dm.loot.rollHoard({ tables, magicItems, cr, seed: s }).totalGp;
            }
            return sum / 25;
          };
          // Averaged over 25 seeds: a single roll can invert by luck, and a
          // test that fails on luck is a test people learn to ignore.
          const low = mean(2); const mid = mean(9); const high = mean(18);
          c.ok(mid > low, 'CR 9 beats CR 2', `${mid.toFixed(0)} vs ${low.toFixed(0)}`);
          c.ok(high > mid, 'CR 18 beats CR 9', `${high.toFixed(0)} vs ${mid.toFixed(0)}`);
        },
      },
      {
        id: 'individual_is_smaller',
        title: 'One creature carries far less than a hoard',
        run(c, { tables, magicItems, dm }) {
          c.feature('dm', 'loot');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          const hoard = dm.loot.rollHoard({ tables, magicItems, cr: 8, seed: 4 });
          const one = dm.loot.rollHoard({
            tables, magicItems, cr: 8, seed: 4, individual: true });
          c.ok(one.totalGp < hoard.totalGp, 'a single creature is worth less',
            `${one.totalGp} vs ${hoard.totalGp}`);
          c.eq(one.items.length, 0, 'a single creature carries no magic item');
          c.ok(one.totalGp > 0, 'but is not worth literally nothing');
        },
      },
      {
        id: 'generators_reproduce',
        title: 'Every generator is reproducible from its seed',
        run(c, { tables, monsters, dm }) {
          c.feature('dm', 'generators');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          const a = dm.gen.rollAll(tables, monsters, { seed: 77, level: 5, terrain: 'forest' });
          const b = dm.gen.rollAll(tables, monsters, { seed: 77, level: 5, terrain: 'forest' });
          c.same(a, b, 'the same seed gives the same everything');
          const d = dm.gen.rollAll(tables, monsters, { seed: 78, level: 5, terrain: 'forest' });
          c.ok(JSON.stringify(d) !== JSON.stringify(a), 'a different seed differs');
        },
      },
      {
        id: 'generators_are_independent',
        title: 'Terrains do not share one stream',
        run(c, { tables, monsters, dm }) {
          c.feature('dm', 'generators');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          // Regression pin. seededRng(seed, label) does NOT mix the label in,
          // so every terrain once returned the same distance and the same
          // "wants to talk first" from one seed.
          const encs = dm.gen.TERRAINS.map((t) =>
            dm.gen.encounter(tables, monsters, { seed: 5, terrain: t, level: 6 }));
          const distances = new Set(encs.map((e) => e.distance));
          const doings = new Set(encs.map((e) => e.doing));
          c.ok(distances.size > 2, 'terrains differ on distance',
            `${distances.size} distinct across ${encs.length}`);
          c.ok(doings.size > 2, 'terrains differ on what it is doing',
            `${doings.size} distinct`);
        },
      },
      {
        id: 'terrain_is_plausible',
        title: 'Terrain exclusions keep crocodiles out of the arctic',
        run(c, { tables, monsters, dm }) {
          c.feature('dm', 'generators');
          if (!tables) { c.ok(false, 'dm-tables.json loaded'); return; }
          const names = [];
          for (let s = 0; s < 60; s += 1) {
            const e = dm.gen.encounter(tables, monsters,
              { seed: s, terrain: 'arctic', level: 8 });
            if (e.monsters[0]) names.push(e.monsters[0].name.toLowerCase());
          }
          c.ok(names.length > 20, 'the arctic produces encounters at all',
            `${names.length} of 60 seeds`);
          for (const banned of ['crocodile', 'camel', 'scorpion']) {
            c.ok(!names.some((n) => n.includes(banned)),
              `no ${banned} in the arctic`);
          }
        },
      },
      {
        id: 'a_fight_survives_its_own_roster_changing',
        title: 'Arrivals get a turn, departures do not steal one',
        run(c, { dm }) {
          c.feature('dm', 'runner', 'combat', 'initiative');
          const R = dm.runner;

          // Deploying a prepared encounter mid-fight is the whole point of
          // the drawer, and it used to add creatures with init:null that
          // sorted to the bottom and never acted.
          R.reset();
          R.addCustom({ name: 'A', ac: 10, hp: 10, initMod: 3 });
          R.addCustom({ name: 'B', ac: 10, hp: 10, initMod: 1 });
          R.rollInitiative();
          R.addCustom({ name: 'Ambusher', ac: 13, hp: 15, initMod: 2 });
          const late = R.state.combatants.find((x) => x.name === 'Ambusher');
          c.ok(late.init !== null,
            'a combatant admitted mid-fight rolls initiative', String(late.init));
          c.ok(R.state.combatants.every((x, i, all) => i === 0
            || (all[i - 1].init ?? -99) >= (x.init ?? -99)),
          'and lands in order rather than at the bottom',
          R.state.combatants.map((x) => `${x.name}:${x.init}`).join(' '));

          // state.turn is an INDEX, so anything that reorders or shortens
          // the list moves it onto somebody else unless carried by identity.
          R.reset();
          for (const n of ['A', 'B', 'C', 'D', 'E']) {
            R.addCustom({ name: n, ac: 10, hp: 10, initMod: 0 });
          }
          R.rollInitiative();
          R.state.turn = 3;
          const whose = R.state.combatants[3].id;
          R.remove(R.state.combatants[1].id);
          c.eq(R.state.combatants[R.state.turn]?.id, whose,
            'removing an earlier combatant leaves the turn where it was');

          // Admitting mid-fight re-sorts, which must not move it either.
          R.state.turn = R.state.combatants.findIndex((x) => x.id === whose);
          R.addCustom({ name: 'Late', ac: 10, hp: 10, initMod: 5 });
          c.eq(R.state.combatants[R.state.turn]?.id, whose,
            'and neither does somebody walking in');

          // All three constructors emit the same shape; addCustom did not,
          // so its side chip read "foe" and the first tap changed nothing.
          const custom = R.state.combatants.find((x) => x.name === 'Late');
          c.ok(custom.side === 'ally' || custom.side === 'enemy',
            'a custom combatant is born with a side', String(custom.side));
        },
      },
      {
        id: 'damage_type_reaches_the_engine',
        title: 'The ribbon can say "fire", so resistance can happen',
        run(c, { dm }) {
          c.feature('dm', 'runner', 'combat', 'resistance');
          const R = dm.runner;
          R.reset();
          R.addCustom({ name: 'Stone Thing', ac: 12, hp: 40, initMod: 0 });
          const it = R.state.combatants.at(-1);
          it.resistances = ['fire'];

          const before = it.hp;
          R.applyTo(it.id, -10, 'fire');
          c.eq(before - R.state.combatants.find((x) => x.id === it.id).hp, 5,
            'typed damage is halved against a resistance');

          // The model was never the problem. applyTo has always taken a
          // damageType; the ribbon passed two arguments and never one, so
          // mitigate() returned early on every hit in every fight ever run
          // while the docstring and README said resistance was applied.
          // Assert the CONTROL exists, because that was the missing half -
          // and untyped damage passing through unmitigated is correct, so
          // asserting on an untyped hit can never prove anything.
          const panel = R.runnerPanel({
            characters: [], sources: null, monsters: [], redraw: () => {},
          });
          const picker = panel.querySelector('select[aria-label^="Damage type"]');
          c.ok(!!picker, 'the ribbon offers a damage type');
          const offered = [...(picker?.options || [])].map((o) => o.value);
          c.ok(offered.includes('fire') && offered.includes(''),
            'including fire, and untyped as the default',
            offered.slice(0, 6).join(','));
        },
      },
      {
        id: 'encounter_runner',
        title: 'The runner tracks initiative, damage and rounds',
        run(c, { monsters, dm, sources }) {
          c.feature('dm', 'runner', 'combat');
          const R = dm.runner;
          R.reset();
          const goblin = monsters.find((m) => /^Goblin Warrior$/.test(m.name));
          const air = monsters.find((m) => /^Air Elemental$/.test(m.name));
          c.ok(!!goblin && !!air, 'the test monsters exist in the bestiary');
          if (!goblin || !air) return;

          R.addMonsters(goblin, 3);
          R.addMonsters(air, 1);
          c.eq(R.state.combatants.length, 4, 'four combatants were added');

          const names = R.state.combatants.map((x) => x.name);
          c.eq(names.length, new Set(names).size, 'every combatant has a distinct name');
          c.ok(names.includes('Goblin Warrior 1'),
            'multiples are numbered from one', names.join(', '));

          R.rollInitiative();
          c.ok(R.state.started && R.state.round === 1, 'the fight starts on round 1');
          const inits = R.state.combatants.map((x) => x.init);
          c.ok(inits.every((n, i) => i === 0 || inits[i - 1] >= n),
            'initiative is sorted descending', inits.join(','));

          // Resistance must be applied - it is what a hand-run fight forgets.
          const elem = R.state.combatants.find((x) => /Air Elemental/.test(x.name));
          c.ok(elem.resistances.includes('slashing'),
            'monster defences are parsed from the statblock',
            JSON.stringify(elem.resistances));
          const hp0 = elem.hp;
          const hit = R.applyTo(elem.id, -10, 'slashing');
          c.eq(hit.landed, 5, 'resistance halves the damage that lands');
          c.eq(hit.mitigation, 'resistant', 'and says so');
          c.eq(elem.hp, hp0 - 5, 'HP moves by the mitigated amount');

          // Unresisted damage is untouched.
          const gob = R.state.combatants.find((x) => /Goblin/.test(x.name));
          const g0 = gob.hp;
          R.applyTo(gob.id, -4, 'slashing');
          c.eq(gob.hp, g0 - 4, 'a creature without resistance takes it all');

          // Overkill floors at zero rather than going negative.
          R.applyTo(gob.id, -999, 'slashing');
          c.eq(gob.hp, 0, 'overkill floors at 0');

          const n = R.state.combatants.length;
          for (let i = 0; i < n; i += 1) R.nextTurn();
          c.eq(R.state.round, 2, 'a full cycle of turns advances the round');
          R.prevTurn();
          c.eq(R.state.round, 1, 'stepping back returns to the previous round');

          R.toggleCondition(gob.id, 'Prone');
          c.ok(gob.conditions.includes('Prone'), 'conditions apply');
          R.toggleCondition(gob.id, 'Prone');
          c.ok(!gob.conditions.includes('Prone'), 'and toggle off');

          R.reset();
          c.eq(R.state.combatants.length, 0, 'clearing empties the fight');
        },
      },
      {
        id: 'party_dashboard',
        title: 'The party view agrees with each character sheet',
        run(c, { sources, dm }) {
          c.feature('dm', 'party');
          const ch = makeChar({ id: 'gym-party', name: 'Scout',
            classes: [{ class: 'ranger', level: 5, subclass: null }],
            skills: ['perception', 'insight'] });
          const row = dm.party.partyRow(ch, sources);
          const d = derive(ch, sources);
          c.eq(row.ac, d.ac, 'AC matches the sheet');
          c.eq(row.hp.max, d.hp.max, 'max HP matches the sheet');
          c.eq(row.level, d.level, 'level matches the sheet');
          // The DM's passive Perception must be the player's passive
          // Perception - two routes to one number is how they drift apart.
          c.eq(row.perception, d.passivePerception,
            'passive Perception matches derive()');
          c.ok(row.perception >= 10, 'passive scores are at least 10');
          c.ok(Number.isFinite(row.saves.dex), 'saves are finite numbers');
        },
      },
    ],
  },

  /* ---------------- custom content --------------------------------- */
  {
    id: 'content',
    title: 'Custom content parsing',
    why: 'A DM dropping a bestiary should get their monsters. A parser that '
       + 'silently returns a half-empty statblock, or confidently parses a '
       + 'section heading, is worse than one that refuses.',
    scenarios: [
      {
        id: 'statblock_roundtrip',
        title: 'Every bundled monster survives render and re-parse',
        run(c, { monsters, content }) {
          c.feature('content', 'parser', 'monsters');
          // The strongest test available: render all 330 real monsters to
          // statblock text, read them back, and require the numbers to match.
          // A fixture proves the parser handles the fixture; this proves it
          // handles the corpus.
          const bad = { ac: 0, hp: 0, cr: 0, abilities: 0, sections: 0, notOk: 0 };
          let first = null;
          for (const m of monsters) {
            const r = content.parseStatblock(content.renderStatblock(m), { name: m.name });
            if (!r.ok) { bad.notOk += 1; first = first || `${m.name}: not ok`; }
            if (r.record.ac !== m.ac) { bad.ac += 1; first = first || `${m.name}: AC`; }
            if (r.record.hp !== m.hp) { bad.hp += 1; first = first || `${m.name}: HP`; }
            if (r.record.cr !== m.cr) { bad.cr += 1; first = first || `${m.name}: CR`; }
            for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
              const a = m.abilities?.[k]; const b = r.record.abilities?.[k];
              if (a && (!b || b.score !== a.score || b.mod !== a.mod)) {
                bad.abilities += 1; first = first || `${m.name}.${k}`; break;
              }
            }
            for (const sec of ['traits', 'actions', 'bonusActions',
              'reactions', 'legendaryActions']) {
              if ((m[sec] || []).length !== (r.record[sec] || []).length) {
                bad.sections += 1; first = first || `${m.name}.${sec}`; break;
              }
            }
          }
          c.ok(monsters.length > 300, 'the whole bestiary was tested',
            `${monsters.length} monsters`);
          c.eq(bad.notOk, 0, 'every statblock parses', first || '');
          c.eq(bad.ac, 0, 'AC survives the round trip', first || '');
          c.eq(bad.hp, 0, 'hit points survive', first || '');
          c.eq(bad.cr, 0, 'challenge rating survives', first || '');
          c.eq(bad.abilities, 0, 'every ability score and modifier survives', first || '');
          c.eq(bad.sections, 0, 'traits and actions survive with the right count',
            first || '');
        },
      },
      {
        id: 'containers_refused',
        title: 'A section heading is refused, not parsed',
        run(c, { content }) {
          c.feature('content', 'parser');
          // The failure this guards: "Spell Descriptions" holding five spells
          // parsed as ONE spell with 100% coverage, because the first spell's
          // fields were sitting right there to be found.
          const body = [
            'Casting Time: 1 action', 'Range: 60 feet', 'Components: V, S',
            'Duration: Instantaneous', 'A bolt of fire leaps out.',
            'Casting Time: 1 bonus action', 'Range: Self',
            'Components: V', 'Duration: 1 minute', 'You grow wings.',
          ].join('\n');
          const asContainer = content.parseContent('spell', body,
            { name: 'Spell Descriptions' });
          c.ok(!asContainer.ok, 'a heading does not parse as a record');
          c.ok(asContainer.container, 'and is reported AS a container');
          c.eq(asContainer.coverage, 0,
            'a refused container claims no coverage at all');

          for (const junk of ['ACTIONS', 'Armor Class 18', 'STR DEX CON INT WIS CHA',
            'Components: V, S', 'Duration: Instantaneous']) {
            const r = content.parseContent('monster', 'Armor Class 12\nHit Points 9',
              { name: junk });
            c.ok(r.container, `"${junk}" is refused as a fragment`);
          }

          // Multiple records in one block is refused even with a real name.
          const multi = content.parseContent('spell', body, { name: 'Fire Bolt' });
          c.ok(multi.container, 'two spells in one block is refused');
        },
      },
      {
        id: 'coverage_is_honest',
        title: 'Coverage names what is missing',
        run(c, { content }) {
          c.feature('content', 'coverage');
          const partial = content.parseStatblock(
            'Armor Class 15\nHit Points 30 (4d8+12)\nSTR 10 +0 +0',
            { name: 'Half A Monster' });
          c.ok(partial.coverage < 1, 'an incomplete statblock does not claim 100%',
            String(partial.coverage));
          c.ok(partial.missing.includes('speed'), 'and says speed is missing',
            partial.missing.join(','));
          c.ok(partial.missing.includes('cr'), 'and challenge rating');

          const full = content.parseStatblock(
            ['Armor Class 15', 'Hit Points 30 (4d8+12)', 'Speed 30 ft.',
              'STR 10 +0 +0', 'DEX 12 +1 +1', 'CON 14 +2 +2',
              'INT 8 -1 -1', 'WIS 10 +0 +0', 'CHA 8 -1 -1',
              'Challenge 2 (XP 450; PB +2)'].join('\n'),
            { name: 'Whole Monster' });
          c.eq(full.coverage, 1, 'a complete statblock reports 100%');
          c.eq(full.missing.length, 0, 'with nothing missing');
        },
      },
      {
        id: 'spells_and_items',
        title: 'Spells and magic items parse their own fields',
        run(c, { content }) {
          c.feature('content', 'parser', 'spells');
          const spell = content.parseSpell([
            'Guiding Hand', '2nd-level divination',
            'Casting Time: 1 action', 'Range: Self',
            'Components: V, S, M (a compass)',
            'Duration: Concentration, up to 1 hour',
            'You know the direction of a place you name.',
          ].join('\n'), { name: 'Guiding Hand' });
          c.ok(spell.ok, 'the spell parses');
          c.eq(spell.record.level, 2, 'its level is read');
          c.eq(spell.record.school, 'divination', 'its school is read');
          c.ok(spell.record.concentration, 'concentration is detected');
          c.eq(spell.coverage, 1, 'with full coverage');

          const cantrip = content.parseSpell(
            'Spark\nEvocation cantrip\nCasting Time: 1 action\nRange: 30 feet\n'
            + 'Components: V\nDuration: Instantaneous\nA spark leaps.',
            { name: 'Spark' });
          // School-first phrasing broke the SRD converter once already.
          c.eq(cantrip.record.level, 0, 'a cantrip reads as level 0');
          c.eq(cantrip.record.school, 'evocation', 'school-first phrasing is handled');

          const item = content.parseMagicItem([
            'Glamerweave', 'Wondrous item, common',
            'This cloth garment is embroidered with moving images.',
          ].join('\n'), { name: 'Glamerweave' });
          c.ok(item.ok, 'the item parses');
          c.eq(item.record.rarity, 'Common', 'rarity is read');
          c.ok(!item.record.attunement, 'attunement is absent when not stated');

          const attuned = content.parseMagicItem(
            'Ring of Sight\nRing, rare (requires attunement by a druid)\nYou see far.',
            { name: 'Ring of Sight' });
          c.ok(attuned.record.attunement, 'attunement is detected');
          c.ok(/druid/i.test(attuned.record.attunementNote || ''),
            'and by whom', attuned.record.attunementNote || '');
        },
      },
      {
        id: 'custom_never_shadows_srd',
        title: 'Custom content adds to the compendium without replacing it',
        async run(c, { db, content, monsters }) {
          c.feature('content', 'storage');
          // A homebrew goblin must not quietly become THE goblin that the
          // encounter builder, the simulator and every saved encounter mean.
          const clash = monsters[0];
          await db.put('custom-monsters', {
            id: clash.id, name: `${clash.name} (mine)`, ac: 99, hp: 1,
            abilities: {}, cr: 0, custom: true,
          });
          const merged = await content.compendiumWithCustom('monsters');
          const original = merged.filter((m) => m.id === clash.id);
          c.eq(original.length, 1, 'the SRD record keeps its id, uniquely');
          c.eq(original[0].ac, clash.ac, 'and its own numbers');
          const mine = merged.find((m) => m.name === `${clash.name} (mine)`);
          c.ok(!!mine, 'the custom record is still present');
          c.ok(mine.id !== clash.id, 'under a different id', mine.id);
          c.ok(mine.custom === true, 'and badged as custom');
          await db.del('custom-monsters', mine.id.replace(/-custom$/, ''));
        },
      },
    ],
  },

  /* ---------------- release ---------------------------------------- */
  {
    id: 'release',
    title: 'Release',
    why: 'For ninety-nine commits the app said v1.0 everywhere it said '
       + 'anything, while the changelog-shaped truth lived only in commit '
       + 'titles. A version is a claim the app makes about itself, and a '
       + 'claim made in four places is four chances to lie.',
    scenarios: [
      {
        id: 'version_agrees_everywhere',
        title: 'One version, stated the same way everywhere it is stated',
        why: 'VERSION at the root is the truth. app/version.js is what the '
           + 'browser says, /api/health is what the server says, and the '
           + 'service worker cache name is what installed phones keep - a '
           + 'bump that forgets the cache name ships the old app to every '
           + 'installed device under the new number. run.py --check covers '
           + 'the CHANGELOG half, which the gym cannot reach from app/.',
        async run(c, { version }) {
          c.feature('version');
          const v = version.VERSION;
          c.ok(/^\d+\.\d+\.\d+$/.test(String(v)),
            'the app states a semantic version', String(v));
          const health = await fetch('/api/health').then((r) => r.json())
            .catch(() => ({}));
          c.eq(health.version, v, 'the server states the same one');
          const sw = await fetch('/sw.js').then((r) => r.text()).catch(() => '');
          c.ok(sw.includes(`'toon-anvil-v${v}'`),
            'and the offline cache is named for it, so a bump busts the cache');
        },
      },
    ],
  },

  /* ---------------- connectors ------------------------------------- */
  {
    id: 'connectors',
    title: 'Optional connectors',
    why: 'These are the only part of the app that can reach the network. The '
       + 'property worth testing is not that they work - it is that the app '
       + 'is unharmed when they do not.',
    scenarios: [
      {
        id: 'catalogue_is_a_menu_not_an_advert',
        title: 'Every capability names a real provider, and a built one has code',
        why: 'The catalogue is what a person reads BEFORE putting a credential in a file. '
           + 'The transport has been finished far longer than anything plugged into it, so '
           + 'the temptation is to list what it could do rather than what it does. A row '
           + 'marked built with no code behind it is not an oversight, it is an advert.',
        async run(c) {
          c.feature('connectors', 'catalogue', 'cost');
          const caps = await fetch('/api/providers').then((r) => r.json());
          const cat = caps.capabilities || [];
          c.ok(cat.length > 0, 'the catalogue reaches the browser', String(cat.length));
          c.ok(Boolean(caps.pricesAsOf),
            'and it carries the date its prices came from - a figure with no date is a figure nobody can check');

          const known = new Set(Object.keys(caps.providers || {}));
          for (const cap of cat) {
            c.ok((cap.providers || []).every((p) => known.has(p)),
              `${cap.id} names only providers that exist`, JSON.stringify(cap.providers));
            c.ok(['built', 'planned'].includes(cap.status),
              `${cap.id} says whether it exists`, String(cap.status));
            c.ok(typeof cap.insteadOf === 'string' && cap.insteadOf.length > 20,
              `${cap.id} says what already works without a key`);
            // A user-content capability offered on a hosted provider would
            // break the promise the README makes unconditionally. This check
            // caught read_aloud on its first run: the row was marked as
            // carrying your writing AND offered on ElevenLabs, because there
            // is no local voice model. The rule did not bend - the row moved
            // to the not-offered list, where it says why.
            if (cap.contentClass === 'user') {
              c.same(cap.providers, ['ollama'],
                `${cap.id} carries the user's writing, so it is local-only`);
            }
          }

          // Everything the app can spend on must be IN the catalogue, or the
          // ledger has an unnamed row and the privacy rule has a hole. The
          // internal flag keeps such rows off the menu without exempting them
          // from either.
          const ids = new Set(cat.map((x) => x.id));
          const menu = cat.filter((x) => !x.internal);
          c.ok(menu.length > 0, 'the menu is not entirely internal rows',
            `${menu.length} of ${cat.length}`);
          c.ok(ids.has('connector_test'),
            'even the Test button names a capability, so its cost is not a blank row');

          // The anti-advert check: fetch the app's own source and look for
          // the capability id. A row cannot claim to be built unless some
          // module actually asks for it by name.
          const SOURCES = ['/modes/dm/panels.js', '/modes/settings/settings.js',
            '/modes/sheet/sheet.js', '/modes/dm/deck.js'];
          const src = (await Promise.all(SOURCES.map((u) => fetch(u)
            .then((r) => (r.ok ? r.text() : '')).catch(() => '')))).join(' ');
          for (const cap of cat.filter((x) => x.status === 'built')) {
            c.ok(src.includes(`'${cap.id}'`) || src.includes(`"${cap.id}"`),
              `${cap.id} is marked built and a module really asks for it`);
          }

          // And the estimate must be a number or an honest absence - never
          // a zero standing in for 'we could not work it out', because zero
          // is a claim that something is free.
          for (const cap of cat) {
            for (const [pid, v] of Object.entries(cap.estCents || {})) {
              c.ok(v === null || Number.isFinite(v),
                `${cap.id}/${pid} costs a number or says nothing`, String(v));
            }
          }
        },
      },
      {
        id: 'degrade_cleanly',
        title: 'Nothing configured is a clean answer, not an exception',
        async run(c, { providers }) {
          c.feature('connectors');
          // Every one of these sits beside something that already works
          // offline. A thrown error would take the working thing down with it,
          // so failure has to be a VALUE.
          const calls = [
            ['generateText', () => providers.generateText({ prompt: 'hello' })],
            ['generateImage', () => providers.generateImage({ prompt: 'a door' })],
            ['searchSounds', () => providers.searchSounds({ query: 'rain' })],
            ['generateSound', () => providers.generateSound({ prompt: 'a bell' })],
          ];
          for (const [name, fn] of calls) {
            let res = null;
            let threw = false;
            try { res = await fn(); } catch { threw = true; }
            c.ok(!threw, `${name} does not throw when unconfigured`);
            c.ok(res && typeof res.ok === 'boolean',
              `${name} returns a result object`);
            if (res && !res.ok) {
              c.ok(typeof res.reason === 'string' && res.reason.length > 10,
                `${name} explains why in words`, res.reason);
            }
          }
        },
      },
      {
        id: 'empty_input_refused',
        title: 'An empty prompt is refused without a network call',
        async run(c, { providers }) {
          c.feature('connectors');
          for (const [name, res] of [
            ['text', await providers.generateText({ prompt: '   ' })],
            ['image', await providers.generateImage({ prompt: '' })],
            ['search', await providers.searchSounds({ query: '' })],
          ]) {
            c.ok(!res.ok, `${name}: empty input is refused`);
            c.ok(!/server|fetch/i.test(res.reason || ''),
              `${name}: refused locally rather than by asking`, res.reason);
          }
        },
      },
      {
        id: 'capabilities_never_leak',
        title: 'Capability reporting never carries a key',
        async run(c, { providers }) {
          c.feature('connectors', 'security');
          const caps = await providers.capabilities({ refresh: true });
          c.ok(typeof caps === 'object', 'capabilities returns an object');
          const blob = JSON.stringify(caps);
          // The whole design is that the browser learns WHETHER, never WHAT.
          c.ok(!/sk-[A-Za-z0-9]/.test(blob), 'no OpenAI-shaped key');
          c.ok(!/sk-ant-/.test(blob), 'no Anthropic-shaped key');
          c.ok(!/"(?:apiKey|api_key|key|token|secret)"\s*:\s*"[^"]{12,}"/i.test(blob),
            'no field that looks like a credential');
          for (const p of Object.values(caps.providers || {})) {
            c.ok(typeof p.configured === 'boolean',
              `${p.label}: reports only whether it is configured`);
          }
        },
      },
      {
        id: 'local_ambience',
        title: 'Ambience needs no key and no network',
        run(c, { providers }) {
          c.feature('connectors', 'sfx');
          const ids = Object.keys(providers.BEDS);
          c.ok(ids.length >= 4, 'several beds are offered', ids.join(', '));
          for (const [id, bed] of Object.entries(providers.BEDS)) {
            c.ok(typeof bed.label === 'string' && bed.label.length > 2,
              `${id} has a readable name`);
            c.ok(bed.gain > 0 && bed.gain < 0.5,
              `${id} is mixed at a sane level`, String(bed.gain));
          }
          const bad = providers.playBed('no-such-bed');
          c.ok(!bad.ok, 'an unknown bed is refused rather than thrown');
        },
      },
      {
        id: 'audio_is_off_until_asked',
        title: 'Sound is a choice this device makes, and a framed copy never makes it',
        why: 'Five phones chiming at once is a problem, and a test frame that '
           + 'chimes is a worse one. The rule is pure so it can be stated '
           + 'here in full: nothing stored means off; on means on; and a '
           + 'framed copy of the app is silent whatever is stored - which is '
           + 'what keeps every gym iframe mute with no stub at all.',
        run(c, { audio }) {
          c.feature('audio');
          c.eq(audio.resolveEnabled(null, false), false, 'nothing stored means off');
          c.eq(audio.resolveEnabled('off', false), false, 'anything but on means off');
          c.eq(audio.resolveEnabled('on', false), true, 'on means on');
          c.eq(audio.resolveEnabled('on', true), false,
            'but a framed app is silent whatever is stored');
          c.eq(audio.context(), null,
            'and nothing in this gym has constructed an audio context');
          c.eq(audio.master(), null, 'nor a master gain');
        },
      },
    ],
  },

  /* ---------------- the table -------------------------------------- */
  {
    id: 'pregen',
    title: 'Quick party pregens',
    why: 'A pregen with an illegal skill or a ghost item is a trap that '
       + 'springs mid-session, the first time a player taps the thing. '
       + 'Forged heroes must be table-grade: born complete (their identity '
       + 'fields freeze at the claim), rules-legal, armed, and deterministic '
       + 'so a party can be rerolled by seed.',
    scenarios: [
      {
        id: 'pregen_party_is_table_grade',
        title: 'Every forged hero is complete, legal, and derivable',
        async run(c, { pregen, sources, spells }) {
          c.feature('pregen', 'table', 'derive');
          const src = { ...sources, spells };
          const party = pregen.forgeParty(8, src, 7);
          c.eq(party.length, 8, 'eight recipes forge eight heroes');

          const ABILITY_WORDS = { str: 'strength', dex: 'dexterity',
            con: 'constitution', int: 'intelligence', wis: 'wisdom',
            cha: 'charisma' };
          const sortedArray = [...pregen.STANDARD_ARRAY]
            .sort((a, b) => a - b).join(',');
          const parseChoices = (s) => {
            const m = /choose\s+(?:any\s+)?(\d+)/i.exec(s || '');
            const after = (String(s || '').split(':')[1] || '');
            return {
              count: m ? Number(m[1]) : 0,
              list: after.split(/,|\bor\b/).map((x) => x.trim())
                .filter((x) => /^[A-Z]/.test(x)),
            };
          };
          const bgSkills = (bg) => String(bg?.skillProficiencies || '')
            .split(/\s+and\s+|,/i).map((s) => s.trim()).filter(Boolean);

          for (const hero of party) {
            const who = hero.pregen;
            const recipe = pregen.RECIPES.find((r) => r.id === who);
            const cls = (sources.classes || [])
              .find((x) => x.id === hero.classes[0].class);
            const bg = (sources.backgrounds || [])
              .find((b) => b.id === hero.background);

            c.eq(Object.values(hero.abilities).sort((a, b) => a - b).join(','),
              sortedArray, `${who}: abilities are the standard array`);
            c.eq(hero.abilityMethod, 'array', `${who}: and say so`);
            c.ok(!('ownerId' in hero),
              `${who}: born unclaimed - ownerId absent, not null`);
            c.ok(!!(sources.species || []).find((s) => s.id === hero.species),
              `${who}: a real species`, hero.species);
            c.ok(!!bg, `${who}: a real background`, hero.background);

            // 2024 rules: the +2/+1 must come from the background's three.
            const legalAbs = String(bg?.abilityScores || '').toLowerCase();
            for (const [ab, v] of Object.entries(hero.abilityBonuses || {})) {
              c.ok(legalAbs.includes(ABILITY_WORDS[ab]),
                `${who}: +${v} ${ab} is on the ${hero.background} list`,
                legalAbs);
            }

            const { count, list } = parseChoices(cls?.skillChoices);
            c.ok(recipe.skills.length <= count,
              `${who}: takes no more class skills than offered`,
              `${recipe.skills.length} of ${count}`);
            if (list.length) {
              for (const sk of recipe.skills) {
                c.ok(list.includes(sk),
                  `${who}: "${sk}" is on the class skill list`);
              }
            }
            for (const sk of bgSkills(bg)) {
              c.ok(hero.skills.includes(sk),
                `${who}: background skill ${sk} carried`);
            }

            const conTotal = hero.abilities.con
              + (hero.abilityBonuses.con || 0);
            const wantHp = (cls?.hitDie || 8)
              + Math.floor((conTotal - 10) / 2);
            c.eq(hero.hp.max, wantHp, `${who}: level-1 HP formula`);
            const d = derive(hero, src);
            c.eq(d.hp.max, hero.hp.max,
              `${who}: derive() agrees with the stored maximum`);
            c.eq(d.proficiencyBonus, 2, `${who}: proficiency +2 at level 1`);
            c.ok(d.ac >= 10, `${who}: an AC`, String(d.ac));

            const wantKit = [recipe.kit.weapon, recipe.kit.armor,
              recipe.kit.shield ? 'Shield' : null].filter(Boolean);
            const got = hero.inventory.map((i) => i.name);
            for (const item of wantKit) {
              c.ok(got.includes(item),
                `${who}: ${item} resolved from the SRD`, got.join(', '));
            }
            c.ok(hero.inventory.every((i) => i.qty === 1 && i.equipped),
              `${who}: the kit arrives equipped`);

            if (recipe.spells) {
              const ids = new Set((spells || []).map((s) => s.id));
              c.ok(hero.spells.prepared.length >= 1,
                `${who}: a caster arrives with spells prepared`);
              for (const id of [...hero.spells.prepared, ...hero.spells.known]) {
                c.ok(ids.has(id), `${who}: spell "${id}" is real`);
              }
              // The anti-rot pair: a renamed SRD id must FAIL here, not
              // silently thin the spellbook.
              c.eq(hero.spells.prepared.length, recipe.spells.prepared.length,
                `${who}: every curated prepared spell resolved`);
              c.eq(hero.spells.known.length, recipe.spells.known.length,
                `${who}: every curated cantrip resolved`);
            }
          }
        },
      },
      {
        id: 'pregen_same_seed_same_bytes',
        title: 'Same seed, same party - byte for byte',
        async run(c, { pregen, sources, spells }) {
          c.feature('pregen');
          const src = { ...sources, spells };
          const a = JSON.stringify(pregen.forgeParty(4, src, 42));
          c.ok(a === JSON.stringify(pregen.forgeParty(4, src, 42)),
            'same seed, byte-identical party');
          c.ok(a !== JSON.stringify(pregen.forgeParty(4, src, 43)),
            'a new seed rerolls the party');
          const names = pregen.forgeParty(8, src, 5).map((h) => h.name);
          c.eq(new Set(names).size, names.length,
            'no two heroes in one forge share a name', names.join(', '));
        },
      },
    ],
  },
  {
    id: 'clocks',
    title: 'Clocks: pressure that advances with the day',
    why: 'A clock is a promise with a countdown. If it can overfill, tick '
       + 'twice, or strike again once struck, the DM is holding a lie about '
       + 'when the ritual completes - and the players are watching a '
       + 'progress bar that means nothing.',
    scenarios: [
      {
        id: 'clock_ticks_are_bounded_and_strike_once',
        title: 'Segments clamp, and the strike happens exactly once',
        async run(c, { campaign, events }) {
          c.feature('clocks', 'world');
          const clock = campaign.newClock('The ritual completes', 6);
          c.eq(clock.filled, 0, 'a new clock starts empty');
          c.eq(clock.size, 6, 'with the size it was given');
          c.ok(!clock.public && !clock.advanceOnDay,
            'and is secret and manual until the DM says otherwise');
          c.eq(campaign.newClock('x', 99).size, 12,
            'an absurd size is clamped to something drawable');

          c.eq(campaign.tickClock(clock, 2).filled, 2, 'ticking fills');
          c.eq(campaign.tickClock(clock, -5).filled, 0,
            'winding back stops at empty, never negative');
          c.eq(campaign.tickClock(clock, 99).filled, 6,
            'and forward stops at full');

          // The day carries only the clocks tied to it.
          const daily = { ...campaign.newClock('Siege', 3), advanceOnDay: true };
          const manual = campaign.newClock('Debt', 3);
          let list = [daily, manual];
          let out = campaign.advanceDayClocks(list);
          c.eq(out.clocks[0].filled, 1, 'a daily clock ticks with the day');
          c.eq(out.clocks[1].filled, 0, 'a manual one does not');
          c.eq(out.struck.length, 0, 'and nothing struck yet');

          out = campaign.advanceDayClocks(out.clocks);
          out = campaign.advanceDayClocks(out.clocks);
          c.eq(out.struck.length, 1, 'the last segment strikes');
          c.eq(out.struck[0].label, 'Siege', 'naming the clock that landed');
          const again = campaign.advanceDayClocks(out.clocks);
          c.eq(again.struck.length, 0, 'a full clock never strikes twice');
          c.eq(again.clocks[0].filled, 3, 'and never overfills');

          // A record from before clocks existed advances without inventing.
          list = campaign.advanceDayClocks(undefined);
          c.eq(list.clocks.length, 0, 'a campaign with no clocks is fine');

          c.ok(!!events.EVENT_TYPES.clock_advanced,
            'the strike has an event type');
          c.ok(events.EVENT_TYPES.clock_advanced.notable,
            'and it is notable - the Chronicle wants the moment');
        },
      },
    ],
  },
  {
    id: 'dicefeed',
    title: 'The shared dice feed',
    why: 'Roll events reach every seat at the table. The allowlist at the '
       + 'source is the wall between "Pip rolled a 19" and whatever a screen '
       + 'was trusted to keep quiet - and the rail must read the stream '
       + 'without inventing rows.',
    scenarios: [
      {
        id: 'roll_events_are_typed_and_clean',
        title: 'A roll event carries the die and nothing else',
        async run(c, { events, dicerail }) {
          c.feature('dicefeed', 'events');
          c.ok(!!events.EVENT_TYPES.roll, 'the roll type exists');
          c.ok(!events.EVENT_TYPES.roll.notable,
            'and is not notable - the Chronicle tells the story, not the '
            + 'arithmetic');

          const dirty = { kind: 'check', label: 'Stealth', faces: [14],
            nat: 14, total: 19, advantage: false, disadvantage: false,
            crit: false, fumble: false,
            targetAc: 15, secretNote: 'the lich is the mayor' };
          const clean = dicerail.safeRollPayload(dirty);
          c.ok(!('targetAc' in clean) && !('secretNote' in clean),
            'unexpected keys are dropped at the source');
          c.eq(Object.keys(clean).length, 9,
            'exactly the allow-listed nine survive');

          const seen = [];
          const un = events.subscribe((ev) => seen.push(ev));
          await events.log('roll', clean);
          un();
          c.eq(seen.length, 1, 'the event lands');
          c.eq(seen[0].type, 'roll', 'typed roll');
          c.eq(seen[0].cat, 'combat', 'filed under combat');

          const rows = dicerail.rollRows([
            { id: 'a', type: 'roll', characterId: 'ch1',
              payload: { label: 'Stealth', total: 19 } },
            { id: 'b', type: 'journal', characterId: 'ch1', payload: {} },
            { id: 'x', type: 'roll', characterId: 'zz',
              payload: { label: 'WIS save', total: 7, fumble: true } },
          ], [{ id: 'ch1', name: 'Pip' }]);
          c.eq(rows.length, 2, 'only roll events reach the rail');
          c.eq(rows[0].label, 'WIS save', 'newest first');
          c.eq(rows[0].who, 'Someone', 'an unknown roller stays anonymous');
          c.eq(rows[1].who, 'Pip', 'a known roller is named');
          c.ok(rows[0].fumble && !rows[0].crit, 'the flags ride along');

          // The rail is THIS table's dice, not the log's. Found at a real
          // table: the append-only log outlives a session, so the rail
          // opened showing last session's rolls - and rolls by characters
          // who no longer existed, all reading "Someone".
          const dated = [
            { id: 'old', type: 'roll', ts: '2026-08-09T20:00:00.000Z',
              characterId: 'ghost', payload: { label: 'Last session', total: 3 } },
            { id: 'new', type: 'roll', ts: '2026-08-10T21:00:00.000Z',
              characterId: 'ch1', payload: { label: 'Tonight', total: 17 } },
          ];
          const scoped = dicerail.rollRows(dated, [{ id: 'ch1', name: 'Pip' }],
            20, '2026-08-10T20:00:00.000Z');
          c.eq(scoped.length, 1, 'rolls from before this table opened are gone');
          c.eq(scoped[0].label, 'Tonight', 'and tonight\'s roll stays');
          c.eq(dicerail.rollRows(dated, [], 20, null).length, 2,
            'with no table time given, nothing is filtered');
        },
      },
    ],
  },
  {
    id: 'rollcard',
    title: 'Roll cards',
    why: 'The card is the table\'s shared read of a die. If it marks the '
       + 'wrong face under advantage or forgets a crit, the wrong story gets '
       + 'told out loud. The model is pure, so the marking rules are graded '
       + 'here without a DOM.',
    scenarios: [
      {
        id: 'rollcard_reads_the_dice',
        title: 'Faces, marks, crits and modes survive the trip to a card',
        async run(c, { rollcard }) {
          c.feature('rollcard');
          const adv = rollcard.cardModel({ label: 'X', roll: {
            faces: [14, 7], nat: 14, mod: 5, total: 19, advantage: true } });
          c.eq(adv.faces.length, 2, 'advantage keeps both faces');
          c.ok(adv.faces[0].used && !adv.faces[1].used,
            'and marks the used one');
          c.ok(adv.advantage && !adv.disadvantage, 'the mode is carried');
          const dis = rollcard.cardModel({ label: 'X', roll: {
            faces: [14, 7], nat: 7, mod: 0, total: 7, disadvantage: true } });
          c.ok(!dis.faces[0].used && dis.faces[1].used,
            'disadvantage marks the low face');
          const twin = rollcard.cardModel({ label: 'X', roll: {
            faces: [14, 14], nat: 14, mod: 0, total: 14 } });
          c.eq(twin.faces.filter((f) => f.used).length, 1,
            'equal faces mark exactly one, never both');
          const crit = rollcard.cardModel({ label: 'X', roll: {
            faces: [20], nat: 20, mod: 3, total: 23, isCrit: true } });
          c.ok(crit.crit && !crit.fumble, 'a natural 20 reads as a crit');
          const fum = rollcard.cardModel({ label: 'X', roll: {
            faces: [1], nat: 1, mod: 3, total: 4, isFumble: true } });
          c.ok(fum.fumble && !fum.crit, 'a natural 1 reads as a fumble');
        },
      },
      {
        id: 'rollcard_matches_real_dice',
        title: 'Twenty seeded advantage rolls land intact',
        async run(c, { rollcard }) {
          c.feature('rollcard', 'dice');
          const rng = seededRng(7).stream('card');
          let totalsOk = true;
          let usedOk = true;
          let flagsOk = true;
          const seen = [];
          for (let i = 0; i < 20; i += 1) {
            const r = d20({ mod: 4, advantage: true, rng });
            const m = rollcard.cardModel({ label: 'X', roll: r });
            const used = m.faces.filter((f) => f.used);
            if (!(m.total === r.total && m.faces.length === 2)) totalsOk = false;
            if (!(used.length === 1 && used[0].v === r.nat)) usedOk = false;
            if (m.crit !== r.isCrit || m.fumble !== r.isFumble) flagsOk = false;
            if (!(totalsOk && usedOk && flagsOk) && seen.length < 2) {
              seen.push(JSON.stringify({ r, m }));
            }
          }
          c.ok(totalsOk, 'totals and both faces agree across 20 rolls',
            seen.join(' | ').slice(0, 160));
          c.ok(usedOk, 'the marked face IS the used face, every time');
          c.ok(flagsOk, 'crit and fumble flags agree with the die');
        },
      },
    ],
  },
  {
    id: 'qr',
    title: 'The join QR',
    why: 'A QR that does not scan strands the whole couch at the join gate. '
       + 'The encoder is vendored, but OUR wrapper picks the error level, '
       + 'builds the matrix, and writes the SVG - so the anchors a camera '
       + 'locks onto are checked against the spec, not against a screenshot.',
    scenarios: [
      {
        id: 'qr_anchors_are_to_spec',
        title: 'A join URL becomes a code a camera can lock onto',
        async run(c, { qr }) {
          c.feature('qr', 'table');
          const m = qr.qrMatrix('http://192.168.1.23:7801/?code=ANVIL-4471');
          // Every legal QR is square with size 4v+17 (v = 1..40).
          c.ok(m.length >= 21 && (m.length - 17) % 4 === 0,
            'a legal QR size', String(m.length));
          c.ok(m.every((row) => row.length === m.length), 'and square');
          // The three finder anchors: dark border, light ring, dark core.
          // Function patterns are never masked, so these cells are absolute.
          const finder = (ox, oy) => m[oy][ox] && !m[oy + 1][ox + 1]
            && m[oy + 2][ox + 2] && m[oy + 3][ox + 3];
          c.ok(finder(0, 0), 'finder at top-left');
          c.ok(finder(m.length - 7, 0), 'finder at top-right');
          c.ok(finder(0, m.length - 7), 'finder at bottom-left');
          const timing = [];
          for (let x = 8; x < m.length - 8; x += 1) timing.push(m[6][x]);
          c.ok(timing.every((v, i) => v === (i % 2 === 0)),
            'the timing track alternates between the finders');
        },
      },
      {
        id: 'qr_svg_is_pure_path',
        title: 'Same URL, same pixels - and the URL never enters the markup',
        async run(c, { qr }) {
          c.feature('qr');
          const url = 'http://10.0.0.5:7802/?code=ANVIL-TT77';
          const a = qr.qrSvg(url);
          c.ok(a === qr.qrSvg(url), 'byte-identical across calls');
          c.ok(a !== qr.qrSvg('http://10.0.0.5:7802/?code=ANVIL-TT79'),
            'one different letter draws a different code');
          c.ok(a.startsWith('<svg ') && a.includes('viewBox="0 0 '),
            'an SVG with a viewBox');
          const d = (a.match(/ d="([^"]*)"/) || [])[1] || '';
          c.ok(d.length > 0 && /^[Mhvz0-9 -]+$/.test(d),
            'path data is only moves and lines - nothing to escape, nothing '
            + 'to inject', d.slice(0, 40));
        },
      },
    ],
  },
  {
    id: 'table',
    title: 'Profiles and permissions',
    why: 'A player\'s browser can ask the server for anything. Hiding a button '
       + 'proves nothing, so these tests go over HTTP and check that the '
       + 'SERVER refuses - which is the only place a refusal counts.',
    scenarios: [
      {
        id: 'solo_needs_no_login',
        title: 'With no table open, nothing asks who you are',
        async run(c, { table }) {
          c.feature('table', 'permissions');
          await table.close();
          const status = await table.status();
          c.ok(!status.open, 'no table is open to begin with');

          const wrote = await table.put('characters', 'gym-solo',
            { name: 'Solo', classes: [] }, null);
          c.eq(wrote.status, 200, 'a write with no token succeeds',
            JSON.stringify(wrote.body).slice(0, 120));
          await table.del('characters', 'gym-solo', null);
        },
      },
      {
        id: 'join_flow',
        title: 'A wrong code is refused and a right one admits',
        async run(c, { table }) {
          c.feature('table', 'join');
          const opened = await table.open('Gym DM');
          c.ok(opened.ok && opened.code, 'the DM gets a code', opened.code);
          c.ok(/^ANVIL-[A-Z0-9]{4}$/.test(opened.code || ''),
            'the code is short and readable aloud', opened.code);
          c.ok(!!opened.token, 'and a token of their own');

          const wrong = await table.join('ANVIL-ZZZZ', 'Nobody');
          c.ok(!wrong.ok, 'a wrong code is refused');
          c.ok(!wrong.token, 'and hands out no token');

          // People retype these, so the obvious variants must work.
          for (const variant of [opened.code.toLowerCase(),
            opened.code.replace('-', ' '), opened.code.split('-')[1]]) {
            // eslint-disable-next-line no-await-in-loop
            const r = await table.join(variant, 'Kim');
            c.ok(r.ok, `"${variant}" is accepted`);
          }
          await table.close();
        },
      },
      {
        id: 'join_code_buys_only_a_player_seat',
        title: 'The join code buys a player seat, never the DM\'s',
        async run(c, { table }) {
          c.feature('table', 'join', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          if (!dm.ok) { c.ok(false, 'a table opened to test against'); return; }

          // The code is shouted across a room and printed as a QR, so
          // everybody at the table has it. It must not be worth a DM seat.
          // join() used to hand back a token bound to any profile id that
          // existed, and "p-dm" always exists.
          const grab = await table.joinRaw({
            code: dm.code, name: 'Mallory', profileId: 'p-dm',
          });
          c.ok(grab.ok, 'the join itself still succeeds - a seat is a seat');
          c.eq(grab.profile?.role, 'player',
            'but the seat is a player\'s, whatever profile the body named',
            JSON.stringify(grab.profile));
          c.ok(grab.profile?.id !== 'p-dm',
            'and it is a new profile, not the DM\'s', grab.profile?.id);

          // The role is the whole point, so prove it where it is spent:
          // a DM-only action must refuse this token.
          const forged = await table.forge(false, grab.token);
          c.eq(forged.status, 403,
            'and a DM-only action refuses that token');
          await table.close();
        },
      },
      {
        id: 'a_claimed_character_is_not_up_for_grabs',
        title: 'One character has one player',
        async run(c, { table }) {
          c.feature('table', 'claim', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          await table.put('characters', 'gym-claimed',
            { name: 'Alice the Brave', classes: [] }, dm.token);
          const alice = await table.join(dm.code, 'Alice');
          const bob = await table.join(dm.code, 'Bob');

          const mine = await table.claim('gym-claimed', alice.token);
          c.ok(mine.ok, 'the first player claims an unclaimed character');

          // Claiming used to be unconditional, so a second player could
          // take a sheet somebody was already playing - and then write it.
          const theirs = await table.claim('gym-claimed', bob.token);
          c.ok(!theirs.ok,
            'a second player cannot claim it', JSON.stringify(theirs.body));
          const wrote = await table.put('characters', 'gym-claimed',
            { name: 'Bob Was Here', classes: [] }, bob.token);
          c.eq(wrote.status, 403,
            'and cannot write the sheet they failed to claim');
          const after = await table.get('characters', 'gym-claimed', dm.token);
          c.eq(after.name, 'Alice the Brave',
            'the character on disk is untouched');

          // The DM handing a character to another player is a real thing
          // that happens mid-campaign, and stays possible.
          const handed = await table.claimRaw(
            { characterId: 'gym-claimed', profileId: bob.profile.id }, dm.token);
          c.ok(handed.ok, 'the DM can still hand a character over');

          await table.del('characters', 'gym-claimed', dm.token);
          await table.close();
        },
      },
      {
        id: 'samples_is_the_dms_own_folder',
        title: 'The folder beside the project still opens for the DM',
        async run(c, { table }) {
          c.feature('table', 'samples');
          // This route reaches OUTSIDE the project - it lists and serves
          // every .html sitting next to it - and it had no local gate, so
          // under --lan any phone could read the DM's drafts off disk.
          //
          // The refusal itself is UNREACHABLE from here: _is_local() reads
          // the socket's peer address, and a same-origin browser is always
          // loopback. Same shape as the join-code visibility rule - the
          // negative is proven by curl from a non-local address, and what
          // the gym pins is that the gate did not break the DM's own use.
          const list = await table.samples();
          c.eq(list.status, 200,
            'the DM\'s own machine still gets the listing');
          c.ok(Array.isArray(list.body?.files),
            'and it is still a list of files', typeof list.body?.files);
        },
      },
      {
        id: 'colour_is_a_seat_choice',
        title: 'A seat recolours itself - and only itself',
        async run(c, { table }) {
          c.feature('table', 'colour');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          c.ok(kim.ok, 'a player joined');
          if (!kim.ok) { await table.close(); return; }

          const mine = await table.put('profiles', kim.profile.id,
            { ...kim.profile, colour: '#2f5d50' }, kim.token);
          c.eq(mine.status, 200, 'recolouring your own seat is allowed');
          let st = await table.status(kim.token);
          c.eq((st.body.profiles || []).find((p) => p.id === kim.profile.id)
            ?.colour, '#2f5d50',
          'and the colour reaches what every seat is told');

          const dmProfile = (st.body.profiles || [])
            .find((p) => p.role === 'dm');
          const theirs = await table.put('profiles', dmProfile.id,
            { ...dmProfile, colour: '#000000' }, kim.token);
          c.eq(theirs.status, 403, 'recolouring somebody else is refused');

          // A payload is not a stylesheet: a non-colour string is dropped
          // by the write-through, whatever the kind file accepted.
          await table.put('profiles', kim.profile.id,
            { ...kim.profile, colour: 'javascript:alert(1)' }, kim.token);
          st = await table.status(kim.token);
          c.eq((st.body.profiles || []).find((p) => p.id === kim.profile.id)
            ?.colour, '#2f5d50',
          'a non-colour string never reaches the table record');
          await table.close();
        },
      },
      {
        id: 'code_rides_one_trusted_field',
        title: 'The join code lives in exactly one serve-layer field',
        async run(c, { table }) {
          c.feature('table', 'join', 'security');
          await table.close();
          const closed = await table.status();
          c.ok(!('code' in closed.body),
            'a closed table has no code field at all',
            JSON.stringify(closed.body).slice(0, 120));

          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          c.ok(kim.ok, 'a player joined');
          if (!kim.ok) { await table.close(); return; }

          // The gym runs on loopback - the trusted seat - so every request
          // from here legitimately receives the top-level code, and the
          // off-loopback refusal is out of reach: _is_local() reads the
          // socket peer address, which a same-origin fetch cannot fake.
          // What IS provable from here: the code must live ONLY in that one
          // field the serve layer attaches. status() itself never embeds
          // it, so stripping the top-level key must erase every trace.
          const dmView = await table.status(dm.token);
          c.eq(dmView.body.code, dm.code, 'the DM seat is shown the code');
          const kimView = await table.status(kim.token);
          c.eq((kimView.body.me || {}).role, 'player',
            'and the player view really carried a player token');
          const rest = JSON.stringify({ ...kimView.body, code: undefined });
          c.ok(!rest.includes(dm.code),
            'outside that field the payload never carries the code',
            rest.slice(0, 160));
          await table.close();
        },
      },
      {
        id: 'server_refuses_the_wrong_writer',
        title: 'A player cannot write another player\'s character',
        async run(c, { table }) {
          c.feature('table', 'permissions', 'security');
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          c.ok(kim.ok, 'the player joined');
          if (!kim.ok) return;

          // Kim makes and claims her own.
          await table.put('characters', 'gym-kim',
            { name: 'Kim', ownerId: kim.profile.id, classes: [] }, kim.token);
          await table.claim('gym-kim', kim.token);
          // The DM makes one owned by somebody else.
          await table.put('characters', 'gym-theirs',
            { name: 'Theirs', ownerId: 'p-someone', classes: [] }, dm.token);

          const own = await table.put('characters', 'gym-kim',
            { name: 'Kim v2' }, kim.token);
          c.eq(own.status, 200, 'a player may write their own character');

          // The vulnerability this test was written for: an earlier version
          // read ownerId out of the REQUEST, so omitting it made any record
          // look unclaimed and a player could overwrite anybody.
          const stripped = await table.put('characters', 'gym-theirs',
            { name: 'Hijacked' }, kim.token);
          c.eq(stripped.status, 403,
            'omitting ownerId does not make another character writable');

          const spoofed = await table.put('characters', 'gym-theirs',
            { name: 'Hijacked', ownerId: kim.profile.id }, kim.token);
          c.eq(spoofed.status, 403,
            'nor does claiming ownership in the request body');

          const deleted = await table.del('characters', 'gym-theirs', kim.token);
          c.eq(deleted.status, 403, 'nor can a player delete it');

          // And prove it on disk, not just in the status code.
          const after = await table.get('characters', 'gym-theirs', dm.token);
          c.eq(after?.name, 'Theirs', 'the record is untouched');

          await table.del('characters', 'gym-kim', dm.token);
          await table.del('characters', 'gym-theirs', dm.token);
          await table.close();
        },
      },
      {
        id: 'shared_content_is_dm_only',
        title: 'Players cannot change the shared world',
        async run(c, { table }) {
          c.feature('table', 'permissions');
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          for (const kind of ['homebrew', 'custom-monsters', 'custom-items',
            'custom-spells', 'npcs', 'shops', 'campaigns', 'encounters',
            'maps']) {
            // eslint-disable-next-line no-await-in-loop
            const r = await table.put(kind, 'gym-shared', { name: 'Mine' }, kim.token);
            c.eq(r.status, 403, `a player cannot write ${kind}`);
            // eslint-disable-next-line no-await-in-loop
            const d = await table.put(kind, 'gym-shared', { name: 'DM' }, dm.token);
            c.eq(d.status, 200, `but the DM can`);
            // eslint-disable-next-line no-await-in-loop
            await table.del(kind, 'gym-shared', dm.token);
          }
          await table.close();
        },
      },
      {
        id: 'no_token_no_write',
        title: 'With a table open, an unjoined browser cannot write',
        async run(c, { table }) {
          c.feature('table', 'permissions', 'security');
          const dm = await table.open('Gym DM');
          const anon = await table.put('characters', 'gym-anon',
            { name: 'Anon' }, null);
          c.eq(anon.status, 401, 'no token is refused');
          c.ok(/join code/i.test(anon.body?.error || ''),
            'and told how to get in', anon.body?.error);

          // A revoked token is as good as none.
          const kim = await table.join(dm.code, 'Kim');
          await table.leave(kim.token);
          const revoked = await table.put('characters', 'gym-anon',
            { name: 'Anon' }, kim.token);
          c.eq(revoked.status, 401, 'a revoked token stops working');

          await table.close();
          const afterClose = await table.put('characters', 'gym-anon',
            { name: 'Solo again' }, null);
          c.eq(afterClose.status, 200,
            'closing the table returns the app to solo, with no login');
          await table.del('characters', 'gym-anon', null);
        },
      },
      {
        id: 'token_key_agrees',
        title: 'The storage layer and the session agree on the token key',
        async run(c, { session, dbTokenKey }) {
          c.feature('table');
          // db.js reads the token straight from localStorage to avoid an
          // import cycle with session.js. That duplication is only safe if
          // the two names cannot drift apart.
          c.eq(dbTokenKey, 'toonanvil.token',
            'the storage adapter reads the agreed key');
          const before = localStorage.getItem('toonanvil.token');
          try {
            localStorage.setItem('toonanvil.token', 'gym-probe');
            c.eq(session.token(), 'gym-probe',
              'and the session module reads the same one');
          } finally {
            if (before === null) localStorage.removeItem('toonanvil.token');
            else localStorage.setItem('toonanvil.token', before);
          }
        },
      },
      {
        id: 'forge_gates_creation',
        title: 'Creation is a forge act',
        async run(c, { table }) {
          c.feature('table', 'forge', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const status = await table.status();
          c.ok(status.forgeOpen === true,
            'a fresh table opens with the forge open - session zero');

          const made = await table.put('characters', 'gym-forge-a',
            { id: 'gym-forge-a', name: 'A', classes: [] }, kim.token);
          c.eq(made.status, 200, 'a player creates while the forge is open');

          const closed = await table.forge(false, dm.token);
          c.ok(closed.ok && closed.forgeOpen === false, 'the DM closes the forge');
          const refused = await table.put('characters', 'gym-forge-b',
            { id: 'gym-forge-b', name: 'B' }, kim.token);
          c.eq(refused.status, 403, 'creation is refused once it is closed');
          c.ok(/forge/i.test(refused.body.error || ''),
            'and the reason names the forge', refused.body.error);

          const sneaky = await table.forge(true, kim.token);
          c.eq(sneaky.status, 403, 'a player cannot reopen it themselves');
          const anon = await table.forge(true, undefined);
          c.eq(anon.status, 401, 'nor can a browser with no token');

          const dmStill = await table.put('characters', 'gym-forge-c',
            { id: 'gym-forge-c', name: 'C' }, dm.token);
          c.eq(dmStill.status, 200, 'the DM builds whenever they like');

          for (const id of ['gym-forge-a', 'gym-forge-c']) {
            // eslint-disable-next-line no-await-in-loop
            await table.del('characters', id, dm.token);
          }
          await table.close();
        },
      },
      {
        id: 'identity_frozen_play_state_writable',
        title: 'Identity is set at the forge; play never needs permission',
        async run(c, { table }) {
          c.feature('table', 'forge', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const base = {
            id: 'gym-frozen', name: 'Kim', species: 'human',
            abilities: { str: 14, dex: 12 },
            classes: [{ class: 'fighter', subclass: null, level: 3 }],
            hp: { max: 28, current: 28 }, inventory: [], conditions: [],
          };
          await table.put('characters', 'gym-frozen', base, kim.token);
          await table.claim('gym-frozen', kim.token);
          await table.forge(false, dm.token);

          const respec = await table.put('characters', 'gym-frozen',
            { ...base, species: 'elf' }, kim.token);
          c.eq(respec.status, 403, 'changing species is refused');
          c.ok(/'species'/.test(respec.body.error || ''),
            'and the refusal names the field', respec.body.error);

          const cheat = await table.put('characters', 'gym-frozen',
            { ...base, abilities: { str: 20, dex: 12 } }, kim.token);
          c.eq(cheat.status, 403, 'so is quietly raising an ability score');

          const play = await table.put('characters', 'gym-frozen',
            { ...base, hp: { max: 28, current: 9 },
              conditions: ['Poisoned'], inventory: [{ id: 'rope', qty: 1 }] },
            kim.token);
          c.eq(play.status, 200,
            'damage, conditions and inventory pass without asking anybody');

          const onDisk = await table.get('characters', 'gym-frozen', kim.token);
          c.eq(onDisk?.hp?.current, 9, 'and the play state actually landed');
          c.eq(onDisk?.species, 'human', 'while the identity never moved');

          await table.del('characters', 'gym-frozen', dm.token);
          await table.close();
        },
      },
      {
        id: 'level_up_refused_granted_consumed',
        title: 'Levelling needs the grant, and the grant is spent by arriving',
        async run(c, { table }) {
          c.feature('table', 'grants', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const at = (lvl, extra = {}) => ({
            id: 'gym-lvl', name: 'Kim',
            classes: [{ class: 'fighter', subclass: null, level: lvl }],
            feats: [], ...extra,
          });
          await table.put('characters', 'gym-lvl', at(3), kim.token);
          await table.claim('gym-lvl', kim.token);
          await table.forge(false, dm.token);

          const refused = await table.put('characters', 'gym-lvl', at(4), kim.token);
          c.eq(refused.status, 403, 'level 4 is refused without a grant');
          c.ok(/grant/i.test(refused.body.error || ''),
            'and the reason says to ask the DM', refused.body.error);

          const granted = await table.grant({ characterId: 'gym-lvl' }, dm.token);
          c.ok(granted.ok && granted.granted['gym-lvl'] === 4,
            'the default grant is one level up', JSON.stringify(granted.granted));

          const mine = await table.status(kim.token);
          c.eq(mine.grants?.['gym-lvl'], 4, 'the player can see their own grant');

          // A real level-up touches identity: a feat at 4. Allowed under the
          // grant - that is what the grant is FOR.
          const up = await table.put('characters', 'gym-lvl',
            at(4, { feats: ['ability-score-improvement'] }), kim.token);
          c.eq(up.status, 200, 'the level-up passes, feat and all');

          const after = await table.status(dm.token);
          c.ok(!('gym-lvl' in (after.grants || {})),
            'arriving at the granted level consumes the grant');

          const again = await table.put('characters', 'gym-lvl', at(5), kim.token);
          c.eq(again.status, 403, 'so level 5 is refused until the next one');

          await table.del('characters', 'gym-lvl', dm.token);
          await table.close();
        },
      },
      {
        id: 'party_grant_and_revoke',
        title: 'One button levels the party; revoke takes one back',
        async run(c, { table }) {
          c.feature('table', 'grants');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          const ren = await table.join(dm.code, 'Ren');
          if (!kim.ok || !ren.ok) { c.ok(false, 'both players joined'); return; }

          const mk = (id, lvl) => ({
            id, name: id, classes: [{ class: 'rogue', subclass: null, level: lvl }],
          });
          await table.put('characters', 'gym-p1', mk('gym-p1', 3), kim.token);
          await table.claim('gym-p1', kim.token);
          await table.put('characters', 'gym-p2', mk('gym-p2', 5), ren.token);
          await table.claim('gym-p2', ren.token);
          await table.forge(false, dm.token);

          const out = await table.grant({ characterId: 'party' }, dm.token);
          c.eq(out.granted['gym-p1'], 4, 'the level-3 character may reach 4');
          c.eq(out.granted['gym-p2'], 6, 'the level-5 character may reach 6');

          // Grants are scoped like everything else at the table: you see your
          // own, the DM sees all, and nobody reads a neighbour's.
          const kimView = await table.status(kim.token);
          c.eq(kimView.grants?.['gym-p1'], 4, 'Kim sees her own grant');
          c.ok(!('gym-p2' in (kimView.grants || {})),
            'and not Ren\'s', JSON.stringify(kimView.grants));

          const rev = await table.grant(
            { characterId: 'gym-p1', revoke: true }, dm.token);
          c.ok(rev.revoked.includes('gym-p1'), 'one grant revoked');
          const st = await table.status(dm.token);
          c.ok(!('gym-p1' in st.grants), 'it is gone');
          c.eq(st.grants['gym-p2'], 6, 'the other survives');

          const denied = await table.grant({ characterId: 'gym-p2' }, kim.token);
          c.eq(denied.status, 403, 'players cannot grant');

          await table.del('characters', 'gym-p1', dm.token);
          await table.del('characters', 'gym-p2', dm.token);
          await table.close();
        },
      },
      {
        id: 'forge_open_full_rebuild',
        title: 'While the forge is open, a player rebuilds and retires freely',
        async run(c, { table }) {
          c.feature('table', 'forge');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          await table.put('characters', 'gym-rebuild',
            { id: 'gym-rebuild', name: 'Draft', species: 'human',
              classes: [{ class: 'wizard', subclass: null, level: 1 }] }, kim.token);
          await table.claim('gym-rebuild', kim.token);

          const rebuilt = await table.put('characters', 'gym-rebuild',
            { id: 'gym-rebuild', name: 'Final', species: 'elf',
              classes: [{ class: 'sorcerer', subclass: null, level: 3 }] }, kim.token);
          c.eq(rebuilt.status, 200,
            'name, species, class AND level all change in one forge-open write');

          await table.forge(false, dm.token);
          const del1 = await table.del('characters', 'gym-rebuild', kim.token);
          c.eq(del1.status, 403,
            'retiring is refused when closed - delete-and-recreate is not a '
            + 'way around the level gate');
          await table.forge(true, dm.token);
          const del2 = await table.del('characters', 'gym-rebuild', kim.token);
          c.eq(del2.status, 200, 'and allowed at the forge');

          await table.close();
        },
      },
      {
        id: 'solo_gate_absent',
        title: 'With no table, none of this exists',
        async run(c, { table }) {
          c.feature('table', 'forge', 'grants');
          await table.close();
          // The regression pin for "solo play untouched": a tokenless browser
          // levels a character from 3 to 9 in one write and nobody asks.
          await table.put('characters', 'gym-solo-lvl',
            { id: 'gym-solo-lvl', classes: [{ class: 'wizard', level: 3 }] }, null);
          const up = await table.put('characters', 'gym-solo-lvl',
            { id: 'gym-solo-lvl', species: 'elf',
              classes: [{ class: 'wizard', level: 9 }] }, null);
          c.eq(up.status, 200, 'solo levelling needs nobody\'s permission');
          const gone = await table.del('characters', 'gym-solo-lvl', null);
          c.eq(gone.status, 200, 'and solo delete works too');
        },
      },
    ],
  },

  /* ---------------- the campaign ------------------------------------ */
  {
    id: 'campaign',
    title: 'The world the Deck drives',
    why: 'Weather is a pure function so every screen derives the same sky; '
       + 'the campaign record carries the one real secret (agendas), so the '
       + 'server must strip it. Both claims are only worth anything tested.',
    scenarios: [
      {
        id: 'weather_deterministic',
        title: 'The same day in the same place has the same sky, forever',
        run(c, { campaign, tables }) {
          c.feature('weather', 'campaign');
          const region = { id: 'reg-t', terrain: 'forest' };
          const args = { seed: 1234, day: 14, region };
          const a = campaign.weatherFor(tables, args);
          const b = campaign.weatherFor(tables, args);
          c.eq(JSON.stringify(a), JSON.stringify(b),
            'two computations agree exactly');
          c.ok(a.summary.length > 0, 'and say something readable', a.summary);

          // No hidden state: computing day 19 must not change day 14.
          campaign.weatherFor(tables, { seed: 1234, day: 19, region });
          const again = campaign.weatherFor(tables, args);
          c.eq(JSON.stringify(again), JSON.stringify(a),
            'computing another day does not disturb this one');

          // Days differ somewhere across a span, or the sky is a painting.
          const skies = new Set();
          for (let d = 1; d <= 30; d += 1) {
            skies.add(campaign.weatherFor(tables,
              { seed: 1234, day: d, region }).summary);
          }
          c.ok(skies.size > 3, 'thirty days hold more than three skies',
            `${skies.size} distinct`);

          const desert = campaign.weatherFor(tables,
            { seed: 1234, day: 14, region: { id: 'reg-d', terrain: 'desert' } });
          c.ok(desert.terrain === 'desert', 'terrain flows through');
        },
      },
      {
        id: 'weather_label_mixes',
        title: 'Two regions with one terrain do not share a sky',
        run(c, { campaign, tables }) {
          c.feature('weather');
          // Regression pin on a bug this project actually shipped once: the
          // rng LABEL does not mix into the sequence, so anything built on
          // seededRng(seed, label) gives every region identical draws. The
          // weather engine must use .stream(), which hashes seed and name.
          const a = [];
          const b = [];
          for (let d = 1; d <= 30; d += 1) {
            a.push(campaign.weatherFor(tables,
              { seed: 77, day: d, region: { id: 'reg-a', terrain: 'coast' } }).summary);
            b.push(campaign.weatherFor(tables,
              { seed: 77, day: d, region: { id: 'reg-b', terrain: 'coast' } }).summary);
          }
          c.ok(a.join('|') !== b.join('|'),
            'thirty days in two coastal regions diverge somewhere');
          // And days must differ within one region too - a stream that
          // ignored the day would freeze the sky.
          c.ok(new Set(a).size > 1, 'the sky moves from day to day');
        },
      },
      {
        id: 'campaign_secrets_stay_on_the_server',
        title: 'A player is not sent the agendas, on either route',
        async run(c, { table }) {
          c.feature('campaign', 'permissions', 'security');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const record = {
            id: 'gym-camp', name: 'Gym Campaign', active: true, day: 3,
            seed: 999, currentRegionId: 'reg-1',
            regions: [{ id: 'reg-1', name: 'The Vale', terrain: 'forest',
              priceMod: 1.5, note: '' }],
            factions: [
              { id: 'f-pub', name: 'The Wardens', standing: 2,
                agenda: 'SECRET: reclaim the shrine', public: true },
              { id: 'f-hid', name: 'The Veiled Hand', standing: -3,
                agenda: 'SECRET: replace the mayor', public: false },
            ],
            lore: [{ title: 'The drowned district', text: 'DM prep' }],
          };
          const put = await table.put('campaigns', 'gym-camp', record, dm.token);
          c.eq(put.status, 200, 'the DM writes the campaign');
          const refused = await table.put('campaigns', 'gym-camp',
            { ...record, day: 99 }, kim.token);
          c.eq(refused.status, 403, 'a player cannot');

          const mine = await table.get('campaigns', 'gym-camp', kim.token);
          c.ok(!JSON.stringify(mine).includes('SECRET'),
            'no agenda text reaches the player');
          c.eq(mine.factions?.length, 1, 'non-public factions are absent entirely');
          c.eq(mine.factions?.[0]?.agenda, undefined,
            'and the public one arrives without its agenda');
          c.ok(!('lore' in mine), 'lore is DM prep and stays home');
          c.eq(mine.seed, 999,
            'the seed survives - players compute the same sky from it');
          c.eq(mine.day, 3, 'so does the day');
          c.eq(mine.regions?.length, 1, 'and the regions');

          // The route that was missed once: the LIST hands back the same files.
          const listed = await fetch('/api/campaigns', {
            headers: { 'X-Toon-Token': kim.token } }).then((r) => r.json());
          const fromList = listed.find((x) => x.id === 'gym-camp');
          c.ok(fromList && !JSON.stringify(fromList).includes('SECRET'),
            'the list route redacts identically');

          const asDm = await table.get('campaigns', 'gym-camp', dm.token);
          c.eq(asDm.factions?.[1]?.agenda, 'SECRET: replace the mayor',
            'while the DM keeps every word');

          await table.del('campaigns', 'gym-camp', dm.token);
          await table.close();
        },
      },
      {
        id: 'shelf_http',
        title: 'A dropped book is detected, filed, idempotent, and removable',
        async run(c, { table, shelf }) {
          c.feature('shelf', 'detector', 'library', 'permissions');
          await table.close();
          const bytes = shelf.fixtureBytes();
          const name = shelf.fixtureName;
          // A crashed earlier run may have left the fixture shelved (perhaps
          // refiled). The hash is just sha256 of the bytes - compute it and
          // sweep first, so this scenario owns its whole lifecycle.
          const digest = [...new Uint8Array(
            await crypto.subtle.digest('SHA-256', bytes))]
            .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
          await shelf.remove(digest);

          const up = await shelf.upload(name, bytes);
          c.eq(up.status, 200, 'the upload lands');
          c.eq(up.category, 'settings', 'the detector reads it as a setting');
          c.ok((up.confidence ?? 0) >= 0.4, 'with real confidence');
          c.ok((up.evidence || []).length >= 1, 'and says why');
          c.ok(!up.error, 'the split succeeded');
          c.eq(up.hash, digest, 'keyed by the content hash');
          // The book keeps ITS name. The upload stages bytes under a
          // hash-prefixed temp name, and that prefix leaked into the shelf
          // once - title, slug and all. Substring checks let it slip; an
          // exact match cannot.
          c.eq(up.name, name, 'the book keeps its own name');
          c.eq(up.slug, 'Gym-Fixture-Gazetteer', 'and a clean slug');

          const again = await shelf.upload(name, bytes);
          c.eq(again.alreadyKnown, true,
            're-dropping the same bytes is a no-op');

          const listed = await shelf.list();
          c.ok((listed.categories?.settings || [])
            .some((r) => r.hash === digest),
          'the shelf lists it under settings');

          const secs = await shelf.sections(up.slug);
          c.ok((secs.sections || []).length >= 2,
            'sections arrive for the Deck');
          c.ok((secs.sections || []).every(
            (s, i, a) => !i || a[i - 1].page <= s.page),
          'in reading order');

          const moved = await shelf.refile(digest, 'adventures');
          c.eq(moved.status, 200, 'refiled by hand');
          const listed2 = await shelf.list();
          c.ok((listed2.categories?.adventures || [])
            .some((r) => r.hash === digest),
          'and the listing follows the move');

          // Auth posture: the moment a table exists, filing is the DM's.
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          const refused = await shelf.refile(digest, 'settings', kim.token);
          c.eq(refused.status, 403, 'a player cannot refile');
          const asDm2 = await shelf.refile(digest, 'settings', dm.token);
          c.eq(asDm2.status, 200, 'the DM can');
          await table.close();

          const gone = await shelf.remove(digest);
          c.eq(gone.status, 200, 'an uploaded book can be removed');
          const listed3 = await shelf.list();
          c.ok(!Object.values(listed3.categories || {}).flat()
            .some((r) => r.hash === digest),
          'and it is gone from every category');
        },
      },
      {
        id: 'split_selftest',
        title: 'The PDF splitter passes its pinned quality gate',
        // The splitter is Python; its fixtures are rendered from the bundled
        // SRD monsters (never book text). Running its selftest through the
        // server puts the extraction pipeline behind the same green-or-red
        // door as everything else. No mutation reaches server-side code, so
        // the adversarial cases live INSIDE the selftest instead.
        async run(c) {
          c.feature('shelf', 'split-selftest');
          const rep = await fetch('/api/split/selftest')
            .then((r) => r.json());
          c.ok(rep.ok === true, 'the selftest is green',
            JSON.stringify((rep.cases || []).filter((x) => !x.ok)));
          c.ok((rep.passed || 0) >= 10, 'at least the ten pinned cases ran',
            `${rep.passed} passed`);
          c.eq(rep.failed, 0, 'zero failures');
          // The harness pins the CURRENT defect by name: whole statblocks
          // shatter in blocks_from. When the stitching fix lands, the case
          // flips to assert one classified monster and this check follows -
          // the diff here is the receipt that the defect died on purpose.
          c.ok((rep.cases || []).some(
            (x) => /whole_statblock/.test(x.name)),
          'the whole-statblock case is pinned');
        },
      },
      {
        id: 'price_choke_pure',
        title: 'One arithmetic for every price the Market shows or takes',
        run(c, { campaign }) {
          c.feature('campaign', 'economy', 'market');
          const { unitPrice, sellBack } = campaign;
          c.eq(unitPrice(100, 0, 1), 100, 'base price untouched at x1');
          c.eq(unitPrice(100, 0, 2), 200, 'a x2 region doubles it');
          c.eq(unitPrice(100, 20, 0.5), 40,
            'region and haggling compose (100 x 0.5 x 0.8)');
          c.eq(unitPrice(1, 50, 0.5), 1, 'the floor is one copper, never zero');
          c.eq(unitPrice(100, 0, 9), 200,
            'the dial clamps at x2 - no thousand-fold famine');
          c.eq(unitPrice(100, 0, 0.01), 50, 'and at x0.5 the other way');
          c.eq(sellBack(100, 1), 50, 'sell-back is half, as the SRD prices it');
          c.eq(sellBack(100, 2), 100, 'a rich region pays more for your goods');
          c.eq(sellBack(100, 0.5), 25, 'a poor one pays less - the dial cuts both ways');
          c.eq(sellBack(0, 2), 0, 'nothing is never worth something');
        },
      },
      {
        id: 'map_pins_stay_hidden',
        title: 'An unrevealed pin never reaches a player, on either route',
        async run(c, { table }) {
          c.feature('campaign', 'map', 'security');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const record = {
            id: 'gym-map', name: 'Gym Map',
            image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
            w: 1, h: 1,
            pins: [
              { id: 'p-shown', x: 0.2, y: 0.2, kind: 'location',
                label: 'The Winch House', note: 'smugglers below',
                revealed: true },
              { id: 'p-hidden', x: 0.8, y: 0.8, kind: 'quest',
                label: 'HIDDEN: The Vault', note: 'the real hoard',
                revealed: false },
            ],
          };
          const put = await table.put('maps', 'gym-map', record, dm.token);
          c.eq(put.status, 200, 'the DM writes the map');

          const mine = await table.get('maps', 'gym-map', kim.token);
          c.eq(mine.pins?.length, 1, 'the player receives only revealed pins');
          c.eq(mine.pins?.[0]?.label, 'The Winch House', 'the right one');
          c.eq(mine.pins?.[0]?.note, undefined,
            'and even a revealed pin keeps its DM note at home');
          c.ok(!JSON.stringify(mine).includes('HIDDEN'),
            'no trace of the hidden pin in the payload');

          const listed = await fetch('/api/maps', {
            headers: { 'X-Toon-Token': kim.token } }).then((r) => r.json());
          const fromList = listed.find((x) => x.id === 'gym-map');
          c.ok(fromList && !JSON.stringify(fromList).includes('HIDDEN'),
            'the list route redacts identically');

          const asDm = await table.get('maps', 'gym-map', dm.token);
          c.eq(asDm.pins?.length, 2, 'the DM keeps every pin');

          await table.del('maps', 'gym-map', dm.token);
          await table.close();
        },
      },
      {
        id: 'npc_write_best_effort',
        title: "A player's beat lands as an event even when the record is refused",
        async run(c, { table }) {
          c.feature('campaign', 'permissions', 'rp');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const rec = await table.put('npcs', 'gym-npc-probe',
            { id: 'gym-npc-probe', name: 'Ilse' }, kim.token);
          c.eq(rec.status, 403,
            'the npcs record is the DM\'s ledger - players are refused');

          const ev = await fetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ id: `gym-npc-ev-${Date.now()}`,
              type: 'npc_met', cat: 'rp',
              summary: 'Toon Anvil self-test: met Ilse (gym probe)' }]),
          });
          c.ok(ev.ok, 'while the npc_met EVENT always lands - the beat is theirs');

          await table.close();
        },
      },
      {
        id: 'forecast_pure',
        title: 'Seven days ahead is seven calls, and each day is its own',
        run(c, { campaign, tables }) {
          c.feature('campaign', 'weather', 'forecast');
          const { forecastFor, weatherFor } = campaign;
          const region = { id: 'reg-t', terrain: 'forest' };
          const args = { seed: 1234, day: 14, region };
          const week = forecastFor(tables, args, 7);
          c.eq(week.length, 7, 'seven skies come back');
          let eachDay = true;
          let matches = true;
          for (let i = 0; i < week.length; i += 1) {
            if (week[i]?.day !== 14 + i) eachDay = false;
            const solo = weatherFor(tables, { ...args, day: 14 + i });
            if (JSON.stringify(week[i]) !== JSON.stringify(solo)) matches = false;
          }
          c.ok(eachDay, 'each entry is stamped with its own day');
          c.ok(matches,
            'and each equals weatherFor of that day - one function, one truth');
          c.eq(JSON.stringify(forecastFor(tables, args, 7)),
            JSON.stringify(week), 'twice over, identical - deterministic');
        },
      },
      {
        id: 'purchase_stamp_pure',
        title: 'A purchase knows what day it was',
        run(c, { campaign }) {
          c.feature('campaign', 'economy', 'events');
          const { stampDay } = campaign;
          const p = { item: 'rope', priceCp: 100 };
          const stamped = stampDay(p, { day: 7 });
          c.eq(stamped.day, 7, 'the campaign day lands on the payload');
          c.eq(stamped.item, 'rope', 'the rest of the payload survives');
          c.ok(!('day' in p), 'the original is not mutated');
          c.ok(!('day' in stampDay(p, null)),
            'and with no campaign there is no day to claim');
        },
      },
    ],
  },

  /* ---------------- character generation ----------------------------- */
  {
    id: 'chargen',
    title: 'Character creation',
    why: 'A new character began with nothing and AC 10, and the ability '
       + 'methods advised without enforcing - both from the README\'s own '
       + 'list. The parsers read the SRD\'s sentences, so a grammar drift '
       + 'must fail loudly, not grant nothing.',
    scenarios: [
      {
        id: 'point_buy_spend',
        title: 'Point buy prices every score, and names what it cannot price',
        run(c, { rules }) {
          c.feature('chargen', 'abilities');
          const flat = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
          c.eq(rules.pointBuySpend(flat).spent, 12, 'all tens spend 12');
          const maxed = { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 };
          const m = rules.pointBuySpend(maxed);
          c.eq(m.spent, 27, 'three fifteens and three eights spend exactly 27');
          c.ok(!m.over, 'and that is not over budget');
          const cheat = rules.pointBuySpend({ ...flat, str: 18 });
          c.same(cheat.outOfRange, ['str'],
            'an 18 is named out of range - the old sum priced it at ZERO');
          c.eq(cheat.spent, 10, 'and its cost is excluded, not invented');
          const over = rules.pointBuySpend({ str: 15, dex: 15, con: 15,
            int: 9, wis: 8, cha: 8 });
          c.ok(over.over, '28 points is over the 27 budget');
        },
      },
      {
        id: 'array_assignment',
        title: 'The standard array is a multiset - each value assignable once',
        run(c, { rules }) {
          c.feature('chargen', 'abilities');
          const good = rules.arrayAssignment(
            { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 });
          c.ok(good.complete && good.valid, 'a clean assignment is complete');
          c.eq(good.remaining.length, 0, 'with nothing left over');
          const dup = rules.arrayAssignment(
            { str: 15, dex: 15, con: 13, int: 12, wis: 10, cha: 8 });
          c.ok(!dup.valid, 'two fifteens are not valid');
          c.same(dup.duplicates, ['dex'],
            'the second claimant is the named duplicate');
          const off = rules.arrayAssignment(
            { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 9 });
          c.same(off.unassigned, ['cha'],
            'a value the array never offered is named too');
        },
      },
      {
        id: 'equipment_grammar',
        title: 'Every class and background package parses, quantities intact',
        run(c, { sources, rules }) {
          c.feature('chargen', 'starting-gear', 'equipment');
          let parsedAll = true;
          for (const cls of sources.classes) {
            const p = rules.parseStartingEquipment(
              cls.startingEquipment, sources.equipment);
            if (!p || !p.options.length) {
              parsedAll = false;
              c.ok(false, `${cls.name}'s package parses`);
            }
          }
          c.ok(parsedAll, 'all twelve class packages parse');
          for (const bg of sources.backgrounds) {
            const p = rules.parseStartingEquipment(
              bg.equipment, sources.equipment);
            c.ok(!!p && p.options.length === 2,
              `${bg.name}'s background package parses both options`);
          }

          const fighter = rules.parseStartingEquipment(
            sources.classes.find((x) => x.id === 'fighter').startingEquipment,
            sources.equipment);
          const a = fighter.options[0];
          const jav = a.items.find((i) => /javelin/i.test(i.name));
          c.eq(jav?.qty, 8, 'eight javelins are eight, not one');
          c.ok(!!jav?.resolved && jav.ref.costCp === 50,
            'and resolve to the priced compendium record');
          c.eq(a.gp, 4, "option A's purse is 4 GP");
          c.eq(fighter.options[2].items.length, 0,
            'the gold-only option carries no items');
          c.eq(fighter.options[2].gp, 155, 'and all 155 GP');

          const monk = rules.parseStartingEquipment(
            sources.classes.find((x) => x.id === 'monk').startingEquipment,
            sources.equipment);
          c.ok(monk.options[0].items.some((i) => !i.resolved),
            'what the price list lacks is kept as an unresolved item, not dropped');
        },
      },
      {
        id: 'equipment_grant',
        title: 'A taken package derives the AC the book promises',
        run(c, { sources, rules }) {
          c.feature('chargen', 'starting-gear', 'ac');
          const fighter = rules.parseStartingEquipment(
            sources.classes.find((x) => x.id === 'fighter').startingEquipment,
            sources.equipment);
          const inv = fighter.options[0].items
            .filter((i) => i.resolved)
            .map((i, n) => ({ id: `t-${n}`, name: i.ref.name,
              kind: i.ref.kind, qty: i.qty, ac: i.ref.ac,
              equipped: i.ref.kind === 'armor' }));
          const d = derive(makeChar({ inventory: inv,
            abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 10, cha: 8 },
          }), sources);
          c.eq(d.ac, 16, 'chain mail arrives equipped: AC 16 flat, dex ignored');
          c.eq(d.acSource, 'Chain Mail', 'named for the armour, not guessed');
        },
      },
    ],
  },

  /* ---------------- the spellbook ------------------------------------ */
  {
    id: 'spellbook',
    title: 'Spell selection',
    why: 'The README\'s biggest listed gap: the data model supported chosen '
       + 'spells and nothing wrote them. The budgets come from the class '
       + 'tables\' own columns, header-indexed because every class lays its '
       + 'table out differently.',
    scenarios: [
      {
        id: 'budget_pins',
        title: 'The class tables price cantrips and prepared spells exactly',
        run(c, { sources, rules }) {
          c.feature('spellbook', 'chargen');
          const b = (id, lvl) => rules.spellBudget(
            sources.classes.find((x) => x.id === id), lvl);
          c.same(b('wizard', 1), { cantrips: 3, prepared: 4 }, 'wizard L1');
          c.same(b('cleric', 4), { cantrips: 4, prepared: 7 },
            'cleric L4 - its Cantrips column sits AFTER Channel Divinity');
          c.same(b('bard', 4), { cantrips: 3, prepared: 7 }, 'bard L4');
          c.same(b('sorcerer', 4), { cantrips: 5, prepared: 7 }, 'sorcerer L4');
          c.same(b('paladin', 4), { cantrips: 0, prepared: 5 },
            'paladin L4 - no Cantrips column at all');
          c.same(b('warlock', 5), { cantrips: 3, prepared: 6 },
            'warlock L5 - its own slots layout, same Prepared column');
          c.eq(b('fighter', 5), null, 'a martial class has no budget');
        },
      },
      {
        id: 'budget_reaches_derive',
        title: 'The budget rides the derived sheet',
        run(c, { sources }) {
          c.feature('spellbook', 'derive');
          const d = derive(makeChar({
            classes: [{ class: 'wizard', level: 1, subclass: null }],
          }), sources);
          c.same(d.spellcasting?.budget, { cantrips: 3, prepared: 4 },
            'a wizard sheet knows its allowance');
          const m = derive(makeChar(), sources);
          c.eq(m.spellcasting, null, 'a fighter sheet has no spellcasting at all');
        },
      },
      {
        id: 'membership',
        title: 'Wrong-class and wrong-level picks are named, never stripped',
        run(c, { sources, rules, spells }) {
          c.feature('spellbook');
          const wizardOnly = (spells || []).find((s) => s.id === 'acid-arrow');
          c.ok(!!wizardOnly, 'the probe spell exists');
          const ch = makeChar({
            classes: [{ class: 'cleric', level: 4, subclass: null }],
            spells: { known: [], prepared: ['acid-arrow'] },
          });
          const p = rules.spellbookProblems(ch, sources.classes, spells);
          c.ok(p.caster, 'a cleric is a caster');
          c.same(p.wrongClass, ['acid-arrow'],
            'a wizard spell on a cleric is named');
          c.ok(!p.clean, 'and the book is not clean');
          const ok = rules.spellbookProblems(makeChar({
            classes: [{ class: 'wizard', level: 4, subclass: null }],
            spells: { known: [], prepared: ['acid-arrow'] },
          }), sources.classes, spells);
          c.ok(!ok.wrongClass.length, 'the same spell on a wizard is fine');
        },
      },
      {
        id: 'budget_invariant',
        title: 'The sweep would catch a book over its budget',
        run(c, { sources }) {
          c.feature('spellbook', 'invariants');
          const over = makeChar({
            classes: [{ class: 'wizard', level: 1, subclass: null }],
            // wizard L1 allows 4 prepared; five ids breach it.
            spells: { known: [], prepared: ['a', 'b', 'c', 'd', 'e'] },
          });
          const v = checkAll({ character: over, derived: derive(over, sources) });
          c.ok(v.some((x) => x.id === 'prepared_within_budget'),
            'prepared_within_budget fires on the fifth spell');
          const fine = makeChar({
            classes: [{ class: 'wizard', level: 1, subclass: null }],
            spells: { known: [], prepared: ['a', 'b'] },
          });
          const v2 = checkAll({ character: fine, derived: derive(fine, sources) });
          c.ok(!v2.some((x) => x.id === 'prepared_within_budget'),
            'and stays quiet within it');
        },
      },
    ],
  },

  /* ---------------- chrome: seat + theme ----------------------------- */
  {
    id: 'chrome',
    title: 'Who is the DM, and what colour is the page',
    why: 'Both rules are pure functions precisely so they can be tested as '
       + 'tables. The seat decides which screens exist; getting it wrong '
       + 'either hides a DM\'s own tools or hands a player screens full of '
       + 'controls the server will refuse.',
    scenarios: [
      {
        id: 'seat_truth_table',
        title: 'The table seat always beats the local one',
        run(c, { session }) {
          c.feature('seat', 'table');
          const cases = [
            // At a table, the table decides - whatever the device remembers.
            [{ tableOpen: true, tableRole: 'dm', localRole: 'player' }, 'dm',
              'the table DM is the DM even on a player-seat device'],
            [{ tableOpen: true, tableRole: 'player', localRole: 'dm' }, 'player',
              'joining as a player makes you a player, whatever this device thinks'],
            [{ tableOpen: true, tableRole: null, localRole: 'dm' }, 'player',
              'at a table but not joined: a spectator is not the DM'],
            // Solo, the remembered seat decides.
            [{ tableOpen: false, tableRole: null, localRole: 'dm' }, 'dm',
              'solo with the DM seat chosen'],
            [{ tableOpen: false, tableRole: null, localRole: 'player' }, 'player',
              'solo with the player seat chosen'],
            [{ tableOpen: false, tableRole: null, localRole: null }, 'player',
              'no choice yet defaults to the calmer seat'],
          ];
          for (const [input, want, label] of cases) {
            c.eq(session.resolveSeat(input), want, label);
          }
        },
      },
      {
        id: 'theme_resolution',
        title: 'An explicit choice beats the operating system, in both directions',
        run(c, { theme }) {
          c.feature('theme');
          const cases = [
            [null, false, 'light', 'no choice on a light machine follows it'],
            [null, true, 'dark', 'no choice on a dark machine follows it'],
            ['light', true, 'light', 'choosing parchment beats a dark OS'],
            ['dark', false, 'dark', 'choosing candlelight beats a light OS'],
            ['light', false, 'light', 'agreeing with the OS still works'],
            ['dark', true, 'dark', 'in both directions'],
          ];
          for (const [choice, sysDark, want, label] of cases) {
            c.eq(theme.resolve(choice, sysDark), want, label);
          }
        },
      },
      {
        id: 'nav_truth_table',
        title: 'Two shells: who sees which app, as one pure rule',
        run(c, { session }) {
          c.feature('seat', 'nav', 'shell', 'grants', 'lobby');
          // A miniature MODES table carrying every flag the rule reads.
          const MODES = [
            { id: 'sheet', shell: 'player' }, { id: 'build', shell: 'player' },
            { id: 'combat', shell: 'player', soloOnly: true },
            { id: 'shop', shell: 'player' },
            { id: 'table', shell: 'player', tableOnly: true },
            { id: 'dm-stage', shell: 'dm' }, { id: 'dm-deck', shell: 'dm' },
            { id: 'dm-world', shell: 'dm' }, { id: 'dm-story', shell: 'dm' },
            { id: 'dm-setup', shell: 'dm' },
            { id: 'settings', gear: true },
            // The lobby: hosting and joining are one room seen from two
            // sides, so it belongs to BOTH shells like the gear does.
            { id: 'lobby', always: true },
          ];
          const ids = (args) => session.navFor(args, MODES).map((m) => m.id);
          // The lobby trails the list because it is declared last in MODES,
          // which is deliberate: the boot mode falls back to the FIRST
          // visible mode, and a lobby earlier in the list would silently
          // move the DM's home screen.
          const DM_SHELL = 'dm-stage,dm-deck,dm-world,dm-story,dm-setup,'
            + 'settings,lobby';

          // The claim worth pinning: the DM's app is the SAME app solo and
          // at a table. The seat picks the shell, whole.
          c.eq(ids({ tableOpen: false, seat: 'dm' }).join(','), DM_SHELL,
            'the DM shell, solo');
          c.eq(ids({ tableOpen: true, seat: 'dm' }).join(','), DM_SHELL,
            'and the identical DM shell at a table');
          c.ok(!ids({ tableOpen: false, seat: 'dm' }).includes('build'),
            'not one player screen in it');

          const player = ids({ tableOpen: true, seat: 'player',
            forgeOpen: false, hasGrant: false });
          c.ok(!player.some((id) => id.startsWith('dm-')),
            "a player never sees a captain's screen");
          c.ok(!player.includes('combat'),
            'the solo tracker is hidden at a table');
          c.ok(!player.includes('build'),
            'Build is hidden with the forge closed and no grant');
          c.ok(player.includes('table') && player.includes('sheet')
            && player.includes('shop'), 'Play, Party and the Market remain');

          c.ok(ids({ tableOpen: true, seat: 'player',
            forgeOpen: true, hasGrant: false }).includes('build'),
          'the forge opening reveals Build');
          c.ok(ids({ tableOpen: true, seat: 'player',
            forgeOpen: false, hasGrant: true }).includes('build'),
          'and so does a waiting grant');

          c.eq(ids({ tableOpen: false, seat: 'player',
            forgeOpen: false, hasGrant: false }).join(','),
          'sheet,build,combat,shop,settings,lobby',
          'solo player seat keeps Build and Combat - no DM to gate them');

          // The lobby is in BOTH shells and survives every gate, because
          // hosting and joining are the same room from two sides. A player
          // who could not see it could not join; a DM who could not see it
          // could not watch anyone arrive.
          for (const args of [
            { tableOpen: false, seat: 'dm' },
            { tableOpen: true, seat: 'dm' },
            { tableOpen: false, seat: 'player' },
            { tableOpen: true, seat: 'player', forgeOpen: false, hasGrant: false },
          ]) {
            c.ok(ids(args).includes('lobby'),
              `the lobby survives ${JSON.stringify(args)}`);
          }
        },
      },
            {
        id: 'seat_persists_on_this_device',
        title: 'The chosen seat is remembered, and clearable',
        run(c, { session }) {
          c.feature('seat');
          // This page is NOT a sandbox, so setLocalRole writes the real key -
          // save and restore it, the same discipline the theme flow uses.
          const before = localStorage.getItem('toonanvil.role');
          try {
            session.setLocalRole('dm');
            c.eq(localStorage.getItem('toonanvil.role'), 'dm',
              'taking the DM seat stores it');
            c.eq(session.localRole(), 'dm', 'and the module reads it back');
            session.setLocalRole('player');
            c.eq(localStorage.getItem('toonanvil.role'), 'player',
              'switching seats overwrites rather than accumulates');
            session.setLocalRole(null);
            c.eq(localStorage.getItem('toonanvil.role'), null,
              'clearing the seat removes the key entirely');
          } finally {
            if (before === null) localStorage.removeItem('toonanvil.role');
            else localStorage.setItem('toonanvil.role', before);
          }
        },
      },
    ],
  },

  /* ---------------- live state -------------------------------------- */
  {
    id: 'live',
    title: 'Knowing when somebody else changed something',
    why: 'Damage the DM applies has to reach the player\'s sheet while they '
       + 'are looking at it. These tests go over real HTTP and hold a real '
       + 'EventSource open, because a mocked stream would prove nothing about '
       + 'whether the server actually pushes.',
    scenarios: [
      {
        id: 'counter_advances_on_write',
        title: 'Every write moves the revision, and says what moved',
        async run(c, { table }) {
          c.feature('live', 'sync');
          const before = (await table.changes(0)).rev;
          c.ok(Number.isFinite(before), 'the server reports a revision', String(before));

          await table.put('characters', 'gym-live-1', { name: 'One' }, null);
          const after = await table.changes(before);
          c.ok(after.rev > before, 'a write advances the revision',
            `${before} -> ${after.rev}`);
          c.eq(after.changes.length, 1, 'and reports exactly what changed');
          c.eq(after.changes[0].kind, 'characters', 'the kind is named');
          c.eq(after.changes[0].id, 'gym-live-1', 'and so is the id');

          // A read must NOT move it, or every poll wakes every client forever.
          await table.get('characters', 'gym-live-1', null);
          c.eq((await table.changes(0)).rev, after.rev,
            'a read leaves the revision alone');

          const del = await table.changes(after.rev);
          c.eq(del.changes.length, 0, 'and nothing new is invented between polls');

          await table.del('characters', 'gym-live-1', null);
          const gone = await table.changes(after.rev);
          c.ok(gone.changes.some((x) => x.id === 'gym-live-1'),
            'a delete is announced too, not only a write');
        },
      },
      {
        id: 'since_filters_and_reports_gaps',
        title: 'A client that fell behind is told so rather than quietly missing changes',
        async run(c, { table }) {
          c.feature('live', 'sync');
          const start = (await table.changes(0)).rev;
          for (let i = 0; i < 3; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await table.put('characters', `gym-live-${i}`, { name: `C${i}` }, null);
          }
          const all = await table.changes(start);
          c.eq(all.changes.length, 3, 'since=N returns only what came after N');
          c.ok(all.changes.every((x) => x.rev > start), 'and none from before it');
          c.ok(!all.gap, 'a client that kept up is not told it fell behind');

          const partial = await table.changes(start + 1);
          c.eq(partial.changes.length, 2, 'the filter is exclusive of `since`');

          // The one that matters: a client claiming a revision the server has
          // never reached means the server RESTARTED and its counter reset.
          // Reporting "nothing new" there would leave that client permanently
          // stale with no way to notice.
          const ahead = await table.changes(all.rev + 500);
          c.ok(ahead.gap, 'a client ahead of the server is told it has a gap');
          c.ok(ahead.rev < all.rev + 500,
            'and is given the real revision to reset to', String(ahead.rev));

          for (let i = 0; i < 3; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await table.del('characters', `gym-live-${i}`, null);
          }
        },
      },
      {
        id: 'stream_pushes_without_asking',
        title: 'A held-open stream delivers a change made by somebody else',
        async run(c, { table }) {
          c.feature('live', 'sync', 'stream');
          const start = (await table.changes(0)).rev;

          // Open the stream first, then write from "another client" (this
          // scenario, over a separate request) and see whether it arrives
          // without anybody polling.
          const listening = table.stream(start, 2500);
          await new Promise((r) => { setTimeout(r, 300); });
          await table.put('characters', 'gym-live-push', { name: 'Pushed' }, null);
          const { error, messages } = await listening;

          c.ok(!error, 'the stream opened', error || '');
          c.ok(messages.length >= 1, 'and delivered at least one message',
            `${messages.length} message(s)`);
          const hello = messages.find((m) => m.type === 'hello');
          c.ok(!!hello, 'the first message states the current revision');

          const push = messages.find((m) => (m.changes || [])
            .some((x) => x.id === 'gym-live-push'));
          c.ok(!!push, 'the write arrived over the stream, unasked');
          if (push) {
            c.ok(push.rev > start, 'carrying a revision the client can resume from',
              `${start} -> ${push.rev}`);
          }
          await table.del('characters', 'gym-live-push', null);
        },
      },
      {
        id: 'stream_and_poll_agree',
        title: 'The fast path and the fallback report the same thing',
        async run(c, { table }) {
          c.feature('live', 'sync', 'stream');
          const start = (await table.changes(0)).rev;
          const listening = table.stream(start, 2200);
          await new Promise((r) => { setTimeout(r, 300); });
          await table.put('characters', 'gym-live-agree', { name: 'Agree' }, null);
          const { messages } = await listening;
          const polled = await table.changes(start);

          const streamed = messages.flatMap((m) => m.changes || [])
            .filter((x) => x.rev > start)
            .map((x) => `${x.rev}:${x.kind}:${x.id}`);
          const byPoll = polled.changes.map((x) => `${x.rev}:${x.kind}:${x.id}`);

          // Assert each transport saw the write on its own first. Comparing
          // them alone would pass with both empty, which is precisely the
          // failure this is meant to catch.
          c.ok(streamed.some((k) => k.endsWith(':gym-live-agree')),
            'the stream saw the write', streamed.join(' ') || '(nothing)');
          c.ok(byPoll.some((k) => k.endsWith(':gym-live-agree')),
            'and so did polling', byPoll.join(' ') || '(nothing)');
          c.ok(polled.rev > start, 'polling reports a revision that moved',
            `${start} -> ${polled.rev}`);

          // Polling is the guarantee; the stream is the optimisation. If they
          // disagree, whichever transport a client happened to get would change
          // what it believes - so this is the test that keeps them one feature.
          c.eq([...new Set(streamed)].sort().join('|'), byPoll.sort().join('|'),
            'stream and poll report the same changes for the same window');
          await table.del('characters', 'gym-live-agree', null);
        },
      },
      {
        id: 'changes_say_who',
        title: 'A change names the client that caused it',
        async run(c, { table }) {
          c.feature('live', 'sync');
          const start = (await table.changes(0)).rev;
          await table.put('characters', 'gym-live-who', { name: 'Who' }, null,
            'c-gym-probe');
          const seen = (await table.changes(start)).changes
            .find((x) => x.id === 'gym-live-who');
          c.ok(!!seen, 'the write was recorded');
          c.eq(seen?.by, 'c-gym-probe',
            'and carries the client id that made it');

          // Why this matters: without attribution a tab re-renders on the echo
          // of its OWN save. Typing in Build saves each keystroke, the save
          // bumps the revision, and the re-render moves the cursor mid-word.
          const anon = await table.changes(start);
          c.ok(anon.changes.every((x) => 'by' in x),
            'every change carries the field, even when nobody claimed it');
          await table.del('characters', 'gym-live-who', null);
        },
      },
      {
        id: 'events_bump_revision',
        title: 'A logged event moves the revision, so a story feed can be live',
        async run(c, { table }) {
          c.feature('live', 'sync', 'story');
          const start = (await table.changes(0)).rev;
          // The log is append-only by design, so this leaves one line in the
          // real file. It says exactly what it is, and the server stamps ts.
          const res = await fetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ id: `gym-ev-${Date.now()}`,
              type: 'journal', cat: 'journal',
              summary: 'Toon Anvil self-test: change-feed probe' }]),
          });
          c.ok(res.ok, 'the event was accepted', String(res.status));
          const after = await table.changes(start);
          c.ok(after.changes.some((x) => x.kind === 'events'),
            'and announced on the change feed as kind "events"',
            after.changes.map((x) => x.kind).join(','));
          // Without this, a DM story lens would look connected and simply
          // never update - the quietest possible failure.
        },
      },
      {
        id: 'table_actions_are_announced',
        title: 'Opening and joining a table are changes too',
        async run(c, { table }) {
          c.feature('live', 'sync', 'table');
          await table.close();
          const start = (await table.changes(0)).rev;

          const dm = await table.open('Live DM');
          const afterOpen = await table.changes(start);
          c.ok(afterOpen.changes.some((x) => x.kind === 'table'),
            'opening a table is announced');

          const mid = afterOpen.rev;
          await table.join(dm.code, 'Ren');
          const afterJoin = await table.changes(mid);
          c.ok(afterJoin.changes.some((x) => x.kind === 'table'),
            'so is a player joining - the DM sees them arrive without reloading');

          await table.close();
          const afterClose = await table.changes(afterJoin.rev);
          c.ok(afterClose.changes.some((x) => x.kind === 'table'),
            'and so is closing it, which revokes every token');
        },
      },
    ],
  },

  /* ---------------- the shared fight -------------------------------- */
  {
    id: 'shared',
    title: 'One fight, two sides of the screen',
    why: 'The DM and the players look at the same encounter from different '
       + 'seats. These tests check that what a player receives really is '
       + 'missing the numbers the DM withheld - not merely not drawn - and '
       + 'that the two views agree about everything else.',
    scenarios: [
      {
        id: 'snapshot_is_small_and_faithful',
        title: 'What goes over the wire is the fight, without the bestiary',
        run(c, { dm, monsters }) {
          c.feature('shared', 'encounter', 'sync');
          const runner = dm.runner;
          runner.reset();
          const ogre = monsters.find((m) => /ogre/i.test(m.name)) || monsters[0];
          runner.addMonsters(ogre, 2);
          const snap = runner.snapshot();

          c.eq(snap.id, runner.SHARED_ID, 'it is the one shared encounter');
          c.eq(snap.combatants.length, 2, 'both monsters travel');
          c.ok(snap.combatants.every((x) => x.stat === undefined),
            'the statblock is dropped - it is already in every compendium, '
            + 'and sending it would cost a few hundred kilobytes per hit point');
          const size = JSON.stringify(snap).length;
          c.ok(size < 4000, 'so a two-monster fight is small', `${size} bytes`);

          // Round-trip: what we send must be what we get back, or the DM's
          // screen and the players' drift apart after one reload.
          const before = JSON.stringify(snap);
          runner.reset();
          runner.adopt(snap);
          c.eq(JSON.stringify(runner.snapshot()), before,
            'adopting a snapshot reproduces it exactly');
          runner.reset();
        },
      },
      {
        id: 'runner_sides_and_concentration',
        title: 'The shared fight knows friend from foe and asks for the save',
        run(c, { dm, monsters }) {
          c.feature('shared', 'encounter', 'concentration');
          const runner = dm.runner;
          runner.reset();
          const ogre = monsters.find((m) => /ogre/i.test(m.name)) || monsters[0];
          runner.addMonsters(ogre, 1);
          c.eq(runner.state.combatants[0].side, 'enemy',
            'a monster arrives as an enemy');

          // Records from before sides existed default the way every fight
          // silently assumed: PCs for the party, everything else against.
          runner.reset();
          runner.adopt({ combatants: [
            { id: 'c1', kind: 'pc', name: 'Old PC', hp: 10, hpMax: 10 },
            { id: 'c2', kind: 'monster', name: 'Old Ogre', hp: 40, hpMax: 40 },
          ],
          round: 1, turn: 0, started: true });
          c.eq(runner.state.combatants[0].side, 'ally',
            'a legacy PC becomes an ally');
          c.eq(runner.state.combatants[1].side, 'enemy',
            'a legacy monster stays an enemy');

          runner.toggleSide('c2');
          c.eq(runner.state.combatants[1].side, 'ally',
            'the charmed ogre can switch sides');
          runner.toggleSide('c1');
          c.eq(runner.state.combatants[0].side, 'ally',
            'a PC cannot be flipped against the party');

          // Concentration: the engine computes max(10, floor(raw/2)) - the
          // runner used to strip the field, so the save was never asked for.
          runner.setConcentration('c1', 'Bless');
          const small = runner.applyTo('c1', -6);
          c.eq(small.concentrationDc, 10, 'small hits still mean a DC 10 save');
          const big = runner.applyTo('c1', -3);
          // 3 damage after a 6: fresh call, raw 3 -> still DC 10 floor.
          c.eq(big.concentrationDc, 10, 'the DC never drops below 10');
          runner.setConcentration('c2', 'Hold Person');
          const heavy = runner.applyTo('c2', -22);
          c.eq(heavy.concentrationDc, 11,
            'a heavy hit asks for half the raw damage');
          const heal = runner.applyTo('c2', 4);
          c.ok(!heal.concentrationDc, 'healing never asks for the save');
          runner.setConcentration('c1', '');
          const after = runner.applyTo('c1', -8);
          c.ok(!after.concentrationDc, 'clearing concentration clears the ask');

          const snap = runner.snapshot();
          c.ok(snap.combatants.every((x) => x.side === 'ally' || x.side === 'enemy'),
            'sides travel with the snapshot');
          c.eq(snap.combatants[1].concentrating, 'Hold Person',
            'and so does concentration');

          // At 0 HP there is no save - concentration simply ends, and the
          // record says so. (The bug this asserts against: the save toast
          // fired and was instantly overwritten by "is down".)
          const kill = runner.applyTo('c2', -50);
          c.ok(kill.downed && !kill.concentrationDc,
            'a downing hit asks for no save');
          c.eq(runner.state.combatants[1].concentrating, null,
            'the spell is gone from the record');
          runner.reset();
        },
      },
      {
        id: 'prepared_deploys_fresh',
        title: 'A prepared encounter deploys with freshly rolled hit points',
        run(c, { dm, monsters }) {
          c.feature('shared', 'encounter', 'prepared');
          const runner = dm.runner;
          runner.reset();
          const goblin = monsters.find((m) => /goblin/i.test(m.name))
            || monsters[0];
          runner.addMonsters(goblin, 3);
          // Save = group the roster by monster, exactly what the Stage does.
          const groups = {};
          for (const x of runner.state.combatants) {
            groups[x.monsterId] = (groups[x.monsterId] || 0) + 1;
          }
          const tpl = { id: 'tpl-t', name: 'Door Trap',
            monsters: Object.entries(groups)
              .map(([monsterId, count]) => ({ monsterId, count })) };
          c.eq(tpl.monsters.length, 1, 'the roster groups by monster');
          c.eq(tpl.monsters[0].count, 3, 'with the count carried');

          runner.reset();
          for (const m of tpl.monsters) {
            const mon = monsters.find((x) => x.id === m.monsterId);
            runner.addMonsters(mon, m.count);
          }
          c.eq(runner.state.combatants.length, 3, 'the whole template lands');
          c.ok(runner.state.combatants
            .every((x) => x.hp >= 1 && x.hp <= x.hpMax),
          'every deployed monster has hit points inside its own bounds',
          runner.state.combatants.map((x) => `${x.hp}/${x.hpMax}`).join(', '));
          c.ok(runner.state.combatants.every((x) => x.side === 'enemy'),
            'and arrives as an enemy');
          runner.reset();
        },
      },
      {
        id: 'board_positions_clamped_and_stable',
        title: 'Tokens stay on the map, and reinforcements never steal a turn',
        run(c, { dm, monsters }) {
          c.feature('shared', 'encounter', 'board');
          const runner = dm.runner;
          runner.reset();
          const goblin = monsters.find((m) => /goblin/i.test(m.name))
            || monsters[0];
          runner.addMonsters(goblin, 2);
          const [a, b] = runner.state.combatants;

          runner.setTokenPosition(a.id, 0.25, 0.75);
          c.ok(a.x === 0.25 && a.y === 0.75, 'a legal drop lands as given');
          runner.setTokenPosition(a.id, 4.2, -3);
          c.ok(a.x === 1 && a.y === 0, 'an off-map drop is clamped to the edge',
            `${a.x},${a.y}`);

          const snap = runner.snapshot();
          c.ok(snap.combatants[0].x === 1 && snap.combatants[0].y === 0,
            'positions travel with the snapshot');
          c.ok(!('x' in (snap.combatants[1] || {}))
            || snap.combatants[1].x === undefined,
          'an unplaced fighter carries no position at all');

          // A record from before the board existed adopts cleanly.
          runner.reset();
          runner.adopt({ combatants: [
            { id: 'c1', kind: 'pc', name: 'P', hp: 9, hpMax: 9 }],
          round: 2, turn: 0, started: true });
          c.ok(runner.state.combatants[0].x === undefined,
            'legacy records stay unplaced rather than inventing a spot');

          // Mid-fight reinforcements append - whoever was acting keeps
          // acting, whatever arrives through the ambush drawer.
          runner.reset();
          runner.addMonsters(goblin, 2);
          runner.state.started = true;
          runner.state.turn = 1;
          const acting = runner.state.combatants[1].id;
          runner.addMonsters(goblin, 3);
          c.eq(runner.state.combatants[runner.state.turn].id, acting,
            'the active combatant is unchanged by a deploy');
          c.eq(runner.state.combatants.length, 5, 'and everyone arrived');
          runner.reset();
        },
      },
      {
        id: 'adopt_keeps_ids_unique',
        title: 'Adding to an adopted fight does not collide with what arrived',
        run(c, { dm, monsters }) {
          c.feature('shared', 'encounter');
          const runner = dm.runner;
          runner.reset();
          runner.addMonsters(monsters[0], 3);
          const snap = runner.snapshot();
          const arrived = snap.combatants.map((x) => x.id);

          // Simulate a DM reloading: fresh module state, then adopt.
          runner.reset();
          runner.adopt(snap);
          runner.addMonsters(monsters[1] || monsters[0], 1);
          const ids = runner.state.combatants.map((x) => x.id);
          c.eq(new Set(ids).size, ids.length,
            'every combatant still has its own id', ids.join(','));
          c.ok(!arrived.includes(ids[ids.length - 1]),
            'the newcomer did not take an id that was already in the fight');
          runner.reset();
        },
      },
      {
        id: 'monster_hp_is_withheld_not_merely_undrawn',
        title: 'A player is not sent the numbers the DM is hiding',
        async run(c, { table }) {
          c.feature('shared', 'encounter', 'security');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const fight = {
            id: 'current', round: 2, turn: 0, started: true,
            showMonsterHp: false,
            combatants: [
              { id: 'c1', kind: 'pc', characterId: 'kim-1', name: 'Kim',
                ac: 16, hp: 22, hpMax: 30, init: 18 },
              { id: 'c2', kind: 'monster', name: 'Ogre',
                ac: 11, hp: 13, hpMax: 59, temp: 4, init: 9 },
            ],
          };
          await table.put('encounters', 'current', fight, dm.token);

          const asDm = await table.get('encounters', 'current', dm.token);
          c.eq(asDm.combatants[1].hp, 13, 'the DM still sees the real number');

          const asPlayer = await table.get('encounters', 'current', kim.token);
          const ogre = asPlayer.combatants.find((x) => x.name === 'Ogre');
          c.ok(!!ogre, 'the player still sees the monster is there');
          c.eq(ogre?.hp, undefined, 'but not its hit points');
          c.eq(ogre?.hpMax, undefined, 'nor its maximum');
          c.eq(ogre?.temp, undefined, 'nor its temporary hit points');
          c.eq(ogre?.band, 'bloodied', 'only how hurt it looks');

          // The point of doing this on the server. A UI that merely declines
          // to draw the number leaves it sitting in the payload, where the
          // network tab shows it to anyone curious. Scoped to the combatants:
          // the record also carries updatedAt, and at minute or second 59 the
          // TIMESTAMP contains "59" - this check failed on the clock once.
          const wire = JSON.stringify(asPlayer.combatants);
          c.ok(!wire.includes('59'),
            'the hidden number is nowhere in the combatants sent', wire.slice(0, 200));

          // Player characters keep their numbers: everyone at a real table can
          // see their own sheet and says "I'm on 22" out loud.
          const me = asPlayer.combatants.find((x) => x.kind === 'pc');
          c.eq(me?.hp, 22, 'player characters keep their hit points');

          await table.del('encounters', 'current', dm.token);
          await table.close();
        },
      },
      {
        id: 'only_the_dm_spends_the_key',
        title: 'A player at the table cannot spend the API key of the DM',
        why: 'These were the only POST routes in the server with no guard of any kind. '
           + 'Every other privileged route checks a token; /api/llm, /api/image and '
           + '/api/sfx checked nothing, so under --lan any phone at the table could run '
           + 'up a bill on the key belonging to the DM. A cost you cannot cap is a cost '
           + 'you cannot quote, which '
           + 'makes this a prerequisite for the price list rather than a nicety.',
        async run(c, { table }) {
          c.feature('connectors', 'permissions', 'security', 'cost');
          await table.close();

          // Solo: no table, and the request comes from the machine running
          // the server. It must go THROUGH - a 502 for 'no model' is the
          // gate letting it past, which is what solo play needs.
          const solo = await table.llm({ prompt: 'hi', capability: 'npc_voice' });
          c.ok(solo.status !== 401 && solo.status !== 403,
            'with no table open, this machine may still use a connector',
            String(solo.status));

          const opened = await table.open('Gym DM');
          const joined = await table.join(opened.code, 'Kim');

          const asPlayer = await table.llm({ prompt: 'hi' }, joined.token);
          c.eq(asPlayer.status, 403, 'a seated player is refused');
          const asNobody = await table.llm({ prompt: 'hi' });
          c.eq(asNobody.status, 401,
            'and a browser with no seat is refused too');

          const asDm = await table.llm({ prompt: 'hi' }, opened.token);
          c.ok(asDm.status !== 401 && asDm.status !== 403,
            'the DM gets through', String(asDm.status));

          // The privacy rule, enforced rather than promised. A capability
          // carrying the user's own writing is local-only, so with no local
          // model it must REFUSE - never quietly reach for a hosted one.
          const userContent = await table.llm(
            { prompt: 'summarise', capability: 'session_recap' }, opened.token);
          c.ok(!userContent.body.ok,
            'a capability carrying your own writing does not just go anywhere');
          c.ok(/local model/i.test(String(userContent.body.error || '')),
            'and says why, naming the local-model rule',
            String(userContent.body.error).slice(0, 80));

          // An unclamped completion length is how one call becomes a bill.
          // It must be accepted and clamped, not honoured and not rejected.
          const huge = await table.llm(
            { prompt: 'hi', maxTokens: 999999 }, opened.token);
          c.ok(huge.status !== 500,
            'an absurd maxTokens is clamped rather than crashing the server',
            String(huge.status));

          // A capability id nobody has heard of used to be the MOST permissive
          // path in the file: no row means no contentClass, so a misspelt
          // session_recap would have been treated as carrying nothing. A
          // safety rule a typo can switch off is not a safety rule.
          const typo = await table.llm(
            { prompt: 'hi', capability: 'sesion_recap' }, opened.token);
          c.eq(typo.status, 400,
            'a capability that is not in the catalogue is refused, not assumed harmless');
          await table.close();
        },
      },
      {
        id: 'only_the_dm_starts_the_session',
        title: 'The lobby latch belongs to the DM, and a player cannot touch it',
        why: 'Starting drags every seat out of the lobby at once. If a player '
           + 'could flip it they could yank four other phones onto their '
           + 'character sheets mid-sentence, or shove everyone back into the '
           + 'queue in the middle of a fight. Same reasoning as the forge: '
           + 'close has a local-machine hatch for disaster recovery, start '
           + 'deliberately has none.',
        async run(c, { table }) {
          c.feature('table', 'lobby', 'permissions', 'security');
          await table.close();

          const opened = await table.open('Gym DM');
          const dm = opened.token;
          c.ok(Boolean(dm), 'the table opened');

          // A fresh table has NOT started: gathering is the resting state,
          // or everyone would boot straight past the lobby they came for.
          const fresh = await table.status(dm);
          c.eq(fresh.body.started, false, 'a new table has not started');

          const joined = await table.join(opened.code, 'Kim');
          const player = joined.token;
          c.ok(Boolean(player), 'a player joined');

          // The refusal, over HTTP. Hiding the button proves nothing.
          const forged = await table.start(true, player);
          c.eq(forged.status, 403, 'a player cannot start the session');
          const unseated = await table.start(true, null);
          c.ok(unseated.status === 401 || unseated.status === 403,
            'and neither can a browser with no seat at all',
            String(unseated.status));
          c.eq((await table.status(dm)).body.started, false,
            'so it is still not started');

          // The DM can, and every seat can SEE it - the flag is public
          // state, because a player screen has to act on it.
          c.eq((await table.start(true, dm)).body.started, true,
            'the DM starts it');
          c.eq((await table.status(player)).body.started, true,
            'and the player receives that, which is what leaves the queue');

          // Reversible: a DM who started by accident is not stuck.
          c.eq((await table.start(false, dm)).body.started, false,
            'the DM can send everyone back to the lobby');

          // Closing forgets it, so the next table starts by gathering.
          await table.start(true, dm);
          await table.close();
          const after = await table.open('Gym DM 2');
          c.eq((await table.status(after.token)).body.started, false,
            'a NEW table has not inherited the previous start');
          await table.close();
        },
      },
      {
        id: 'table_carries_campaign',
        title: 'The table says what the room is playing, to every seat',
        why: 'Before this, "which campaign" was a per-browser answer - an '
           + 'active flag plus localStorage - so the session itself never '
           + 'knew, and a player queueing in the lobby could not be told what '
           + 'they were queueing for. The fields are id and display name '
           + 'ONLY: the campaign record itself stays behind redact_campaign, '
           + 'and a pickup game that names no campaign is a way to play, not '
           + 'a validation error.',
        async run(c, { table }) {
          c.feature('table', 'lobby', 'campaign');
          await table.close();

          const opened = await table.open('Gym DM', {
            campaignId: 'camp-gym-probe', campaignName: 'Gym Campaign',
          });
          c.ok(Boolean(opened.token), 'the table opened with a campaign named');

          const dm = await table.status(opened.token);
          c.eq(dm.body.campaignId, 'camp-gym-probe', 'the DM sees the id');
          c.eq(dm.body.campaignName, 'Gym Campaign', 'and the name');

          // Public like started/forgeOpen: the player's queue renders it.
          const joined = await table.join(opened.code, 'Kim');
          const player = await table.status(joined.token);
          c.eq(player.body.campaignName, 'Gym Campaign',
            'a seated player is told what the room is playing');
          const nobody = await table.status(null);
          c.eq(nobody.body.campaignName, 'Gym Campaign',
            'so is an unseated browser - it is a title, not a secret');

          // Only the two display fields ride along. The record itself keeps
          // going through redact_campaign like always.
          c.ok(!('campaign' in player.body) && !('lore' in player.body),
            'and nothing else campaign-shaped rides the table status');

          // A hostile id is dropped rather than stored: the field becomes
          // part of a record other seats read.
          await table.close();
          const nasty = await table.open('Gym DM', {
            campaignId: '../../etc/passwd', campaignName: 'Nasty',
          });
          c.eq((await table.status(nasty.token)).body.campaignId, null,
            'an id that could escape the data directory is refused');

          // A pickup game: no campaign, no complaint, nulls all the way.
          await table.close();
          const pickup = await table.open('Gym DM');
          const st = await table.status(pickup.token);
          c.eq(st.body.campaignId, null, 'a pickup game carries no id');
          c.eq(st.body.campaignName, null, 'and no name');

          // The closed-table shape is unchanged: still no code key at rest.
          await table.close();
          const closed = await table.status(null);
          c.ok(!('code' in closed.body),
            'a closed table still never carries the code');
        },
      },
      {
        id: 'not_joined_is_not_privileged',
        title: 'A browser that never joined sees a player\'s view, not the DM\'s',
        why: 'Found at a real table: whoami() answers None BOTH for "no table, '
           + 'nobody to hide from" and for "a table is open and you are not '
           + 'seated". The redactors see only a profile and read None as the '
           + 'first, so any unjoined device on the wifi was handed monster hit '
           + 'points, agendas, lore, prepared encounters and secret clocks.',
        async run(c, { table }) {
          c.feature('shared', 'security', 'permissions');
          await table.close();

          const fight = {
            id: 'current', round: 1, turn: 0, started: true,
            showMonsterHp: false,
            combatants: [{ id: 'c1', kind: 'monster', name: 'Ogre',
              ac: 11, hp: 13, hpMax: 59 }],
          };
          const camp = { id: 'gym-unseated-camp', name: 'Unseated Vale',
            day: 3, seed: 11, regions: [], lore: ['LOREONLYTHEDMSEES'],
            factions: [{ id: 'f1', name: 'The Hand', standing: 0,
              public: true, agenda: 'AGENDAONLYTHEDMSEES' }],
            encounterTemplates: [{ id: 't1', name: 'TEMPLATEONLYTHEDMSEES',
              monsters: [] }],
            clocks: [{ id: 'k1', label: 'CLOCKONLYTHEDMSEES', size: 4,
              filled: 1, public: false }] };

          // Solo first: with NO table open, a tokenless read is the whole
          // record. This half is the reason the bug existed - it must stay
          // true, or the fix has broken playing alone.
          await table.put('encounters', 'current', fight, null);
          await table.put('campaigns', camp.id, camp, null);
          const soloEnc = await table.get('encounters', 'current', null);
          const soloCamp = await table.get('campaigns', camp.id, null);
          c.eq(soloEnc.combatants[0].hp, 13,
            'no table open: the record is whole, solo play untouched');
          c.ok(JSON.stringify(soloCamp).includes('AGENDAONLYTHEDMSEES'),
            'and the campaign keeps its secrets for its only reader');

          // Now open a table and ask again with no token at all.
          const dm = await table.open('Gym DM');
          const anonEnc = await table.get('encounters', 'current', null);
          const ogre = anonEnc.combatants[0];
          c.eq(ogre.hp, undefined,
            'table open + no seat: monster hit points are withheld');
          c.eq(ogre.band, 'bloodied', 'a band goes over the wire instead');

          const anonCamp = JSON.stringify(
            await table.get('campaigns', camp.id, null));
          c.ok(!anonCamp.includes('AGENDAONLYTHEDMSEES'),
            'faction agendas are withheld too');
          c.ok(!anonCamp.includes('LOREONLYTHEDMSEES'), 'and the lore');
          c.ok(!anonCamp.includes('TEMPLATEONLYTHEDMSEES'),
            'and the prepared encounters');
          c.ok(!anonCamp.includes('CLOCKONLYTHEDMSEES'),
            'and the secret clocks');

          // The list route reads the same files; it was missed once before.
          const anonList = JSON.stringify(
            (await table.get('campaigns', '', null)) || '');
          const listRaw = await fetch('/api/campaigns').then((r) => r.text());
          c.ok(!listRaw.includes('AGENDAONLYTHEDMSEES')
            && !listRaw.includes('CLOCKONLYTHEDMSEES'),
          'on the list route as well as the single one',
          anonList.slice(0, 40));

          // And the DM still sees everything - least privilege for the
          // unseated must not become least privilege for everyone.
          const asDm = JSON.stringify(
            await table.get('campaigns', camp.id, dm.token));
          c.ok(asDm.includes('AGENDAONLYTHEDMSEES')
            && asDm.includes('CLOCKONLYTHEDMSEES'),
          'while the DM still sees the whole record');

          await table.close();
          await table.del('encounters', 'current', null);
          await table.del('campaigns', camp.id, null);
        },
      },
      {
        id: 'the_dm_can_open_the_numbers',
        title: 'Turning enemy HP on actually sends it',
        async run(c, { table }) {
          c.feature('shared', 'encounter');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          const body = (show) => ({ id: 'current', showMonsterHp: show,
            combatants: [{ id: 'c1', kind: 'monster', name: 'Ogre',
              ac: 11, hp: 13, hpMax: 59 }] });

          await table.put('encounters', 'current', body(false), dm.token);
          const hidden = await table.get('encounters', 'current', kim.token);
          c.eq(hidden.combatants[0].hp, undefined, 'hidden by default');

          await table.put('encounters', 'current', body(true), dm.token);
          const shown = await table.get('encounters', 'current', kim.token);
          c.eq(shown.combatants[0].hp, 13, 'and shown once the DM says so');
          c.eq(shown.combatants[0].hpMax, 59, 'maximum included');
          c.eq(shown.combatants[0].band, undefined,
            'with no band, because the number is the better answer');

          await table.del('encounters', 'current', dm.token);
          await table.close();
        },
      },
      {
        id: 'the_log_is_redacted_like_everything_else',
        title: 'The DM\'s prep does not travel in the shared event log',
        async run(c, { table }) {
          c.feature('shared', 'events', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          // One secret clock and one public one, one secret faction.
          await table.put('campaigns', 'gym-leak', {
            id: 'gym-leak', name: 'Leak', day: 1,
            clocks: [
              { id: 'k-secret', label: 'CLOCKONLYTHEDMSEES', size: 6, filled: 5, public: false },
              { id: 'k-open', label: 'Harvest festival', size: 4, filled: 1, public: true },
            ],
            factions: [
              { id: 'g-secret', name: 'FACTIONONLYTHEDMSEES', standing: -3, public: false },
            ],
          }, dm.token);

          const stamp = `gym-leak-${Date.now()}`;
          await table.logEvents([
            // summary is where describe() bakes payload text, and a fix that
            // only cleans the payload leaves the secret in the next field.
            { id: `${stamp}-1`, type: 'clock_advanced', cat: 'world',
              campaignId: 'gym-leak', summary: 'CLOCKONLYTHEDMSEES struck',
              payload: { clockId: 'k-secret', filled: 6, size: 6, struck: true } },
            { id: `${stamp}-2`, type: 'clock_advanced', cat: 'world',
              campaignId: 'gym-leak', summary: 'A clock struck',
              payload: { clockId: 'k-open', filled: 4, size: 4, struck: true } },
            { id: `${stamp}-3`, type: 'faction_standing', cat: 'world',
              campaignId: 'gym-leak', summary: 'FACTIONONLYTHEDMSEES: standing -3',
              payload: { factionId: 'g-secret', value: -3 } },
            { id: `${stamp}-4`, type: 'section_filed', cat: 'world',
              campaignId: 'gym-leak', summary: 'LOREONLYTHEDMSEES filed as lore',
              payload: { title: 'LOREONLYTHEDMSEES', as: 'lore' } },
            { id: `${stamp}-5`, type: 'encounter_start', cat: 'combat',
              campaignId: 'gym-leak', summary: 'A fight began',
              payload: { name: 'AMBUSHONLYTHEDMSEES', combatants: ['Lich', 'Goblin'] } },
          ], dm.token);

          const mine = await table.events('limit=2000&campaign=gym-leak', kim.token);
          const seen = JSON.stringify(mine.body);
          for (const secret of ['CLOCKONLYTHEDMSEES', 'FACTIONONLYTHEDMSEES',
            'LOREONLYTHEDMSEES', 'AMBUSHONLYTHEDMSEES', 'Lich']) {
            c.ok(!seen.includes(secret), `${secret} never reaches a player`);
          }
          // Scope the COUNTS to this run. The log is append-only and
          // outlives the run that wrote it, so a second pass over the same
          // instance sees both sets and "expected 1, got 2" - the same trap
          // that made the dice rail open on last session's dice.
          const ours = (mine.body || [])
            .filter((e) => String(e.id || '').startsWith(stamp));
          const kinds = ours.map((e) => e.type);
          c.eq(kinds.filter((k) => k === 'clock_advanced').length, 1,
            'the public clock survives and the secret one is absent, '
            + 'not merely blanked', kinds.join(','));
          const fight = ours.find((e) => e.type === 'encounter_start');
          c.eq(fight?.payload?.combatants, 2,
            'a roster becomes a count', JSON.stringify(fight?.payload));

          // The DM is the one person allowed to know.
          const theirs = await table.events('limit=2000&campaign=gym-leak', dm.token);
          const dmSaw = JSON.stringify(theirs.body);
          c.ok(dmSaw.includes('FACTIONONLYTHEDMSEES')
            && dmSaw.includes('LOREONLYTHEDMSEES')
            && dmSaw.includes('AMBUSHONLYTHEDMSEES'),
          'while the DM still sees all of it');

          await table.del('campaigns', 'gym-leak', dm.token);
          await table.close();
        },
      },
      {
        id: 'only_the_dm_authors_the_world',
        title: 'A player cannot forge what the world did',
        async run(c, { table }) {
          c.feature('shared', 'events', 'permissions');
          await table.close();
          const dm = await table.open('Gym DM');
          const kim = await table.join(dm.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          // `cat` arrives in the request body, so it is worth nothing - the
          // server judges the TYPE against its own list.
          const forged = await table.logEvents([{
            id: `gym-forge-${Date.now()}`, type: 'clock_advanced',
            cat: 'journal', payload: { clockId: 'k-secret' },
          }], kim.token);
          c.eq(forged.status, 403,
            'a player forging a clock strike is refused, whatever cat says',
            JSON.stringify(forged.body).slice(0, 90));

          // Their own play still lands - rp.js depends on exactly this.
          const beat = await table.logEvents([{
            id: `gym-beat-${Date.now()}`, type: 'npc_met', cat: 'rp',
            payload: { name: 'Harbourmaster' },
          }], kim.token);
          c.eq(beat.status, 200, 'but their own roleplay beat still lands');

          const world = await table.logEvents([{
            id: `gym-dm-${Date.now()}`, type: 'day_advanced', cat: 'world',
            payload: { day: 2 },
          }], dm.token);
          c.eq(world.status, 200, 'and the DM still authors the world');
          await table.close();
        },
      },
      {
        id: 'bands_agree_across_the_wire',
        title: 'The server and the client draw the same line at bloodied',
        async run(c, { table, dm }) {
          c.feature('shared', 'encounter');
          await table.close();
          const host = await table.open('Gym DM');
          const kim = await table.join(host.code, 'Kim');
          if (!kim.ok) { c.ok(false, 'the player joined'); return; }

          // The band lives in two places - hp_band() in tools/table.py decides
          // what a player receives, band() in runner.js lets the DM preview it.
          // Two implementations of one rule drift; this is what stops them.
          // An EVEN maximum, so "exactly half" is a real value. The first
          // version of this used 30/59 and called it half - it is 50.8%, and
          // the assertion failed while both implementations agreed perfectly.
          const cases = [
            { hp: 60, hpMax: 60 }, { hp: 59, hpMax: 60 },
            { hp: 30, hpMax: 60 }, { hp: 29, hpMax: 60 },
            { hp: 1, hpMax: 60 }, { hp: 0, hpMax: 60 },
            { hp: 7, hpMax: 7 }, { hp: 4, hpMax: 7 },
          ];
          await table.put('encounters', 'current', {
            id: 'current',
            showMonsterHp: false,
            combatants: cases.map((x, i) => ({
              id: `c${i}`, kind: 'monster', name: `M${i}`, ac: 10, ...x })),
          }, host.token);

          const asPlayer = await table.get('encounters', 'current', kim.token);
          for (const [i, x] of cases.entries()) {
            const fromServer = asPlayer.combatants[i].band;
            const fromClient = dm.runner.band(x);
            c.eq(fromServer, fromClient,
              `${x.hp}/${x.hpMax} is "${fromClient}" on both sides`);
          }
          // And that the boundary is where 5e puts it, not one off it.
          c.eq(asPlayer.combatants[2].band, 'bloodied', 'exactly half is bloodied');
          c.eq(asPlayer.combatants[1].band, 'hurt', 'just below full is only hurt');

          await table.del('encounters', 'current', host.token);
          await table.close();
        },
      },
      {
        id: 'solo_never_publishes',
        title: 'A solo DM never touches the network',
        async run(c, { table, dm }) {
          c.feature('shared', 'encounter');
          await table.close();
          const runner = dm.runner;
          runner.reset();

          c.ok(!runner.isShared(),
            'with no table open the encounter is not shared');
          const out = await runner.publish();
          c.ok(out.skipped, 'publishing is skipped rather than attempted');
          c.eq(await runner.pull(), null, 'and there is nothing to pull');

          // The promise the runner has always made: an encounter is scratch.
          runner.reset();
          c.eq(runner.state.combatants.length, 0, 'reset still clears it');
        },
      },
    ],
  },

  /* ---------------- cross-engine agreement ------------------------- */
  {
    id: 'agreement',
    title: 'One engine, not two',
    why: 'The app and the simulator must agree. The whole premise is that the '
       + 'sheet you print and the numbers we measure come from the same code.',
    scenarios: [
      {
        id: 'hp_agreement',
        title: 'App and simulator compute the same hit points',
        async run(c, { sources, sim }) {
          c.feature('agreement', 'hp');
          for (const [cls, level] of [['fighter', 1], ['fighter', 10],
            ['wizard', 5], ['barbarian', 20], ['rogue', 13]]) {
            const ch = sim.makeCharacter(cls, null, level, sources);
            const d = derive(ch, sources);
            c.eq(d.hp.max, ch.hp.max, `${cls} L${level}: sim and derive agree on HP`);
          }
        },
      },
      {
        id: 'attack_agreement',
        title: 'Attack bonuses match between sheet and simulation',
        async run(c, { sources, sim }) {
          c.feature('agreement', 'attacks');
          const ch = sim.makeCharacter('fighter', null, 5, sources);
          const d = derive(ch, sources);
          c.ok(d.attacks.length > 0, 'a simulated fighter has an attack');
          for (const a of d.attacks) {
            c.ok(Number.isFinite(a.attackBonus),
              `${a.name} has a finite attack bonus`);
          }
        },
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run the logic tier.
 *
 * ctx is built by the caller so this module never imports the app shell - the
 * gym has to be runnable without a DOM.
 */
export async function runLogic(ctx, { onProgress = () => {} } = {}) {
  const suites = [];
  for (const suite of SUITES) {
    const scenarios = [];
    for (const sc of suite.scenarios) {
      const check = new Check(sc.id);
      const t0 = performance.now();
      let error = null;
      try {
        await sc.run(check, ctx);
      } catch (err) {
        error = `${err.name}: ${err.message}`;
      }
      // A scenario that asserted nothing is a failure, not a pass. This is the
      // oldest way a suite reports green while testing nothing.
      const empty = !error && check.total === 0;
      scenarios.push({
        id: sc.id,
        title: sc.title,
        passed: check.passed,
        total: check.total,
        failures: check.failures,
        features: [...check.touched],
        metrics: [...check.metrics.values()],
        error,
        empty,
        ok: !error && !empty && check.failures.length === 0,
        ms: +(performance.now() - t0).toFixed(1),
      });
      onProgress({ suite: suite.id, scenario: sc.id });
    }
    suites.push({
      id: suite.id,
      title: suite.title,
      why: suite.why,
      scenarios,
      passed: scenarios.filter((s) => s.ok).length,
      total: scenarios.length,
      checks: scenarios.reduce((n, s) => n + s.total, 0),
      checksPassed: scenarios.reduce((n, s) => n + s.passed, 0),
    });
  }
  return suites;
}

/* ------------------------------------------------------------------ */
/* grading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pre-registered bars.
 *
 * Written down before the run, so a disappointing result cannot be rescued by
 * moving the line afterwards. Scenario pass rate is 1.0 on purpose: a failing
 * integration test is a broken feature, not a score to average.
 */
export const BARS = {
  scenarioPassRate: 1.0,
  checkPassRate: 1.0,
  minChecksPerScenario: 2,
  // Raised from 18 when the combat, encounter, spell and integration suites
  // landed. A coverage bar that never moves as the suite grows stops being a
  // bar and becomes decoration - it would read green forever while the ratio
  // of things tested to things shipped quietly fell.
  // Raised again (34 -> 38) with the shells, the Deck, the weather, the map
  // and the economy. The ratchet only means something if it moves when the
  // app grows.
  // And again (38 -> 40) with the shelf and its book detector.
  // And again (40 -> 42) with setup-from-the-shelf and the forecast.
  // And again (42 -> 43) with starting equipment.
  // And again (43 -> 45) with HP overrides and the browsable bestiary.
  // And again (45 -> 46) with the spellbook.
  // And again (46 -> 47) with the corpus-vectors pipeline.
  // And again (47 -> 48) with reaction classification and action payloads.
  // And again (48 -> 50) with the couch epic: the QR join path and the
  // pregen forge.
  // And again (50 -> 52) with the RPG-feel epic: roll cards, the phone
  // pass, the dice feed, death saves, seat colours.
  // And again (52 -> 55) with the strategy-DM epic: prepared encounters,
  // the battle board, the cockpit, clocks.
  // And again (55 -> 56) when the app learned to say which version it is.
  // And again (56 -> 57) when sound became a choice each device makes.
  minFeaturesCovered: 57,
  // Renamed from uiModesRendering when the UI tier stopped merely checking
  // that a mode rendered and started clicking through it. "Rendering" was a
  // much weaker claim and the name would have kept implying it.
  uiFlowsPassing: 1.0,
};

export function grade(suites, ui = null) {
  const scenarios = suites.flatMap((s) => s.scenarios);
  const checks = scenarios.reduce((n, s) => n + s.total, 0);
  const checksPassed = scenarios.reduce((n, s) => n + s.passed, 0);
  // Coverage counts both tiers: a feature only the UI tier touches is still
  // covered, and it is often the ONLY tier that can touch it.
  const features = new Set([
    ...scenarios.flatMap((s) => s.features),
    ...(ui || []).flatMap((f) => f.features || []),
  ]);

  const thin = scenarios.filter(
    (s) => !s.error && s.total < BARS.minChecksPerScenario,
  );

  const scenarioPassRate = scenarios.length
    ? scenarios.filter((s) => s.ok).length / scenarios.length : 0;
  const checkPassRate = checks ? checksPassed / checks : 0;
  const uiRate = ui ? ui.filter((m) => m.ok).length / Math.max(1, ui.length) : null;

  const bars = [
    { id: 'scenarioPassRate', value: scenarioPassRate, bar: BARS.scenarioPassRate,
      ok: scenarioPassRate >= BARS.scenarioPassRate },
    { id: 'checkPassRate', value: checkPassRate, bar: BARS.checkPassRate,
      ok: checkPassRate >= BARS.checkPassRate },
    { id: 'featuresCovered', value: features.size, bar: BARS.minFeaturesCovered,
      ok: features.size >= BARS.minFeaturesCovered },
    // Named separately because "no failures" and "asserted enough to mean
    // something" are different claims.
    { id: 'noThinScenarios', value: scenarios.length - thin.length,
      bar: scenarios.length, ok: thin.length === 0 },
  ];
  if (uiRate !== null) {
    bars.push({ id: 'uiFlowsPassing', value: uiRate, bar: BARS.uiFlowsPassing,
      ok: uiRate >= BARS.uiFlowsPassing });
  }

  // UI assertions are counted and reported SEPARATELY rather than folded into
  // the logic totals. They are a different kind of evidence - slower, fewer,
  // and about what the screen says rather than what a function returns - and
  // averaging the two would let a big fast suite hide a failing journey.
  const uiChecks = ui ? ui.reduce((n, f) => n + (f.total || 0), 0) : 0;
  const uiPassed = ui ? ui.reduce((n, f) => n + (f.passed || 0), 0) : 0;

  /**
   * Measurements, gathered but never graded.
   *
   * Deliberately absent from `bars`: BARS is the gate every developer runs
   * before a commit, and a research number in there would redden the gym
   * for everyone the first time a screen got one tap slower. Reach and ease
   * bars live in sim/bars.json and are read by the night report instead.
   *
   * `values` is kept whole, not just the mean, because a median and an IQR
   * cannot be recovered from a mean and nobody can tell a flat distribution
   * from a bimodal one after the fact.
   */
  const metrics = {};
  const metricRows = [...scenarios, ...(ui || [])]
    .flatMap((s) => s.metrics || []);
  for (const row of metricRows) {
    if (!Number.isFinite(row.value)) continue;
    const m = metrics[row.name] || (metrics[row.name] = {
      n: 0, sum: 0, min: Infinity, max: -Infinity, unit: row.unit, values: [],
    });
    m.n += 1;
    m.sum += row.value;
    m.values.push(row.value);
    if (row.value < m.min) m.min = row.value;
    if (row.value > m.max) m.max = row.value;
  }
  for (const m of Object.values(metrics)) {
    // n is 0 only if nothing was recorded, and a mean of nothing is null,
    // never 0 - a 0 here would read as "measured, and it was zero".
    m.mean = m.n ? m.sum / m.n : null;
  }

  return {
    scenarios: scenarios.length,
    scenariosPassed: scenarios.filter((s) => s.ok).length,
    checks,
    checksPassed,
    ui: ui ? {
      flows: ui.length,
      flowsPassed: ui.filter((f) => f.ok).length,
      checks: uiChecks,
      checksPassed: uiPassed,
    } : null,
    features: [...features].sort(),
    metrics,
    thin: thin.map((s) => `${s.id} (${s.total} checks)`),
    errors: [
      ...scenarios.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`),
      ...(ui || []).filter((f) => f.error).map((f) => `ui/${f.id}: ${f.error}`),
    ],
    failures: [
      ...scenarios.flatMap((s) => s.failures.map(
        (f) => `${s.id}: ${f.label}${f.detail ? ` - ${f.detail}` : ''}`,
      )),
      ...(ui || []).flatMap((s) => s.failures.map(
        (f) => `ui/${s.id}: ${f.label}${f.detail ? ` - ${f.detail}` : ''}`,
      )),
    ],
    bars,
    pass: bars.every((b) => b.ok),
  };
}

/* ------------------------------------------------------------------ */
/* mutation check - does the gym actually detect breakage?             */
/* ------------------------------------------------------------------ */

/**
 * Known defects, injected on purpose.
 *
 * A green suite proves nothing on its own: it might be detecting real
 * correctness, or it might be asserting things that cannot fail. The only way
 * to tell the two apart is to break the code deliberately and check that the
 * suite goes red. A mutation that survives marks a blind spot, and the honest
 * response is to write the missing assertion rather than to enjoy the green.
 *
 * Each mutation is patched into the CONTEXT rather than the module, so nothing
 * on disk changes and the check is safe to run any time.
 */
export const MUTATIONS = [
  {
    id: 'no_resistance',
    what: 'mitigate() stops halving resistant damage',
    patch: (ctx) => ({ engine: { ...ctx.engine,
      mitigate: (n) => ({ amount: n, applied: null }) } }),
  },
  {
    id: 'negative_hp',
    what: 'applyDamage() lets hit points go negative',
    patch: (ctx) => ({ engine: { ...ctx.engine,
      applyDamage: (s, d) => ({ hp: (s.hp?.current ?? 0) + d, temp: 0,
        downed: false, events: [] }) } }),
  },
  {
    id: 'infinite_resources',
    what: 'spendResource() never refuses an overdraw',
    patch: (ctx) => ({ engine: { ...ctx.engine,
      spendResource: (ch, d, nm) => ({
        resourceState: { ...(ch.resourceState || {}), [nm]: -999 }, events: [] }) } }),
  },
  {
    id: 'table_index',
    what: 'rollOnTable() picks an index instead of rolling the die',
    // This is not hypothetical - it is the bug this project actually shipped
    // once, where a d20 table with 8 entries gave the last row 12% of the time
    // instead of 65%.
    patch: (ctx) => ({ engine: { ...ctx.engine,
      rollOnTable: (t, rng) => {
        const i = rng.int(t.entries.length);
        return { entry: t.entries[i], n: i + 1, short: false };
      } } }),
  },
  {
    id: 'loot_ignores_cr',
    what: 'rollHoard() returns the same trivial hoard at every CR',
    patch: (ctx) => ({ dm: { ...ctx.dm,
      loot: { ...ctx.dm.loot,
        rollHoard: () => ({ cr: 0, seed: 0, band: '0-4', individual: false,
          coins: [{ unit: 'gp', amount: 1 }], valuables: [], items: [],
          totalGp: 1 }) } } }),
  },
  {
    id: 'generators_not_reproducible',
    what: 'generators ignore their seed',
    // The whole promise of a seeded generator is that a DM can write the
    // number down and get the result back. Silently losing that is invisible
    // at the table until the moment it matters.
    patch: (ctx) => ({ dm: { ...ctx.dm,
      gen: { ...ctx.dm.gen,
        rollAll: (t, m, o) => ctx.dm.gen.rollAll(t, m,
          { ...o, seed: Math.floor(Math.random() * 1e9) }) } } }),
  },
  {
    id: 'runner_drops_resistance',
    what: 'the encounter runner stops applying resistance',
    patch: (ctx) => ({ dm: { ...ctx.dm,
      runner: { ...ctx.dm.runner,
        applyTo: (id, delta) => {
          const c = ctx.dm.runner.state.combatants.find((x) => x.id === id);
          if (!c) return null;
          c.hp = Math.max(0, c.hp + delta);
          return { landed: Math.abs(delta), mitigation: null, downed: c.hp === 0 };
        } } } }),
  },
  {
    id: 'stream_goes_silent',
    what: 'the change stream connects but never pushes anything',
    // The failure that would be hardest to notice by hand: everything looks
    // connected, and the table just quietly stops updating.
    patch: (ctx) => ({ table: { ...ctx.table,
      stream: async () => ({ error: null, messages: [] }) } }),
  },
  {
    id: 'changes_never_report_gaps',
    what: '/api/changes always says gap:false',
    // A client that fell behind would then never re-read, and would show stale
    // hit points indefinitely while looking perfectly healthy.
    patch: (ctx) => ({ table: { ...ctx.table,
      changes: async (since) => ({ ...(await ctx.table.changes(since)), gap: false }) } }),
  },
  {
    id: 'nav_ignores_the_gate',
    what: 'navFor() shows every mode to everybody, gate or no gate',
    // The menu-only failure this whole design refuses to be: Build and the
    // solo Combat tracker offered to a gated player. The server would still
    // refuse the writes - but the app would be lying about what is possible.
    patch: (ctx) => ({ session: { ...ctx.session,
      navFor: (args, modes) => modes } }),
  },
  {
    id: 'events_changes_hidden',
    what: 'the change feed drops every "events" entry',
    // The stale-story-feed failure: the DM\'s Story lens looks connected and
    // simply never updates. Same family as stream_goes_silent.
    patch: (ctx) => ({ table: { ...ctx.table,
      changes: async (since) => {
        const out = await ctx.table.changes(since);
        return { ...out, changes: (out.changes || [])
          .filter((x) => x.kind !== 'events') };
      } } }),
  },
  {
    id: 'weather_label_not_mixed',
    what: 'weatherFor derives its stream from the seed alone, ignoring day and region',
    // The exact bug class this project shipped once in the improv generators.
    patch: (ctx) => ({ campaign: { ...ctx.campaign,
      weatherFor: (t, { seed, region }) => ctx.campaign.weatherFor(t,
        { seed, day: 1, region: { ...region, id: 'x' } }) } }),
  },
  {
    id: 'price_mod_ignored',
    what: 'unitPrice drops the region modifier',
    // The Deck dial would turn and every Market would shrug.
    patch: (ctx) => ({ campaign: { ...ctx.campaign,
      unitPrice: (base, att) => ctx.campaign.unitPrice(base, att, 1) } }),
  },
  {
    id: 'events_carry_the_dms_prep',
    what: 'the event log hands a player the secret it was redacted of',
    // The shape the leak actually had: the kind routes redact, this one
    // does not, and the label rides along in a field nobody looked at.
    patch: (ctx) => ({ table: { ...ctx.table,
      events: async (qs, token) => {
        const r = await ctx.table.events(qs, token);
        if (Array.isArray(r?.body)) {
          r.body = r.body.map((e) => (e?.type === 'clock_advanced'
            ? { ...e, summary: 'CLOCKONLYTHEDMSEES struck' } : e));
        }
        return r;
      } } }),
  },
  {
    id: 'campaign_redaction_skipped',
    what: 'the transport re-attaches agendas and hidden pins for players',
    // The client-side analog of forgetting a redactor: everything looks the
    // same on screen and the network tab carries the secrets.
    patch: (ctx) => ({ table: { ...ctx.table,
      get: async (kind, id, token) => {
        const r = await ctx.table.get(kind, id, token);
        if (kind === 'campaigns' && r?.factions) {
          r.factions = [...r.factions,
            { id: 'ghost', name: 'Leak', agenda: 'SECRET leak', public: false }];
        }
        if (kind === 'maps' && r?.pins) {
          r.pins = [...r.pins, { id: 'ghost', x: 0, y: 0, kind: 'quest',
            label: 'HIDDEN leak', revealed: false }];
        }
        return r;
      } } }),
  },
  {
    id: 'payload_scoring_flat',
    what: 'payload fields are stripped - push 15 feet scores like frighten again',
    // The pure featureControlScore pins survive this by design (a ctx patch
    // cannot reach module internals) - the twin-brew strict inequality in
    // payload_weights is the tripwire. Every field that scoring reads must
    // go, save included: the first sweep left save behind and the rich arm
    // kept a 2-vs-1 edge, so this mutation ESCAPED.
    patch: (ctx) => ({ sim: { ...ctx.sim,
      runCampaign: (cfg) => ctx.sim.runCampaign({
        ...cfg,
        sources: { ...cfg.sources,
          homebrew: (cfg.sources.homebrew || []).map((b) => ({
            ...b,
            features: (b.features || []).map((f) => ({
              ...f,
              effects: (f.effects || []).map((e) => {
                if (e.type !== 'action_option'
                  && e.type !== 'reaction_option') return e;
                const { conditions, forcedMove, aoe, expectedDamage, save,
                  ...rest } = e;
                return rest;
              }),
            })),
          })) },
      }) } }),
  },
  {
    id: 'reaction_never_fires',
    what: 'reactions are stripped before the simulator sees them - the old world',
    patch: (ctx) => ({ sim: { ...ctx.sim,
      runCampaign: (cfg) => ctx.sim.runCampaign({
        ...cfg,
        sources: { ...cfg.sources,
          homebrew: (cfg.sources.homebrew || []).map((b) => ({
            ...b,
            features: (b.features || []).map((f) => ({
              ...f,
              effects: (f.effects || [])
                .filter((e) => e.type !== 'reaction_option'),
            })),
          })) },
      }) } }),
  },
  {
    id: 'trigger_classifier_blind',
    what: 'reaction suggestions lose trigger and response - the pre-classifier world',
    patch: (ctx) => ({ hb: { ...ctx.hb,
      suggest: (brew) => {
        const out = ctx.hb.suggest(brew);
        for (const f of out.features || []) {
          for (const s of f.suggestions || []) {
            if (s.effect?.type === 'reaction_option') {
              delete s.effect.trigger;
              delete s.effect.response;
              delete s.effect.damageTypes;
            }
          }
        }
        return out;
      } } }),
  },
  {
    id: 'payload_parser_blind',
    what: 'action payloads vanish - push 15 feet and frighten are the same again',
    patch: (ctx) => ({ hb: { ...ctx.hb,
      suggest: (brew) => {
        const out = ctx.hb.suggest(brew);
        for (const f of out.features || []) {
          for (const s of f.suggestions || []) {
            if (s.effect?.type === 'action_option'
              || s.effect?.type === 'reaction_option') {
              delete s.effect.conditions;
              delete s.effect.forcedMove;
              delete s.effect.aoe;
              delete s.effect.expectedDamage;
            }
          }
        }
        return out;
      } } }),
  },
  {
    id: 'spell_budget_ignores_class',
    what: 'every class gets the wizard L1 allowance - the table columns are ignored',
    patch: (ctx) => ({ rules: { ...ctx.rules,
      spellBudget: () => ({ cantrips: 3, prepared: 4 }) } }),
  },
  {
    id: 'pointbuy_free_above_15',
    what: 'pointBuySpend prices an 18 at zero again - the pre-fix behaviour',
    patch: (ctx) => ({ rules: { ...ctx.rules,
      pointBuySpend: (ab) => {
        const out = ctx.rules.pointBuySpend(ab);
        return { ...out, outOfRange: [] };
      } } }),
  },
  {
    id: 'array_allows_duplicates',
    what: 'arrayAssignment stops noticing a value claimed twice',
    patch: (ctx) => ({ rules: { ...ctx.rules,
      arrayAssignment: (ab, arr) => {
        const out = ctx.rules.arrayAssignment(ab, arr);
        return { ...out, duplicates: [], valid: true };
      } } }),
  },
  {
    id: 'equipment_parser_flattens_qty',
    what: "'8 Javelins' grants one javelin - the quantity is dropped",
    patch: (ctx) => ({ rules: { ...ctx.rules,
      parseStartingEquipment: (p, e) => {
        const out = ctx.rules.parseStartingEquipment(p, e);
        if (out) {
          for (const o of out.options) for (const i of o.items) i.qty = 1;
        }
        return out;
      } } }),
  },
  {
    id: 'purchase_forgets_the_day',
    what: 'stampDay stops stamping - the spend chart collapses to day 0',
    patch: (ctx) => ({ campaign: { ...ctx.campaign, stampDay: (p) => p } }),
  },
  {
    id: 'forecast_frozen',
    what: 'forecastFor answers today seven times over',
    // A frozen week LOOKS plausible on screen; only the per-entry day
    // stamp assertion can tell it from a real one.
    patch: (ctx) => ({ campaign: { ...ctx.campaign,
      forecastFor: (t, a, n = 7) => Array.from({ length: n },
        () => ctx.campaign.weatherFor(t, a)) } }),
  },
  {
    id: 'shelf_detector_blind',
    what: 'the detector shrugs at every book: unsorted, no confidence, no why',
    // A detector that stops detecting fails soft - files still land SOMEWHERE
    // - so only an assertion on the verdict itself can notice.
    patch: (ctx) => ({ shelf: { ...ctx.shelf,
      upload: async (...a) => ({ ...(await ctx.shelf.upload(...a)),
        category: 'unsorted', confidence: 0, evidence: [] }) } }),
  },
  {
    id: 'shelf_forgets_hashes',
    what: 'a re-dropped book claims to be new every time',
    // The manifest skip breaking would re-split a 354-page book on every
    // drop and overwrite its output; alreadyKnown is the only visible tell.
    patch: (ctx) => ({ shelf: { ...ctx.shelf,
      upload: async (...a) => ({ ...(await ctx.shelf.upload(...a)),
        alreadyKnown: false }) } }),
  },
  {
    id: 'shelf_sections_shuffled',
    what: 'sections arrive in arbitrary order instead of reading order',
    // The Deck would show a book back to front and nothing would error.
    patch: (ctx) => ({ shelf: { ...ctx.shelf,
      sections: async (...a) => {
        const r = await ctx.shelf.sections(...a);
        return { ...r, sections: [...(r.sections || [])].reverse() };
      } } }),
  },
  {
    id: 'seat_rule_inverted',
    what: 'resolveSeat() lets the local seat beat the table seat',
    // The failure that matters: a device remembered as DM joins somebody
    // else's table as a player and still shows the DM screens. Harmless for
    // writes (the server refuses), corrosive for trust.
    patch: (ctx) => ({ session: { ...ctx.session,
      resolveSeat: ({ localRole }) => (localRole === 'dm' ? 'dm' : 'player') } }),
  },
  {
    id: 'theme_choice_ignored',
    what: 'theme.resolve() always answers light',
    patch: (ctx) => ({ theme: { ...ctx.theme, resolve: () => 'light' } }),
  },
  {
    id: 'hp_hidden_in_ui_only',
    what: 'the server sends monster HP and trusts the UI not to draw it',
    // The mistake this project would most plausibly have made: hiding the
    // number in the renderer. It LOOKS identical on screen and leaks the
    // number to anyone who opens the network tab.
    patch: (ctx) => ({ table: { ...ctx.table,
      get: async (kind, id, token) => {
        const r = await ctx.table.get(kind, id, token);
        if (kind !== 'encounters' || !r?.combatants) return r;
        return { ...r,
          combatants: r.combatants.map((x) => ({ ...x, hp: 13, hpMax: 59 })) };
      } } }),
  },
  {
    id: 'snapshot_carries_statblocks',
    what: 'snapshot() sends each monster\'s whole statblock',
    patch: (ctx) => ({ dm: { ...ctx.dm,
      runner: { ...ctx.dm.runner,
        snapshot: () => {
          const s = ctx.dm.runner.snapshot();
          return { ...s, combatants: s.combatants.map((x) => ({ ...x,
            stat: { name: x.name, filler: 'x'.repeat(5000) } })) };
        } } } }),
  },
  {
    id: 'unbounded_encounters',
    what: 'buildEncounter() ignores the monster cap',
    patch: (ctx) => ({ enc: { ...ctx.enc,
      buildEncounter: (m, lv, rng) => ({
        monsters: Array.from({ length: 9 },
          (_, i) => ctx.enc.instantiate(m[i % m.length], i, rng)),
        difficulty: 'high' }) } }),
  },
  {
    id: 'pregen_unarmed_at_1hp',
    what: 'forgeParty() sends heroes to the table unarmed at 1 HP',
    patch: (ctx) => ({ pregen: { ...ctx.pregen,
      forgeParty: (n, s, seed) => ctx.pregen.forgeParty(n, s, seed)
        .map((h) => ({ ...h, inventory: [], hp: { ...h.hp, max: 1 } })) } }),
  },
  {
    id: 'conc_check_forgotten',
    what: 'the shared fight stops asking for the concentration save',
    patch: (ctx) => ({ dm: { ...ctx.dm,
      runner: { ...ctx.dm.runner,
        applyTo: (id, delta, type) => {
          const res = ctx.dm.runner.applyTo(id, delta, type);
          if (res) delete res.concentrationDc;
          return res;
        } } } }),
  },
  {
    id: 'clocks_ignore_the_day',
    what: 'the day stops carrying the clocks that tick with it',
    patch: (ctx) => ({ campaign: { ...ctx.campaign,
      advanceDayClocks: (clocks = []) => ({ clocks, struck: [] }) } }),
  },
  {
    id: 'board_tokens_unclamped',
    what: 'a dragged token can leave the map entirely',
    patch: (ctx) => ({ dm: { ...ctx.dm,
      runner: { ...ctx.dm.runner,
        setTokenPosition: (id, x, y) => {
          const c = ctx.dm.runner.state.combatants.find((v) => v.id === id);
          if (c) { c.x = Number(x); c.y = Number(y); }
        } } } }),
  },
];

/**
 * Run every mutation and report which ones the suite caught.
 *
 * `escaped` is the number that ran without turning the board red. It should be
 * zero; anything else names a defect class this gym cannot see.
 */
export async function runMutations(ctx, { onProgress = () => {} } = {}) {
  const out = [];
  for (const m of MUTATIONS) {
    const g = grade(await runLogic({ ...ctx, ...m.patch(ctx) }));
    out.push({
      id: m.id,
      what: m.what,
      caught: !g.pass,
      signals: g.failures.length + g.errors.length,
      firstFailure: (g.failures[0] || g.errors[0] || '').slice(0, 120),
    });
    onProgress(m.id);
  }
  return { results: out, escaped: out.filter((r) => !r.caught).length };
}

/** Persist a graded run so the loop can be graphed over time. */
export async function publishRun(payload) {
  const res = await fetch(`${serverBase()}/api/appgym`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status}`);
  return res.json();
}

export async function loadHistory() {
  try {
    const res = await fetch(`${serverBase()}/api/appgym`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}
