/**
 * Live state: knowing when somebody else changed something.
 *
 * The server keeps a revision counter and a short list of what changed. This
 * module watches it two ways and prefers the fast one:
 *
 *   stream   an EventSource held open. Changes arrive in milliseconds.
 *   poll     GET /api/changes?since=N on a timer. Slower, and the one that
 *            always works - through proxies, after a sleep, when the stream
 *            budget is full.
 *
 * The stream is the optimisation; polling is the guarantee. Any failure falls
 * back rather than surfacing, because a DM mid-combat should never have to
 * think about transport.
 *
 * What arrives is only WHAT changed, never the record. Subscribers re-fetch
 * what they display, so there is exactly one source of truth and no chance of
 * a pushed copy disagreeing with the stored one.
 */

import { serverBase, db, CLIENT_ID } from './db.js';

const POLL_MS = 2000;
// After this many silent polls, stop asking so hard. A tab left open
// overnight should not hammer a laptop.
const IDLE_AFTER = 150;
const IDLE_POLL_MS = 15000;

let rev = 0;
let source = null;
let timer = null;
let idleTicks = 0;
let mode = 'off';
let started = false;

const subscribers = new Set();

/**
 * Watch for changes.
 *
 * `kinds` is a list like ['characters', 'table'] or null for everything.
 * Returns an unsubscribe function.
 */
export function subscribe(kinds, fn) {
  const entry = { kinds: kinds ? new Set(kinds) : null, fn };
  subscribers.add(entry);
  return () => subscribers.delete(entry);
}

/**
 * Has the server stopped answering?
 *
 * The poll already knew - it caught the failure and returned false - but it
 * told nobody, so the app went on looking perfectly healthy with every
 * button quietly doing nothing. That is the worst shape a failure can take:
 * a screen that says everything is fine.
 *
 * Counted rather than tripped on the first miss, because one dropped request
 * on a busy laptop is not a stopped server.
 */
const REACH_MISSES_BEFORE_GONE = 2;
let misses = 0;
let reachable = true;
const reachWatchers = new Set();

export function serverReachable() { return reachable; }

/** Called with (reachable) whenever that answer changes. Returns unsubscribe. */
export function onReachChange(fn) {
  reachWatchers.add(fn);
  return () => reachWatchers.delete(fn);
}

/**
 * A heartbeat that measures reachability directly, whatever transport is up.
 *
 * The first version inferred it from the poll, which meant it only worked in
 * poll mode: with a stream open, a killed server left EventSource retrying
 * in CONNECTING forever, the poll never ran, and the app cheerfully reported
 * `reachable: true` while every button failed. Inferring a fact from a side
 * effect of an unrelated mechanism is how you get an answer that is right
 * most of the time and silent exactly when it matters.
 *
 * So this asks. One tiny request every REACH_MS, independent of stream or
 * poll - cheap next to the 2s change poll it sits beside, and it cannot be
 * defeated by a transport quirk.
 */
const REACH_MS = 10000;
let reachTimer = null;

async function reachPing() {
  try {
    const res = await fetch(`${serverBase()}/api/health`, { cache: 'no-store' });
    noteReach(res.ok);
  } catch {
    noteReach(false);
  }
}

function startReachWatch() {
  if (reachTimer) return;
  reachPing();
  reachTimer = setInterval(reachPing, REACH_MS);
}

function noteReach(ok) {
  misses = ok ? 0 : misses + 1;
  const now = ok || misses < REACH_MISSES_BEFORE_GONE;
  if (now === reachable) return;
  reachable = now;
  for (const fn of reachWatchers) {
    try { fn(reachable); } catch { /* a bad watcher must not stop the rest */ }
  }
}

export function status() {
  return { mode, rev, subscribers: subscribers.size, reachable };
}

function deliver(changes, gap) {
  // A gap means we were away longer than the server remembers, so we cannot
  // say what changed - only that something did. Subscribers are told, and the
  // honest response is a full re-read rather than a partial update.
  for (const { kinds, fn } of subscribers) {
    const mine = gap ? changes
      : changes.filter((c) => !kinds || kinds.has(c.kind));
    if (gap || mine.length) {
      try { fn({ changes: mine, gap, rev }); } catch { /* a bad subscriber
        must not stop the others from being told */ }
    }
  }
}

function apply(payload) {
  if (!payload) return;
  if (typeof payload.rev === 'number') {
    // A rev that went BACKWARDS means the server restarted and its counter
    // reset. Treat it as a gap: everything we believe may be stale.
    if (payload.rev < rev) {
      rev = payload.rev;
      deliver([], true);
      return;
    }
    rev = payload.rev;
  }
  // Drop the echo of our own writes. The server tags each change with the tab
  // that caused it, and re-rendering on your own keystrokes is how a cursor
  // ends up jumping mid-word in Build.
  const changes = (payload.changes || []).filter((c) => c.by !== CLIENT_ID);
  if (changes.length || payload.gap) {
    idleTicks = 0;
    deliver(changes, Boolean(payload.gap));
  }
}

/* ------------------------------------------------------------------ */
/* polling - the one that always works                                 */
/* ------------------------------------------------------------------ */

async function pollOnce() {
  try {
    const res = await fetch(`${serverBase()}/api/changes?since=${rev}`);
    if (!res.ok) return false;
    apply(await res.json());
    return true;
  } catch {
    return false;
  }
}

function startPolling() {
  mode = 'poll';
  stopPolling();
  const tick = async () => {
    const ok = await pollOnce();
    noteReach(ok);
    idleTicks = ok ? idleTicks + 1 : 0;
    const wait = idleTicks > IDLE_AFTER ? IDLE_POLL_MS : POLL_MS;
    timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, POLL_MS);
}

function stopPolling() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ------------------------------------------------------------------ */
/* stream - the fast path                                              */
/* ------------------------------------------------------------------ */

function startStream() {
  // The stream is the fast path; polling is the fallback. Running both would
  // double every delivery and burn a request every two seconds for nothing.
  stopPolling();
  if (typeof EventSource === 'undefined') { startPolling(); return; }
  try {
    source = new EventSource(`${serverBase()}/api/stream?since=${rev}`);
  } catch {
    startPolling();
    return;
  }

  source.onopen = () => {
    mode = 'stream';
    // Belt and braces: keep a slow poll running underneath. A stream can go
    // quiet without erroring - a sleeping laptop, a proxy holding the
    // connection open - and a table that silently stops updating is worse
    // than one that updates slowly.
    stopPolling();
    timer = setTimeout(async function slowTick() {
      await pollOnce();
      timer = setTimeout(slowTick, IDLE_POLL_MS);
    }, IDLE_POLL_MS);
  };

  source.onmessage = (ev) => {
    try { apply(JSON.parse(ev.data)); } catch { /* a comment or a partial */ }
  };

  source.onerror = () => {
    // EventSource reconnects on its own, but the server also ends streams on
    // purpose after a few minutes. Either way, polling covers the gap.
    //
    // Polling starts on ANY stream error, not only on CLOSED. When the
    // server stops, EventSource sits in CONNECTING and retries forever - it
    // never reaches CLOSED - so gating the fallback on CLOSED meant nothing
    // ever noticed the server had gone. Measured: with the server killed the
    // app reported mode 'stream', reachable true, and showed no warning at
    // all while every button quietly failed.
    //
    // The poll is the only thing that MEASURES reachability, and its own
    // two-miss counter is what keeps a routine stream restart from being
    // reported as an outage.
    if (!timer) startPolling();
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      // Try the fast path again shortly; a dropped stream is usually
      // transient and polling is the fallback, not the destination.
      setTimeout(() => { if (started && !source) startStream(); }, 5000);
    }
  };
}

/* ------------------------------------------------------------------ */

/** Begin watching. Safe to call more than once. */
export async function start() {
  if (started) return status();
  // Only a shared server can be changed by somebody else. On IndexedDB or in
  // an ephemeral sandbox this browser is the only writer, so watching would
  // burn a connection to be told about our own writes.
  try {
    if (db.mode !== 'server') { mode = 'off'; return status(); }
  } catch { mode = 'off'; return status(); }

  // Independent of stream or poll, because it is the ONLY thing that
  // actually measures whether the server is there.
  startReachWatch();

  started = true;
  // Learn the current revision first, so the first message is not a flood of
  // everything that happened before this browser existed.
  try {
    const res = await fetch(`${serverBase()}/api/changes?since=0`);
    if (res.ok) rev = (await res.json()).rev || 0;
  } catch {
    // No server: this is a local-storage session and nothing else will ever
    // change the data. Staying 'off' is correct, not a failure.
    started = false;
    mode = 'off';
    return status();
  }
  startStream();
  return status();
}

export function stop() {
  started = false;
  mode = 'off';
  stopPolling();
  if (source) { source.close(); source = null; }
}

/** Ask right now rather than waiting for the next tick. */
export async function refreshNow() {
  await pollOnce();
  return status();
}
