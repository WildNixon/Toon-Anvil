/**
 * PERF - how long a screen took to arrive, kept honestly.
 *
 * The app has never measured itself. It was reported as sluggish opening and
 * switching screens, and the first move was to stop guessing: this is a ring
 * of the last few hundred renders, recorded by renderMode() at the two
 * brackets its stale-render guards already provide.
 *
 * Three rules the numbers depend on:
 *
 *   1. A MOUNT AND A REPAINT ARE DIFFERENT DISTRIBUTIONS. Arriving at a
 *      screen you were not on pays for a module graph and a first paint;
 *      repainting the screen you are looking at does not. Pooling them makes
 *      a number that describes neither, so `kind` is on every sample and
 *      summary() never mixes them.
 *   2. A SUPERSEDED RENDER IS NOT A SAMPLE. renderMode() bumps a sequence on
 *      entry and returns if it is no longer the newest; nothing that returned
 *      early ever reaches this module.
 *   3. PAINT AND SETTLE ARE NOT THE SAME EVENT, and the first draft of this
 *      file recorded the second while calling it the first. A mode's render()
 *      may resolve long after its screen is usable: settings paints in one
 *      frame, then spends about three seconds probing connectors, redrawing
 *      twice as answers arrive. Timing to the resolve reported that as a
 *      3054 ms paint. So both are kept - `paintMs` is the first frame with
 *      content on it, `settleMs` the frame after render() resolves - and the
 *      gap between them is the progressive part, a design worth seeing rather
 *      than a cost to hide. Timing paint at the resolve would also make a
 *      screen that paints BEFORE its data arrives look exactly as slow as one
 *      that waits for it, which is the improvement this file exists to see.
 *
 * window.__perf is set unconditionally. It is a read-only diagnostic on a
 * local offline app, and the gym drives fourteen iframes: a flag would have
 * to be threaded through every one of their URLs and would be on in every
 * run anyway. `?perf=1` means one extra thing - each sample is also logged
 * as it lands, so a human watching devtools sees the cost of a tap live.
 */

const MAX = 200;

// A frame loop that never ends is worse than a missing number: ten seconds at
// 60fps. A screen still blank after that has a problem no timer will explain.
const MAX_FRAMES = 600;

const ring = [];
let seq = 0;
let loud = false;

/** Say each sample aloud as it lands. Armed by ?perf=1 at boot. */
export function setLoud(on) { loud = Boolean(on); }

/** One render. Called only by renderMode(), only for renders that won. */
export function record(sample) {
  seq += 1;
  const row = { i: seq, at: Math.round(performance.now()), ...sample };
  ring.push(row);
  if (ring.length > MAX) ring.shift();
  if (loud) {
    // eslint-disable-next-line no-console
    const late = Number.isFinite(row.settleMs) && Number.isFinite(row.paintMs)
      && row.settleMs - row.paintMs >= 50
      ? `, settled ${row.settleMs}ms` : '';
    console.info(`[perf] ${row.kind} ${row.mode} paint `
      + `${row.paintMs === null ? 'never' : `${row.paintMs}ms`}${late}`
      + ` module ${row.moduleMs}ms${row.warm ? ' (warm)' : ''}`);
  }
  return row;
}

/**
 * The first frame `node` has content on it, watched rather than awaited.
 *
 * Started the moment the old view is cleared and left running across the
 * render, so a mode that paints early and resolves late is timed at the paint.
 * Returns a box whose `ms` fills in when that frame lands - the caller reads
 * it at settle time and reports null if it never did.
 *
 * The timestamp is taken one frame AFTER content is seen, because a rAF
 * callback runs BEFORE the paint it belongs to: content observed in frame N
 * reaches the glass at the end of frame N, so frame N+1 is the first moment it
 * is provably on screen. That rounds up by at most one frame. A paint number
 * is better late than imaginary.
 *
 * `seen` is that same moment one frame earlier, and exists only so a caller
 * that stops the watcher in the very frame the timestamp was due does not turn
 * a real paint into a null. Reading it costs at most one frame of optimism;
 * losing the sample costs the sample.
 */
export function watchPaint(node, alive, t0) {
  const box = { ms: null, seen: null, frames: 0, stop: null };
  let id = 0;
  let done = false;
  box.stop = () => { done = true; if (id) cancelAnimationFrame(id); };
  const look = () => {
    if (done) return;
    if (!alive()) { box.stop(); return; }
    box.frames += 1;
    if (node.firstChild) {
      box.seen = performance.now() - t0;
      id = requestAnimationFrame(() => {
        if (done || !alive()) return;
        box.ms = performance.now() - t0;
        done = true;
      });
      return;
    }
    if (box.frames >= MAX_FRAMES) { box.stop(); return; }
    id = requestAnimationFrame(look);
  };
  id = requestAnimationFrame(look);
  return box;
}

/** Everything held, oldest first. A copy - callers must not edit the ring. */
export function all() { return ring.slice(); }

/**
 * Take the samples and forget them. The gym drains a frame's buffer into the
 * run's metrics; draining rather than reading is what stops one flow's
 * renders being counted again by the next.
 */
export function drain() {
  const out = ring.slice();
  ring.length = 0;
  return out;
}

const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  : null);

/**
 * Per mode and kind: n, p50, p90, worst. Nearest-rank, so every number
 * printed is a render that actually happened rather than an interpolation
 * between two that did.
 */
export function summary() {
  const buckets = new Map();
  for (const r of ring) {
    const key = `${r.mode}/${r.kind}`;
    if (!buckets.has(key)) buckets.set(key, { paint: [], settle: [] });
    if (Number.isFinite(r.paintMs)) buckets.get(key).paint.push(r.paintMs);
    if (Number.isFinite(r.settleMs)) buckets.get(key).settle.push(r.settleMs);
  }
  const out = {};
  for (const [key, both] of buckets) {
    const s = both.paint.slice().sort((a, b) => a - b);
    const t = both.settle.slice().sort((a, b) => a - b);
    out[key] = {
      n: s.length,
      p50: s.length ? Math.round(pct(s, 0.5)) : null,
      p90: s.length ? Math.round(pct(s, 0.9)) : null,
      max: s.length ? Math.round(s[s.length - 1]) : null,
      // Reported beside paint, never mixed into it: a screen that paints fast
      // and settles slowly is a different animal from one that is just slow.
      settleP90: t.length ? Math.round(pct(t, 0.9)) : null,
    };
  }
  return out;
}

/** The summary, as a table, for a human in devtools. */
export function table() {
  // eslint-disable-next-line no-console
  console.table(summary());
  return summary();
}

/* ------------------------------------------------------------------ */
/* the state-listener tap                                              */
/* ------------------------------------------------------------------ */

// How long each store listener took, attributed to the key that woke it.
// Off unless ?perf=1: two clock reads per listener per state change is real
// cost added to the thing being measured. It answers the one question the
// render timings cannot - whether a single tap fans out into more repaints
// than anybody thinks.
const listeners = new Map();

export function noteListener(key, ms) {
  const row = listeners.get(key) || { key, calls: 0, total: 0, max: 0 };
  row.calls += 1;
  row.total += ms;
  row.max = Math.max(row.max, ms);
  listeners.set(key, row);
}

export function listenerSummary() {
  return [...listeners.values()]
    .map((r) => ({ ...r, total: Math.round(r.total), max: Math.round(r.max) }))
    .sort((a, b) => b.total - a.total);
}

export function install() {
  if (typeof window === 'undefined') return;
  window.__perf = { all, drain, summary, table, listenerSummary, record };
}

