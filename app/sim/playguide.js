/**
 * Play guide generator.
 *
 * The rule this module is built around: **every line of advice carries the
 * basis it came from**, and nothing is asserted that isn't measured or quoted.
 *
 *   measured    computed by the simulator on this specific subclass
 *   quoted      lifted verbatim from the brew's own text
 *   derived     a mechanical fact restated as a play implication
 *   comparative positioned against the corpus or the SRD sibling
 *
 * Without that discipline a "playstyle guide" degenerates into the same
 * paragraph for every subclass. If a section has no evidence, it is omitted
 * rather than padded.
 */

import { derive } from '../core/derive.js';
import { expectedDamage } from '../core/engine.js';
import { runCampaign, makeCharacter } from './campaign.js';
import { score, SIBLING } from './tune.js';
import { project, nearest, axisGaps, FAR } from './vectors.js';
import { executableSplit, danglingCosts } from './executable.js';

const TIERS = [
  { name: 'Tier 1', levels: [1, 4], at: 3 },
  { name: 'Tier 2', levels: [5, 10], at: 8 },
  { name: 'Tier 3', levels: [11, 16], at: 13 },
  { name: 'Tier 4', levels: [17, 20], at: 18 },
];

const insight = (basis, headline, detail, extra = {}) =>
  ({ basis, headline, detail, ...extra });

/* ------------------------------------------------------------------ */
/* combat - measured                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the character the guide reasons about.
 *
 * Uses the SAME constructor the simulator does, which means it gets the class's
 * starting kit. Rolling a bespoke character here with an empty inventory made
 * the guide advise a greataxe Barbarian to "lead with Unarmed Strike", because
 * a fist was the only weapon it owned.
 */
function characterAt(brew, level, sources) {
  return makeCharacter(brew.class, brew.id, level, sources);
}

/** Best opening action at each tier, by expected damage against a typical AC. */
function openings(brew, sources) {
  const out = [];
  for (const tier of TIERS) {
    const d = derive(characterAt(brew, tier.at, sources),
      { ...sources, homebrew: withBrew(sources, brew) });
    const ac = 12 + Math.floor(tier.at / 3);

    const options = d.attacks.map((a) => ({
      label: a.name,
      value: expectedDamage(a, ac) * (d.attacksPerAction || 1),
      kind: 'attack',
    }));
    for (const act of d.actions) {
      options.push({
        label: act.name,
        value: null,
        kind: 'feature',
        cost: act.cost ? `${act.cost.amount} ${act.cost.resource}` : 'free',
      });
    }
    if (!options.length) continue;

    const best = options.filter((o) => o.value !== null)
      .sort((a, b) => b.value - a.value)[0];
    const feature = options.find((o) => o.kind === 'feature');

    if (best) {
      out.push(insight(
        'measured',
        `${tier.name} (level ${tier.at}): lead with ${best.label}`,
        `About ${best.value.toFixed(1)} expected damage per action against AC ${ac}`
        + `${d.attacksPerAction > 1 ? `, across ${d.attacksPerAction} attacks` : ''}.`
        + (feature ? ` ${feature.label} is your bonus-action play (${feature.cost}).` : ''),
        { level: tier.at, expected: +best.value.toFixed(2) },
      ));
    }
  }
  return out;
}

/** Where the class jumps, and where it is thin, from per-level sim metrics. */
function powerCurve(runs) {
  const byLevel = {};
  for (const run of runs) {
    for (const lvl of run.perLevel) {
      byLevel[lvl.level] ||= { dmg: 0, actions: 0, wipes: 0, encounters: 0 };
      byLevel[lvl.level].dmg += lvl.singleTargetDealt;
      byLevel[lvl.level].actions += lvl.pcActions;
      byLevel[lvl.level].wipes += lvl.wipes;
      byLevel[lvl.level].encounters += lvl.encounters;
    }
  }
  const curve = Object.entries(byLevel).map(([lvl, v]) => ({
    level: Number(lvl),
    dpa: v.actions ? v.dmg / v.actions : 0,
    wipeRate: v.encounters ? v.wipes / v.encounters : 0,
  })).sort((a, b) => a.level - b.level);

  const out = [];
  let biggest = null;
  for (let i = 1; i < curve.length; i += 1) {
    const jump = curve[i].dpa - curve[i - 1].dpa;
    if (!biggest || jump > biggest.jump) {
      biggest = { level: curve[i].level, jump, from: curve[i - 1].dpa, to: curve[i].dpa };
    }
  }
  if (biggest && biggest.jump > 0.5) {
    out.push(insight(
      'measured',
      `Your biggest power spike is level ${biggest.level}`,
      `Damage per action goes from ${biggest.from.toFixed(1)} to `
      + `${biggest.to.toFixed(1)} - a jump of ${biggest.jump.toFixed(1)}. `
      + 'Worth planning a campaign beat around.',
      { level: biggest.level },
    ));
  }

  const risky = curve.filter((c) => c.wipeRate > 0).sort((a, b) => b.wipeRate - a.wipeRate)[0];
  if (risky && risky.wipeRate > 0.005) {
    out.push(insight(
      'measured',
      `Level ${risky.level} is where you are most fragile`,
      `Party wipes happened in ${(risky.wipeRate * 100).toFixed(1)}% of encounters `
      + 'at that level in simulation. Bank a healing resource going in.',
      { level: risky.level },
    ));
  }
  return out;
}

/** Resource economy across an adventuring day. */
function resourceEconomy(brew, sources, runs) {
  const out = [];
  const d = derive(characterAt(brew, 10, sources),
    { ...sources, homebrew: withBrew(sources, brew) });
  if (!d.resources.length) return out;

  const spends = runs.reduce((n, r) => n + (r.coverage.eventTypes?.resource_spent || 0), 0);
  const encounters = runs.reduce((n, r) => n + r.metrics.encounters, 0);
  const perEncounter = encounters ? spends / encounters : 0;

  for (const res of d.resources) {
    const runsDry = perEncounter > 0
      ? Math.max(1, Math.round(res.max / Math.max(0.1, perEncounter)))
      : null;
    out.push(insight(
      'measured',
      `${res.name}: ${res.max} at level 10, back on a ${res.recharge} rest`,
      perEncounter > 0
        ? `Simulation spends about ${perEncounter.toFixed(2)} per encounter, so you `
          + `run dry around encounter ${runsDry} of the day. `
          + (res.recharge === 'short'
            ? 'Short rests refill it, so push for them.'
            : 'Nothing refills it until a long rest - pace accordingly.')
        : 'The simulator never had cause to spend it, which usually means the '
          + 'feature it powers competes badly with just attacking.',
      { resource: res.name, max: res.max },
    ));
  }
  return out;
}

/** What each feature is worth, from paired ablation. */
function featureValues(ablations) {
  const out = [];
  for (const a of ablations) {
    if (!a.detectable) continue;
    const worth = Math.abs(a.dDpr);
    out.push(insight(
      'measured',
      `${a.label.split(':').slice(1).join(':').trim() || a.label} is load-bearing`,
      `Removing it moves damage per action by ${a.dDpr.toFixed(2)} `
      + `(95% CI ${a.ciDpr[0].toFixed(2)} to ${a.ciDpr[1].toFixed(2)}). `
      + (worth > 2
        ? 'This is the feature the subclass is built on - protect the conditions it needs.'
        : 'A real but modest contribution.'),
      { delta: a.dDpr, ci: a.ciDpr },
    ));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* roleplay - quoted and derived                                       */
/* ------------------------------------------------------------------ */

/** Mechanical facts that have obvious dramatic consequences. */
const DRAWBACK_PATTERNS = [
  {
    re: /counts? as (?:a )?(?:creature made of )?metal/i,
    headline: 'You are metal, and enemies can use that',
    detail: 'Heat Metal, rust, lightning, magnets - a clever DM has levers on '
      + 'you that other characters do not have. Play the dread rather than '
      + 'hiding it.',
  },
  {
    re: /disadvantage on (?:Dexterity \()?Stealth/i,
    headline: 'You are bad at being quiet',
    detail: 'Lean into it. A character who cannot sneak has to talk, bluff or '
      + 'smash, and that shapes every infiltration the party plans.',
  },
  {
    re: /no longer need to (?:eat|drink)|stopped? (?:eating|needing)/i,
    headline: 'You have stopped needing what people need',
    detail: 'Meals are social. A character who no longer eats has to decide '
      + 'whether to keep pretending - that is a quiet, recurring character beat.',
  },
  {
    re: /you (?:take|suffer)[^.]*damage[^.]*when you use/i,
    headline: 'Your power costs you something',
    detail: 'Self-damage is a dial for desperation. Save it for moments that '
      + 'should feel expensive.',
  },
  {
    re: /reduced? by 10 feet|Speed is reduced/i,
    headline: 'Sometimes you trade speed for safety',
    detail: 'Deciding when to slow down is a visible tactical choice at the '
      + 'table - narrate it.',
  },
];

function roleplay(brew) {
  const out = [];
  const allText = (brew.features || []).map((f) => f.text).join('\n');

  if (brew.flavor?.quote) {
    out.push(insight('quoted', 'Your character in one line',
      `"${brew.flavor.quote}" - the brew's own epigraph. Worth keeping on your `
      + 'sheet as a tone check.'));
  }
  for (const lede of (brew.flavor?.lede || []).slice(0, 2)) {
    if (lede.length > 60) {
      out.push(insight('quoted', 'The premise', lede));
    }
  }

  for (const table of brew.rollTables || []) {
    out.push(insight('quoted',
      `${table.name} is a roleplay engine, not just a mechanic`,
      `${table.entries.length} entries on a ${table.die}. Roll it in downtime as `
      + 'a story prompt, not only when the rules force it. Results like '
      + `"${(table.entries[0]?.text || '').slice(0, 90)}..." are scenes.`,
      { table: table.name, die: table.die }));
  }

  for (const p of DRAWBACK_PATTERNS) {
    if (p.re.test(allText)) {
      out.push(insight('derived', p.headline, p.detail));
    }
  }

  for (const f of brew.features || []) {
    for (const e of f.effects || []) {
      if (e.type === 'toggle') {
        out.push(insight('derived',
          `${e.name} is a decision you make every round`,
          `Switching between ${(e.options || []).map((o) => o.label).join(' and ')} `
          + 'is free and constant. Give it a physical tell - a hum, a pull on '
          + 'loose nails - so the table can read your state.',
          { toggle: e.key }));
      }
      if (e.type === 'trigger') {
        out.push(insight('derived',
          'Your bad rolls are everyone\'s entertainment',
          `A natural ${(e.natRange || [1]).join(' or ')} fires ${e.rollTable || 'your table'} `
          + 'automatically. Failure is your subclass\'s best moment, so play the '
          + 'fumble with commitment rather than apologising for it.'));
      }
    }
  }

  for (const note of (brew.designNotes || []).slice(0, 4)) {
    if (note.name === 'Open question') {
      out.push(insight('quoted', 'Worth asking your DM before session one',
        note.text));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* comparative                                                         */
/* ------------------------------------------------------------------ */

/** Nearest neighbours in the corpus on the measured vector. */
function comparative(metrics, sibling, corpus, brew) {
  const out = [];
  // A corpus entry can BE the SRD sibling (the Open5e Champion is the SRD
  // Champion). Comparing it to itself yields a confident "about the same on
  // every axis", which looks like a finding and is really a tautology.
  const selfCompare = sibling && (sibling.id === brew.id
    || String(sibling.name).toLowerCase() === String(brew.name).toLowerCase());

  if (selfCompare) {
    out.push(insight('comparative',
      'This IS the reference subclass for its class',
      `${brew.name} is the SRD baseline other ${brew.class} subclasses are `
      + 'measured against, so there is no meaningful comparison to draw here.'));
  } else if (sibling) {
    const s = score(metrics, sibling.metrics);
    const axis = (v, hi, lo) => (v > 0.1 ? hi : v < -0.1 ? lo : 'about the same');
    out.push(insight('comparative',
      `Against ${sibling.name}, the SRD subclass for your class`,
      `Damage ${axis(s.axes.dDmg, 'higher', 'lower')}, `
      + `survivability ${axis(s.axes.dSurv, 'better', 'worse')}, `
      + `control ${axis(s.axes.dCtl, 'more', 'less')}. `
      + `Composite ${s.composite >= 0 ? '+' : ''}${(s.composite * 100).toFixed(0)}%, `
      + (Math.abs(s.composite) <= 0.10
        ? 'which is inside the ±10% band - balanced against it.'
        : `which is outside the ±10% band - ${s.composite > 0 ? 'stronger' : 'weaker'} `
          + 'than the baseline by more than the band allows.'),
      { composite: s.composite, axes: s.axes }));
  }

  out.push(...playsLike(metrics, corpus, brew));
  return out;
}

/**
 * "Plays most like", on measured behaviour.
 *
 * The previous version compared effect COUNTS and returned the same three
 * neighbours for Path of the Dragon and for Champion - subclasses that play
 * nothing alike. It also took a raw Euclidean distance over axes on wildly
 * different scales, which made it a ranking by damage wearing a disguise.
 *
 * This projects into the corpus's own z-scored space and refuses to answer in
 * two cases where an answer would be worse than silence:
 *   - the nearest neighbour is FAR away: nothing resembles this, and naming
 *     the least-unlike thing would invent a resemblance;
 *   - the nearest neighbours are TIED at distance ~0: the simulator cannot
 *     tell them apart, which is a measurement limit, not a similarity.
 */
function playsLike(metrics, corpus, brew) {
  if (!corpus?.vectors?.length || !corpus.stats) return [];
  let vec;
  try {
    vec = project(metrics, corpus.stats);
  } catch (err) {
    // Say nothing rather than something wrong. The cached corpus was built
    // against a different axis set, so the honest answer is "rebuild it".
    return [insight('comparative',
      'Positioning unavailable',
      `The cached corpus vectors do not match the current axes (${err.message}). `
      + 'Rebuild them from the emulator page to restore "plays most like".')];
  }
  const near = nearest(vec, corpus.vectors, { k: 3, excludeId: brew.id });
  if (!near.length) return [];

  const meta = {
    neighbours: near.map((n) => ({ id: n.id, name: n.name, d: +n.distance.toFixed(2) })),
    corpusSize: corpus.vectors.length,
    axes: corpus.axes,
  };

  if (near[0].distance > FAR) {
    return [insight('comparative',
      'Nothing in the corpus plays much like this',
      `The closest of ${corpus.vectors.length} measured subclasses is `
      + `${near[0].name} (${near[0].class}), and it is still `
      + `${near[0].distance.toFixed(1)} standard deviations away. That is a `
      + 'genuinely unusual combination of damage, durability and control - '
      + 'which is a compliment, but it also means nobody at the table will '
      + 'have a frame of reference for it.',
      meta)];
  }

  const tied = near.filter((n) => n.tied);
  if (tied.length) {
    return [insight('comparative',
      'The simulator cannot separate this from its neighbours',
      `${tied.map((n) => n.name).join(', ')} measure identically to this one. `
      + 'That is a limit of the instrument, not a statement that they play the '
      + 'same: whatever distinguishes them lives in mechanics the simulator '
      + 'does not execute - usually reactions, or the specific effect of a '
      + 'feature action rather than the fact that it has one.',
      meta)];
  }

  // How it differs from its nearest neighbour, so the comparison is useful
  // rather than just a name.
  const gaps = axisGaps(vec, near[0].vec);
  const top = gaps[0];
  const direction = top.gap > 0 ? 'more' : 'less';

  return [insight('comparative',
    'Plays most like',
    `${near.map((n) => `${n.name} (${n.class}, ${n.distance.toFixed(2)})`).join(', ')}. `
    + `Closest is ${near[0].name}; the biggest difference is ${top.label} - `
    + `this one has ${direction} of it. Distances are in standard deviations `
    + `across ${corpus.vectors.length} measured subclasses, so under 1.0 means `
    + 'genuinely similar.',
    { ...meta, differsMostOn: top.axis })];
}

/* ------------------------------------------------------------------ */
/* driver                                                              */
/* ------------------------------------------------------------------ */

const withBrew = (sources, brew) =>
  [...(sources.homebrew || []).filter((h) => h.id !== brew.id), brew];

/**
 * Build the guide.
 *
 * @param {object} cfg {brew, sources, monsters, spells, mechanics, seeds,
 *                      ablations, corpus}
 */
export function buildGuide(cfg) {
  const {
    brew, sources, monsters, spells, mechanics,
    seeds = 8, ablations = [], corpus = null, maxLevel = 20,
  } = cfg;

  const srcs = { ...sources, homebrew: withBrew(sources, brew) };
  const base = { sources: srcs, monsters, spells, mechanics, maxLevel };

  const runs = Array.from({ length: seeds }, (_, s) => runCampaign({
    classId: brew.class, subclassId: brew.id, seed: s, ...base,
  }));
  const mean = (k) => runs.reduce((n, r) => n + r.metrics[k], 0) / runs.length;
  // Must cover every axis in vectors.js AXES - a missing key projects to NaN,
  // and NaN sorts arbitrarily, so "plays most like" silently returns whatever
  // order the corpus happened to be in.
  const metrics = {
    stDpr: mean('stDpr'), dpr: mean('dpr'),
    wipeRate: mean('wipeRate'), cpa: mean('cpa'), downRate: mean('downRate'),
    dtpr: mean('dtpr'),
  };

  // Sibling measured the same way, so the comparison is apples to apples.
  let sibling = null;
  const sibId = SIBLING[brew.class];
  if (sibId) {
    const sibRuns = Array.from({ length: seeds }, (_, s) => runCampaign({
      classId: brew.class, subclassId: sibId, seed: s, ...base,
    }));
    const sMean = (k) => sibRuns.reduce((n, r) => n + r.metrics[k], 0) / sibRuns.length;
    sibling = {
      id: sibId,
      name: (sources.classes.find((c) => c.id === brew.class)?.subclasses || [])
        .find((s) => s.id === sibId)?.name || sibId,
      metrics: { stDpr: sMean('stDpr'), wipeRate: sMean('wipeRate'), cpa: sMean('cpa') },
    };
  }

  const combat = [
    ...openings(brew, sources),
    ...powerCurve(runs),
    ...resourceEconomy(brew, sources, runs),
    ...featureValues(ablations),
  ];
  const rp = roleplay(brew);
  const compare = comparative(metrics, sibling, corpus, brew);

  // Measured at a mid tier, where every feature but the capstone is online.
  const execution = executableSplit(brew);
  const dangling = danglingCosts(
    derive(characterAt(brew, Math.min(maxLevel, 12), sources), srcs),
  );

  return {
    brewId: brew.id,
    brewName: brew.name,
    class: brew.class,
    generated: new Date().toISOString(),
    seeds,
    metrics,
    sibling,
    combat,
    roleplay: rp,
    comparative: compare,
    // So a reader can see how much of this is measurement versus reading.
    basisCounts: [...combat, ...rp, ...compare].reduce((acc, i) => {
      acc[i.basis] = (acc[i.basis] || 0) + 1;
      return acc;
    }, {}),
    // What the simulator ran versus what the mapper merely understood. These
    // are different numbers and quoting only the second one flatters the
    // result - a subclass whose mechanics are all reactions maps at 100% and
    // measures as a plain member of its class.
    execution,
    danglingCosts: dangling,
    // Stated rather than implied: this is what the guide could NOT tell you.
    limits: [
      combat.length === 0 && 'No combat advice: nothing measurable fired in simulation.',
      rp.length === 0 && 'No roleplay advice: the brew carries no flavour text or tables.',
      !sibling && `No SRD sibling known for class "${brew.class}", so no baseline comparison.`,
      !corpus?.vectors?.length
        && 'No corpus vectors loaded, so no "plays like" positioning.',
      execution.counts.inert > 0
        && `${execution.counts.inert} mapped effect(s) the simulator does not run `
          + `(${Object.entries(execution.reasons).map(([t, why]) => `${t}: ${why}`)
            .join('; ') || Object.keys(execution.inert).join(', ')}). `
          + 'They are real at the table but invisible to every number here.',
      dangling.length > 0
        && `${dangling.map((d) => `"${d.action}" costs ${d.resource}`).join(', ')}, `
          + 'but nothing grants that resource - so it never fired in simulation. '
          + 'Either the subclass never says where the pool comes from, or the '
          + 'sentence that says so was not understood. Every number below '
          + 'excludes it.',
    ].filter(Boolean),
  };
}
