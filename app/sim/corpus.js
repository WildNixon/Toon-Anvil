/**
 * Batch harness over the corpus.
 *
 * Runs every archetype through the real pipeline - adapter, mapping, effects,
 * derive - and reports what came out. This is the honest test the three
 * hand-written files could never be: 107 subclasses by different authors, in a
 * different rules era, none of them written to our conventions.
 *
 * The output is deliberately failure-forward. Anything that does not ingest, or
 * ingests with no live mechanics, is named individually. A batch report that
 * only shows averages hides exactly the cases worth looking at.
 */

import { parse, FIDELITY } from '../homebrew/adapters.js';
import { suggestAll, acceptSuggestions, mappingStats } from '../homebrew/mapping.js';
import { derive } from '../core/derive.js';
import { serverBase } from '../core/db.js';

/** Load the corpus index and every archetype file. */
export async function loadCorpus() {
  const listing = await (await fetch(`${serverBase()}/api/drop`)).json();
  // Skip the corpus index - it is metadata, not an archetype, and counting it
  // as a failed ingest overstates the failure rate.
  const files = listing.files.filter(
    (f) => f.origin === 'corpus' && !f.name.startsWith('_'),
  );
  const out = [];
  for (const f of files) {
    try {
      const json = await (await fetch(`${serverBase()}${f.url}`)).json();
      out.push({ file: f.name, json });
    } catch (err) {
      out.push({ file: f.name, error: err.message });
    }
  }
  return out;
}

/**
 * Ingest + map one archetype.
 * Returns a per-entry record, including for failures - never throws.
 */
export function ingestOne(entry) {
  const base = { file: entry.file };
  if (entry.error) return { ...base, ok: false, stage: 'fetch', error: entry.error };

  let brew;
  try {
    brew = parse('open5e', entry.json);
  } catch (err) {
    return { ...base, ok: false, stage: 'adapter', error: err.message };
  }

  if (!brew.features.length) {
    return {
      ...base, ok: false, stage: 'extract', name: brew.name, class: brew.class,
      error: 'no features extracted',
      descChars: (entry.json.desc || '').length,
    };
  }

  let mapped;
  try {
    mapped = acceptSuggestions(suggestAll(brew));
  } catch (err) {
    return { ...base, ok: false, stage: 'mapping', name: brew.name, error: err.message };
  }

  const stats = mappingStats(mapped);
  const effectTypes = {};
  for (const f of mapped.features) {
    for (const e of f.effects || []) {
      if (e.type !== 'narrative_only') {
        effectTypes[e.type] = (effectTypes[e.type] || 0) + 1;
      }
    }
  }

  return {
    ...base,
    ok: true,
    id: mapped.id,
    name: mapped.name,
    class: mapped.class,
    document: entry.json.source?.document || null,
    licenseUrl: entry.json.source?.licenseUrl || null,
    adapter: mapped.adapter,
    fidelity: mapped.fidelity,
    features: stats.features,
    live: stats.live,
    unmapped: stats.unmapped,
    effects: stats.effects,
    coverage: stats.features ? stats.live / stats.features : 0,
    effectTypes,
    levels: mapped.features.map((f) => f.level),
    brew: mapped,
  };
}

/** Does it survive derive()? A brew that maps but crashes the engine is worse. */
export function checkDerives(record, sources, level = 10) {
  if (!record.ok) return record;
  try {
    const ch = {
      id: `corpus-${record.id}`,
      name: record.name,
      classes: [{ class: record.class, subclass: record.id, level }],
      abilities: { str: 14, dex: 14, con: 14, int: 12, wis: 12, cha: 15 },
      hp: { max: 70, current: 70, temp: 0 },
      inventory: [], currency: {}, toggles: {},
      skills: [], feats: [],
    };
    const withBrew = {
      ...sources,
      homebrew: [...(sources.homebrew || []).filter((h) => h.id !== record.id), record.brew],
    };
    const d = derive(ch, withBrew);
    return {
      ...record,
      derives: true,
      derivedAc: d.ac,
      derivedAttacks: d.attacks.length,
      derivedActions: d.actions.length,
      derivedResources: d.resources.length,
      liveOnSheet: d.features.reduce(
        (n, f) => n + (f.effects || []).filter((e) => e.type !== 'narrative_only').length, 0,
      ),
    };
  } catch (err) {
    return { ...record, derives: false, deriveError: err.message };
  }
}

/** Run the whole corpus. */
export async function runCorpus(sources, { onProgress = () => {} } = {}) {
  const entries = await loadCorpus();
  const records = [];
  for (const [i, entry] of entries.entries()) {
    records.push(checkDerives(ingestOne(entry), sources));
    if (i % 10 === 0) {
      onProgress({ done: i + 1, total: entries.length });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return summarise(records);
}

function summarise(records) {
  const ok = records.filter((r) => r.ok);
  const failed = records.filter((r) => !r.ok);
  const derived = ok.filter((r) => r.derives);
  const deriveFailed = ok.filter((r) => r.derives === false);

  // Coverage buckets, so "how well does this work" is a distribution rather
  // than a single flattering average.
  const buckets = { none: 0, low: 0, partial: 0, good: 0, full: 0 };
  for (const r of ok) {
    const c = r.coverage;
    if (c === 0) buckets.none += 1;
    else if (c < 0.34) buckets.low += 1;
    else if (c < 0.67) buckets.partial += 1;
    else if (c < 1) buckets.good += 1;
    else buckets.full += 1;
  }

  const effectTotals = {};
  for (const r of ok) {
    for (const [t, n] of Object.entries(r.effectTypes || {})) {
      effectTotals[t] = (effectTotals[t] || 0) + n;
    }
  }

  const byClass = {};
  for (const r of ok) {
    const c = r.class || 'unknown';
    byClass[c] ||= { n: 0, live: 0, features: 0 };
    byClass[c].n += 1;
    byClass[c].live += r.live;
    byClass[c].features += r.features;
  }

  const byDocument = {};
  for (const r of ok) {
    const d = r.document || 'unknown';
    byDocument[d] ||= { n: 0, coverage: 0 };
    byDocument[d].n += 1;
    byDocument[d].coverage += r.coverage;
  }
  for (const v of Object.values(byDocument)) v.coverage /= v.n;

  return {
    generated: new Date().toISOString(),
    counts: {
      total: records.length,
      ingested: ok.length,
      failed: failed.length,
      derives: derived.length,
      deriveFailed: deriveFailed.length,
      featuresTotal: ok.reduce((n, r) => n + r.features, 0),
      liveTotal: ok.reduce((n, r) => n + r.live, 0),
    },
    coverage: {
      mean: ok.length ? ok.reduce((n, r) => n + r.coverage, 0) / ok.length : 0,
      buckets,
    },
    effectTotals,
    byClass,
    byDocument,
    // Named individually. No silent drops.
    failures: failed.map((r) => ({
      file: r.file, stage: r.stage, name: r.name || null, error: r.error,
      descChars: r.descChars,
    })),
    deriveFailures: deriveFailed.map((r) => ({
      name: r.name, class: r.class, error: r.deriveError,
    })),
    zeroCoverage: ok.filter((r) => r.coverage === 0)
      .map((r) => ({ name: r.name, class: r.class, features: r.features,
                     document: r.document })),
    records: records.map(({ brew, ...rest }) => rest),
  };
}
