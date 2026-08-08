/**
 * Behavioural vectors for the corpus.
 *
 * "Plays like" used to compare effect COUNTS, which is not a measurement of
 * anything: it returned the same three neighbours for Path of the Dragon and
 * for Champion, subclasses that play nothing alike. This replaces that with
 * four axes the simulator actually produces.
 *
 * The axes are on wildly different scales - stDpr runs 5-25 while wipeRate runs
 * 0.003-0.03 - so raw Euclidean distance is just stDpr wearing a disguise.
 * Every axis is z-scored across the corpus before any distance is taken. That
 * was the real defect in the old proxy, and fixing the inputs without fixing
 * the metric would have reproduced it exactly.
 */

import { runCampaign } from './campaign.js';
import { executableSplit } from './executable.js';
import { hashString } from '../core/rng.js';
import { serverBase } from '../core/db.js';

/**
 * The axes, chosen by measurement rather than by taste.
 *
 * `resourceIntensity` (spends per encounter) was the original fourth axis and
 * was DROPPED: it measured 0.0 for all 100 corpus archetypes, because only one
 * of the 159 mapped action options carries a resource cost. An axis with no
 * spread contributes nothing to a distance and only makes the vector look
 * richer than it is.
 *
 * `dtpr` replaced it because it is driven by mechanics no other axis sees -
 * AC formulas, resistances and immunities - and it measures damage MITIGATION,
 * where wipeRate measures the outcome. Their correlation is checked at build
 * time and reported in `diagnostics`, so a future change that makes them
 * redundant shows up rather than hiding.
 */
export const AXES = ['stDpr', 'wipeRate', 'cpa', 'dtpr'];

export const AXIS_LABEL = {
  stDpr: 'single-target damage',
  wipeRate: 'fragility',
  cpa: 'control',
  dtpr: 'damage taken',
};

/**
 * Stable content hash of a mapped brew.
 *
 * Keyed on the MECHANICS, not the prose, so re-ingesting the same file is a
 * cache hit while a change to the mapper invalidates every entry.
 */
export function brewHash(brew) {
  const shape = (brew.features || []).map((f) => [
    f.id, f.level,
    (f.effects || []).map((e) => JSON.stringify(e)).sort().join('|'),
  ].join(':')).sort().join('\n');
  return hashString(`${brew.class}|${shape}`).toString(36);
}

/** Measure one subclass over `seeds` paired campaigns. */
export function measure(classId, subclassId, base, seeds = 6) {
  const runs = Array.from({ length: seeds }, (_, s) => runCampaign({
    classId, subclassId, seed: s, ...base,
  }));
  const mean = (k) => runs.reduce((n, r) => n + r.metrics[k], 0) / runs.length;
  const featureUses = runs.reduce(
    (n, r) => n + Object.values(r.coverage.features || {}).reduce((a, b) => a + b, 0), 0,
  );
  const actions = runs.reduce((n, r) => n + r.metrics.pcActions, 0);
  return {
    stDpr: mean('stDpr'),
    wipeRate: mean('wipeRate'),
    cpa: mean('cpa'),
    dtpr: mean('dtpr'),
    // Reported but NOT an axis - it is near-collinear with cpa, since a feature
    // use is also scored as control. Kept because it is cheap and reads well in
    // the guide ("presses buttons" vs "swings a sword").
    featureRate: actions ? featureUses / actions : 0,
    dpr: mean('dpr'),
    downRate: mean('downRate'),
  };
}

/** Pearson correlation, for checking that two axes are not the same axis. */
export function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx; const b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/** Correlation of every axis pair, plus a flag for any redundant pair. */
export function axisDiagnostics(records) {
  const pairs = [];
  for (let i = 0; i < AXES.length; i += 1) {
    for (let j = i + 1; j < AXES.length; j += 1) {
      const r = correlation(
        records.map((x) => x.metrics[AXES[i]]),
        records.map((x) => x.metrics[AXES[j]]),
      );
      pairs.push({ a: AXES[i], b: AXES[j], r: +r.toFixed(3) });
    }
  }
  const dead = AXES.filter((a) => {
    const vals = records.map((x) => x.metrics[a]);
    return Math.max(...vals) - Math.min(...vals) < 1e-9;
  });

  // How much of the population the instrument cannot separate at all.
  //
  // The simulator scores every feature action the same way - one control
  // event - because the mapped text carries no structured payload; "push 15
  // feet" and "frighten the target" are the same thing to it. So two subclasses
  // whose only executable mechanic is a bonus-action feature WILL measure
  // identically. That is a ceiling of text-mapped simulation, not a bug, and
  // the number belongs in the artifact where it can be watched.
  const groups = new Map();
  for (const r of records) {
    const key = AXES.map((a) => r.metrics[a].toFixed(6)).join(',');
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const tied = [...groups.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);

  return {
    pairs,
    dead,
    // |r| > 0.9 means two axes are one axis wearing two names.
    redundant: pairs.filter((p) => Math.abs(p.r) > 0.9),
    distinct: groups.size,
    tied,
    tieRate: records.length ? +(tied / records.length).toFixed(3) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Z-score each axis across the population.
 * An axis with no spread contributes nothing rather than dividing by zero.
 */
export function normalise(records) {
  const stats = {};
  for (const axis of AXES) {
    const vals = records.map((r) => r.metrics[axis]).filter(Number.isFinite);
    const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const sd = Math.sqrt(
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1),
    );
    stats[axis] = { mean, sd: sd > 1e-9 ? sd : 0 };
  }
  return {
    stats,
    vectors: records.map((r) => ({
      ...r,
      vec: AXES.map((a) => {
        const { mean, sd } = stats[a];
        return sd ? (r.metrics[a] - mean) / sd : 0;
      }),
    })),
  };
}

/**
 * Project a single subclass into an existing normalised space.
 *
 * Throws on a missing axis rather than producing NaN. A NaN coordinate makes
 * every distance NaN, NaN comparisons are always false, so the "nearest"
 * neighbour sort degenerates into corpus order - which looks like a real
 * answer and is not one. Loud beats plausible.
 */
export function project(metrics, stats) {
  const missing = AXES.filter((a) => !Number.isFinite(metrics?.[a]));
  if (missing.length) {
    throw new Error(
      `cannot project: metrics missing axis ${missing.join(', ')} `
      + `(has ${Object.keys(metrics || {}).join(', ')})`,
    );
  }
  return AXES.map((a) => {
    const { mean, sd } = stats[a] || {};
    return sd ? (metrics[a] - mean) / sd : 0;
  });
}

/* ------------------------------------------------------------------ */
/* neighbours                                                          */
/* ------------------------------------------------------------------ */

/**
 * Nearest neighbours, WITH their distance.
 *
 * The distance is returned because "nearest" is meaningless on its own - if
 * everything is far away, naming the least-unlike thing is worse than saying
 * nothing resembles it. `FAR` is roughly one standard deviation of separation
 * summed across four axes.
 */
export const FAR = 2.0;

/**
 * Below this, two subclasses are not "alike" - the simulator simply cannot
 * tell them apart, usually because the mechanics that distinguish them are
 * ones it does not execute. Saying "plays exactly like X" there would dress a
 * measurement failure up as a finding.
 */
export const INDISTINGUISHABLE = 0.05;

export function nearest(vec, vectors, { k = 3, excludeId = null } = {}) {
  const dist = (v) => Math.sqrt(
    v.vec.reduce((n, x, i) => n + (x - vec[i]) ** 2, 0),
  );
  return vectors
    .filter((v) => v.id !== excludeId)
    .map((v) => ({
      ...v,
      distance: dist(v),
      tied: dist(v) < INDISTINGUISHABLE,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/** Which axes make this subclass unlike its neighbour - used for phrasing. */
export function axisGaps(vecA, vecB) {
  return AXES.map((a, i) => ({ axis: a, label: AXIS_LABEL[a], gap: vecA[i] - vecB[i] }))
    .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
}

/* ------------------------------------------------------------------ */
/* corpus build                                                        */
/* ------------------------------------------------------------------ */

/**
 * Simulate every corpus archetype and build the normalised space.
 *
 * Archetypes with no mapped mechanics are EXCLUDED and named. A subclass the
 * engine cannot execute has no behaviour to measure, and including it would
 * silently pull the population mean toward "does nothing".
 */
export async function buildCorpusVectors(cfg) {
  const {
    sources, monsters, spells, mechanics, seeds = 6, maxLevel = 20,
    onProgress = () => {}, cache = null,
  } = cfg;

  const { loadCorpus, ingestOne } = await import('./corpus.js');
  const entries = await loadCorpus();

  const records = [];
  const excluded = [];
  const cacheHits = [];

  for (const [i, entry] of entries.entries()) {
    const r = ingestOne(entry);
    if (!r.ok) {
      excluded.push({ name: entry.file, reason: r.error || 'did not ingest' });
      continue;
    }
    if (r.live === 0) {
      excluded.push({
        name: `${r.class}/${r.name}`,
        reason: 'no mapped mechanics - nothing to measure',
      });
      continue;
    }
    // Mapped is not the same as measurable. A subclass whose only mechanics are
    // reactions maps at 100% live and then simulates exactly like a plain
    // member of its class, so including it would put the BASE CLASS into the
    // neighbour space under the homebrew's name.
    const split = executableSplit(r.brew);
    if (split.counts.executed === 0) {
      excluded.push({
        name: `${r.class}/${r.name}`,
        reason: `mapped ${split.counts.inert} effect(s), none the simulator runs `
          + `(${Object.keys(split.inert).join(', ')})`,
      });
      continue;
    }

    const hash = brewHash(r.brew);
    const cached = cache?.[r.id];
    if (cached && cached.hash === hash) {
      records.push({ ...cached, cached: true });
      cacheHits.push(r.id);
    } else {
      const base = {
        sources: {
          ...sources,
          homebrew: [...(sources.homebrew || []).filter((h) => h.id !== r.id), r.brew],
        },
        monsters, spells, mechanics, maxLevel,
      };
      records.push({
        id: r.id, name: r.name, class: r.class,
        document: r.document, hash,
        coverage: r.coverage,
        metrics: measure(r.class, r.id, base, seeds),
      });
    }

    if (i % 5 === 0) {
      onProgress({ done: i + 1, total: entries.length, name: r.name });
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  const { stats, vectors } = normalise(records);
  return {
    generated: new Date().toISOString(),
    seeds,
    axes: AXES,
    stats,
    // Whether the axes are actually four independent things. Recorded on every
    // build so a change that flattens or duplicates an axis is visible in the
    // artifact instead of quietly degrading the neighbour search.
    diagnostics: axisDiagnostics(records),
    counts: {
      simulated: records.length - cacheHits.length,
      cached: cacheHits.length,
      excluded: excluded.length,
      total: entries.length,
    },
    // Named, not silently dropped.
    excluded,
    vectors,
  };
}

/** Persist / load the vector cache through the server. */
export async function saveVectors(payload) {
  const res = await fetch(`${serverBase()}/api/vectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`vector save failed: ${res.status}`);
  return res.json();
}

export async function loadVectors() {
  try {
    const res = await fetch(`${serverBase()}/api/vectors`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
