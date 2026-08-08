/**
 * Auto-tune loop.
 *
 * Searches the numeric knobs inside an ingested homebrew subclass until it
 * sits within a target band of its SRD sibling, using paired seeds so dice and
 * policy cancel.
 *
 * Safety is structural, not procedural:
 *   - The source .html files are READ-ONLY inputs. Nothing here writes to them.
 *   - Tuned values go to data/homebrew-variants/<id>.v<n>.json with full
 *     provenance: which knob, old -> new, the measured delta, the seed set.
 *   - Every step is reversible because the original record is never mutated.
 *
 * Two guards carried over from earlier tuning work that produced flapping
 * knobs: a DEADBAND (ignore improvements smaller than the noise floor) and
 * TWO-CONSECUTIVE CONFIRMATION (a change must win twice on different seed sets
 * before it is accepted).
 */

import { runCampaign } from './campaign.js';

/** SRD sibling each homebrew subclass is measured against. */
export const SIBLING = {
  sorcerer: 'draconic-sorcery',
  monk: 'warrior-of-the-open-hand',
  fighter: 'champion',
  barbarian: 'path-of-the-berserker',
  rogue: 'thief',
  cleric: 'life-domain',
  druid: 'circle-of-the-land',
  paladin: 'oath-of-devotion',
  ranger: 'hunter',
  bard: 'college-of-lore',
  warlock: 'fiend-patron',
  wizard: 'evoker',
};

/* ------------------------------------------------------------------ */
/* knobs                                                               */
/* ------------------------------------------------------------------ */

const DICE_STEPS = ['1d4', '1d6', '1d8', '1d10', '1d12', '2d6', '2d8', '2d10', '3d8'];

/**
 * Enumerate the tunable numbers inside a homebrew record.
 * Each knob knows how to read, step and write its own value.
 */
export function findKnobs(brew) {
  const knobs = [];
  brew.features.forEach((f, fi) => {
    (f.effects || []).forEach((eff, ei) => {
      const at = { featureIndex: fi, effectIndex: ei, feature: f.name };

      if (eff.type === 'ac_formula' && typeof eff.base === 'number') {
        knobs.push({
          ...at, id: `${f.id}.ac_base`, path: 'base', kind: 'int',
          label: `${f.name}: unarmoured AC base`,
          get: (b) => b.features[fi].effects[ei].base,
          set: (b, v) => { b.features[fi].effects[ei].base = v; },
          steps: (v) => [v - 1, v + 1].filter((x) => x >= 8 && x <= 18),
        });
      }
      if (eff.type === 'unarmed_strike' && eff.die) {
        knobs.push({
          ...at, id: `${f.id}.unarmed_die`, path: 'die', kind: 'dice',
          label: `${f.name}: unarmed strike die`,
          get: (b) => b.features[fi].effects[ei].die,
          set: (b, v) => { b.features[fi].effects[ei].die = v; },
          steps: (v) => {
            const i = DICE_STEPS.indexOf(v);
            return i < 0 ? [] : [DICE_STEPS[i - 1], DICE_STEPS[i + 1]].filter(Boolean);
          },
        });
      }
      if (eff.type === 'damage_rider' && eff.dice) {
        knobs.push({
          ...at, id: `${f.id}.rider_dice`, path: 'dice', kind: 'dice',
          label: `${f.name}: bonus damage`,
          get: (b) => b.features[fi].effects[ei].dice,
          set: (b, v) => { b.features[fi].effects[ei].dice = v; },
          steps: (v) => {
            const i = DICE_STEPS.indexOf(v);
            return i < 0 ? [] : [DICE_STEPS[i - 1], DICE_STEPS[i + 1]].filter(Boolean);
          },
        });
      }
      if (eff.type === 'action_option' && eff.cost?.amount) {
        knobs.push({
          ...at, id: `${f.id}.cost`, path: 'cost.amount', kind: 'int',
          label: `${f.name}: resource cost`,
          get: (b) => b.features[fi].effects[ei].cost.amount,
          set: (b, v) => { b.features[fi].effects[ei].cost.amount = v; },
          steps: (v) => [v - 1, v + 1].filter((x) => x >= 1 && x <= 6),
        });
      }
      if (eff.type === 'trigger' && Array.isArray(eff.natRange)) {
        knobs.push({
          ...at, id: `${f.id}.nat_range`, path: 'natRange', kind: 'range',
          label: `${f.name}: trigger range`,
          get: (b) => b.features[fi].effects[ei].natRange,
          set: (b, v) => { b.features[fi].effects[ei].natRange = v; },
          steps: (v) => {
            const hi = Math.max(...v);
            const out = [];
            if (hi > 1) out.push(Array.from({ length: hi - 1 }, (_, i) => i + 1));
            if (hi < 5) out.push(Array.from({ length: hi + 1 }, (_, i) => i + 1));
            return out;
          },
        });
      }
    });
  });
  return knobs;
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * How much of a difference counts as "one unit" on the rate-like axes.
 * Mirrors sim/bars.json v2 - keep the two in step.
 */
export const WIPE_SCALE = 0.02;    // 2 percentage points of wipe rate
export const CONTROL_SCALE = 0.25; // 0.25 control events per action

/**
 * Composite distance from the sibling.
 *
 * Damage is compared RELATIVELY - stDpr sits around 8-25, comfortably away
 * from zero, so a percentage is meaningful.
 *
 * Survivability and control are compared on a SCALED-ABSOLUTE basis, because
 * relative comparison of a small rate is both unstable and, at zero, undefined:
 *
 *   - wipe rates of 0.51% vs 0.30% are a 0.2-point difference, roughly 0.8
 *     extra wipes across a 392-encounter campaign. Relatively that reads as
 *     "-71% survivability", which is how a rounding-scale difference ended up
 *     driving a real balance change.
 *   - the Open Hand monk's control rate is exactly 0, so a relative control
 *     axis saturated at 1.0 for the Fool Monk and could never be tuned no
 *     matter what the knobs did.
 *
 * Positive on every axis means "stronger than the sibling".
 */
export function score(mine, sib) {
  const rel = (a, b) => (b === 0 ? (a === 0 ? 0 : 1) : (a - b) / Math.abs(b));
  const dDmg = rel(mine.stDpr, sib.stDpr);
  const dSurv = -(mine.wipeRate - sib.wipeRate) / WIPE_SCALE;
  const dCtl = (mine.cpa - sib.cpa) / CONTROL_SCALE;
  const axes = { dDmg, dSurv, dCtl };
  const rms = Math.sqrt((dDmg ** 2 + dSurv ** 2 + dCtl ** 2) / 3);
  return { axes, rms, composite: (dDmg + dSurv + dCtl) / 3 };
}

/** Average metrics over a seed set. */
function measure(cfg, seeds) {
  const runs = seeds.map((s) => runCampaign({ ...cfg, seed: s }));
  const mean = (k) => runs.reduce((n, r) => n + r.metrics[k], 0) / runs.length;
  return {
    stDpr: mean('stDpr'), dpr: mean('dpr'),
    wipeRate: mean('wipeRate'), cpa: mean('cpa'),
    downRate: mean('downRate'),
  };
}

/* ------------------------------------------------------------------ */
/* the loop                                                            */
/* ------------------------------------------------------------------ */

/**
 * Coordinate descent over one homebrew subclass's knobs.
 *
 * @param {object} cfg {brew, sources, monsters, spells, mechanics, band,
 *                      seeds, maxRounds, deadband, onProgress}
 */
export async function tune(cfg) {
  const {
    brew, sources, monsters, spells, mechanics,
    band = 0.10, seeds = 10, maxRounds = 6, deadband = 0.02,
    maxLevel = 20, onProgress = () => {},
  } = cfg;

  const classId = String(brew.class || '').toLowerCase();
  const siblingId = SIBLING[classId];
  if (!siblingId) throw new Error(`no SRD sibling known for class "${classId}"`);

  const seedSetA = Array.from({ length: seeds }, (_, i) => i);
  const seedSetB = Array.from({ length: seeds }, (_, i) => 1000 + i);

  const base = { sources, monsters, spells, mechanics, maxLevel };
  const sibling = measure(
    { ...base, classId, subclassId: siblingId }, seedSetA,
  );

  // Work on a deep copy. The stored record is never mutated.
  let current = structuredClone(brew);
  const withBrew = (b) => ({
    ...base,
    sources: { ...sources, homebrew: [...sources.homebrew.filter((h) => h.id !== b.id), b] },
    classId, subclassId: b.id,
  });

  let currentMetrics = measure(withBrew(current), seedSetA);
  let currentScore = score(currentMetrics, sibling);

  const history = [{
    round: 0, knob: null, from: null, to: null,
    metrics: currentMetrics, score: currentScore, accepted: true,
  }];
  const applied = [];
  let converged = false;
  let reason = '';

  for (let round = 1; round <= maxRounds; round += 1) {
    if (Math.abs(currentScore.composite) <= band) {
      converged = true;
      reason = `inside the +/-${(band * 100).toFixed(0)}% band`;
      break;
    }

    const knobs = findKnobs(current);
    if (!knobs.length) { reason = 'no tunable knobs found'; break; }

    let best = null;
    for (const knob of knobs) {
      const from = knob.get(current);
      for (const to of knob.steps(from)) {
        const candidate = structuredClone(current);
        knob.set(candidate, to);
        const m = measure(withBrew(candidate), seedSetA);
        const sc = score(m, sibling);
        const gain = Math.abs(currentScore.composite) - Math.abs(sc.composite);
        onProgress({ round, knob: knob.label, from, to, gain });
        if (gain > deadband && (!best || gain > best.gain)) {
          best = { knob, from, to, candidate, metrics: m, score: sc, gain };
        }
      }
    }

    if (!best) {
      reason = `no knob improved the composite by more than the ${deadband} deadband`;
      break;
    }

    // TWO-CONSECUTIVE CONFIRMATION on an independent seed set. A change that
    // only wins on the seeds it was selected with is a selection artifact.
    const confirmMetrics = measure(withBrew(best.candidate), seedSetB);
    const confirmScore = score(confirmMetrics, measure(
      { ...base, classId, subclassId: siblingId }, seedSetB,
    ));
    const baselineB = score(
      measure(withBrew(current), seedSetB),
      measure({ ...base, classId, subclassId: siblingId }, seedSetB),
    );
    const confirmed = Math.abs(baselineB.composite)
      - Math.abs(confirmScore.composite) > deadband;

    history.push({
      round, knob: best.knob.label, knobId: best.knob.id,
      from: best.from, to: best.to,
      gain: best.gain, metrics: best.metrics, score: best.score,
      confirmed, accepted: confirmed,
    });

    if (!confirmed) {
      reason = `best change (${best.knob.label} ${best.from} -> ${best.to}) `
        + 'won on its selection seeds but not on an independent set - rejected';
      break;
    }

    current = best.candidate;
    currentMetrics = best.metrics;
    currentScore = best.score;
    applied.push({
      knob: best.knob.label, knobId: best.knob.id,
      from: best.from, to: best.to,
      compositeAfter: best.score.composite,
    });
  }

  if (!converged && !reason) reason = `hit the ${maxRounds}-round limit`;

  return {
    brewId: brew.id, brewName: brew.name, classId, siblingId,
    band, seeds, deadband,
    sibling, baseline: history[0].metrics, baselineScore: history[0].score,
    final: currentMetrics, finalScore: currentScore,
    converged, reason, applied, history,
    variant: current,
  };
}

/** Persist a tuned variant with provenance. Originals are never touched. */
export async function saveVariant(result, serverBase = '') {
  const body = {
    ...result.variant,
    _tuning: {
      tunedAt: new Date().toISOString(),
      sibling: result.siblingId,
      band: result.band,
      seeds: result.seeds,
      converged: result.converged,
      reason: result.reason,
      applied: result.applied,
      baseline: result.baseline,
      final: result.final,
      note: 'Generated by app/sim/tune.js. The source .html was not modified.',
    },
  };
  const res = await fetch(`${serverBase}/api/variant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: result.brewId, variant: body }),
  });
  if (!res.ok) throw new Error(`variant save failed: ${res.status}`);
  return res.json();
}
