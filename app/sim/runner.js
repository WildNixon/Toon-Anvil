/**
 * Batch runner.
 *
 * Loads the compendium once, then drives runCampaign across every
 * class/subclass combination and seed, streaming results to serve.py.
 *
 * Runs on the main thread with periodic yields rather than in a Worker. The
 * whole point of this harness is that it executes the app's REAL modules, and
 * keeping it in the same context means there is exactly one copy of the engine
 * and no message-passing layer to drift out of sync. If throughput becomes the
 * constraint, sharding by seed across workers is the cheap fix - correctness
 * first.
 */

import { compendia, dataFile, serverBase } from '../core/db.js';
import { runCampaign } from './campaign.js';
import { INVARIANT_IDS } from './invariants.js';

export const SRD_SUBCLASS_OF = {}; // filled at load from the compendium

/** Load everything the emulator needs, once. */
export async function loadSources() {
  const c = await compendia(
    'classes', 'species', 'backgrounds', 'feats', 'spells', 'monsters',
    'equipment', 'conditions',
  );
  const [srdEffects, mechFile, homebrew] = await Promise.all([
    dataFile('srd-effects.json', {}),
    dataFile('spell-mechanics.json'),
    fetch(`${serverBase()}/api/homebrew`).then((r) => r.json()).catch(() => []),
  ]);

  return {
    sources: {
      classes: c.classes, species: c.species, backgrounds: c.backgrounds,
      feats: c.feats, srdEffects, homebrew, equipment: c.equipment,
    },
    monsters: c.monsters,
    spells: c.spells,
    mechanics: mechFile.mechanics,
    spellCoverage: mechFile.coverageByClass,
    homebrew,
  };
}

/**
 * Every class/subclass combination worth running.
 * SRD ships exactly one subclass per class; homebrew joins the same sweep.
 */
export function buildMatrix(sources) {
  const combos = [];
  for (const cls of sources.classes) {
    for (const sub of cls.subclasses || []) {
      combos.push({ classId: cls.id, subclassId: sub.id, name: sub.name, kind: 'srd' });
    }
    for (const brew of sources.homebrew || []) {
      if (String(brew.class || '').toLowerCase() === cls.id) {
        combos.push({
          classId: cls.id, subclassId: brew.id, name: brew.name, kind: 'homebrew',
        });
      }
    }
  }
  return combos;
}

/**
 * Run a full sweep.
 *
 * @param {object} cfg {seeds, maxLevel, onProgress, ablations}
 */
export async function runSweep(cfg = {}) {
  const {
    seeds = 12, maxLevel = 20, onProgress = () => {}, ablations = [],
    yieldEvery = 4,
  } = cfg;

  const loaded = await loadSources();
  const matrix = buildMatrix(loaded.sources);
  const started = Date.now();

  const runs = [];
  const total = matrix.length * seeds + ablations.length * seeds * 2;
  let done = 0;

  for (const combo of matrix) {
    for (let s = 0; s < seeds; s += 1) {
      const run = runCampaign({
        classId: combo.classId,
        subclassId: combo.subclassId,
        seed: s,
        sources: loaded.sources,
        monsters: loaded.monsters,
        spells: loaded.spells,
        mechanics: loaded.mechanics,
        maxLevel,
      });
      run.comboName = combo.name;
      run.comboKind = combo.kind;
      runs.push(run);
      done += 1;
      if (done % yieldEvery === 0) {
        onProgress({ done, total, current: `${combo.name} seed ${s}` });
        // Yield so the console can paint and the tab stays responsive.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // --- paired ablations: same seed, feature on vs off -------------------
  const ablationRuns = [];
  for (const ab of ablations) {
    for (let s = 0; s < seeds; s += 1) {
      const common = {
        classId: ab.classId, subclassId: ab.subclassId, seed: s,
        sources: loaded.sources, monsters: loaded.monsters,
        spells: loaded.spells, mechanics: loaded.mechanics, maxLevel,
      };
      const on = runCampaign(common);
      const off = runCampaign({ ...common, ablate: ab });
      ablationRuns.push({
        label: ab.label, classId: ab.classId, subclassId: ab.subclassId,
        seed: s, effectType: ab.effectType, featureId: ab.featureId,
        on: on.metrics, off: off.metrics,
        onCompleted: on.completed, offCompleted: off.completed,
      });
      done += 2;
      if (done % yieldEvery === 0) {
        onProgress({ done, total, current: `ablation ${ab.label} seed ${s}` });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  return assemble(runs, ablationRuns, loaded, {
    seeds, maxLevel, elapsed, matrix,
  });
}

/** Fold raw runs into the payload the grader consumes. */
function assemble(runs, ablationRuns, loaded, meta) {
  // --- coverage union across every run ----------------------------------
  const coverage = {
    effectTypes: {}, features: {}, spells: {}, eventTypes: {},
    triggers: {}, rollTables: {},
  };
  for (const run of runs) {
    for (const [bucket, counts] of Object.entries(run.coverage)) {
      for (const [k, v] of Object.entries(counts)) {
        coverage[bucket][k] = (coverage[bucket][k] || 0) + v;
      }
    }
  }

  // --- what NEVER fired (the negative evidence that H2 demands) ---------
  const presentEffects = new Set(
    Object.keys(coverage.effectTypes)
      .filter((k) => k.endsWith(':present'))
      .map((k) => k.replace(':present', '')),
  );
  const firedEffects = new Set(
    Object.keys(coverage.effectTypes).filter((k) => !k.endsWith(':present')),
  );
  const neverFired = [...presentEffects].filter((e) => !firedEffects.has(e));

  // --- per-combo aggregation -------------------------------------------
  const byCombo = {};
  for (const run of runs) {
    const key = `${run.classId}/${run.subclassId}`;
    if (!byCombo[key]) {
      byCombo[key] = {
        classId: run.classId, subclassId: run.subclassId,
        name: run.comboName, kind: run.comboKind,
        runs: 0, completed: 0, deaths: [], dpr: [], dtpr: [],
        downRate: [], rounds: [], violations: 0, roundCaps: 0,
      };
    }
    const c = byCombo[key];
    c.runs += 1;
    if (run.completed) c.completed += 1;
    else c.deaths.push(run.deathLevel);
    c.dpr.push(run.metrics.dpr);
    c.dtpr.push(run.metrics.dtpr);
    c.downRate.push(run.metrics.downRate);
    c.rounds.push(run.metrics.rounds);
    c.violations += run.violations.length;
    c.roundCaps += run.metrics.roundCaps;
  }

  // --- violations, grouped by invariant --------------------------------
  const violationsById = {};
  const samples = {};
  for (const run of runs) {
    for (const v of run.violations) {
      violationsById[v.id] = (violationsById[v.id] || 0) + 1;
      if (!samples[v.id]) samples[v.id] = { ...v };
    }
  }

  return {
    generated: new Date().toISOString(),
    config: {
      seeds: meta.seeds, maxLevel: meta.maxLevel,
      combos: meta.matrix.length, elapsedSeconds: +meta.elapsed.toFixed(1),
    },
    spellCoverage: loaded.spellCoverage,
    byCombo,
    ablations: ablationRuns,
    coverage,
    // Explicitly enumerated so the report cannot quietly omit them.
    neverFired,
    invariants: {
      checked: INVARIANT_IDS,
      violations: violationsById,
      samples,
      clean: Object.keys(violationsById).length === 0,
    },
    notes: [...new Set(runs.flatMap((r) => r.notes))],
  };
}

/** POST a completed sweep to the server for grading. */
export async function publish(payload, label = 'sweep') {
  const res = await fetch(`${serverBase()}/api/sim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, payload }),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status}`);
  return res.json();
}
