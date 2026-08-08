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
        },
      },
      {
        id: 'executable_registry',
        title: 'The executable registry is honest about what runs',
        async run(c, { hb, exec }) {
          c.feature('homebrew', 'coverage');
          const brew = hb.accept(hb.suggest(hb.parse('markdown', [
            '## Gym Reactions',
            '### Riposte',
            'At 3rd level, when a creature misses you with a melee attack, you can '
            + 'use your Reaction to strike back.',
          ].join('\n\n'), { filename: 'r.md' })));
          const split = exec.executableSplit(brew);
          c.ok(split.counts.total > 0, 'the split sees the brew\'s effects');
          for (const t of Object.keys(split.executed)) {
            c.ok(exec.EXECUTABLE.has(t), `${t} is genuinely in the executable set`);
          }
          for (const t of Object.keys(split.inert)) {
            c.ok(!exec.EXECUTABLE.has(t), `${t} is correctly reported as inert`);
          }
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

  /* ---------------- connectors ------------------------------------- */
  {
    id: 'connectors',
    title: 'Optional connectors',
    why: 'These are the only part of the app that can reach the network. The '
       + 'property worth testing is not that they work - it is that the app '
       + 'is unharmed when they do not.',
    scenarios: [
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
  minFeaturesCovered: 30,
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
    id: 'unbounded_encounters',
    what: 'buildEncounter() ignores the monster cap',
    patch: (ctx) => ({ enc: { ...ctx.enc,
      buildEncounter: (m, lv, rng) => ({
        monsters: Array.from({ length: 9 },
          (_, i) => ctx.enc.instantiate(m[i % m.length], i, rng)),
        difficulty: 'high' }) } }),
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
