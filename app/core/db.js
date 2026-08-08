/**
 * Storage layer.
 *
 * Two adapters behind one interface, chosen at boot:
 *
 *   ServerAdapter    talks to serve.py; records land as readable JSON files on
 *                    disk. This is what lets the installed PWA and the Chrome
 *                    side-panel extension - which are DIFFERENT ORIGINS and so
 *                    cannot share IndexedDB - see one dataset.
 *   IndexedDBAdapter  no server required, origin-local, unlimited quota.
 *
 * Everything above this file is adapter-agnostic. Nothing else in the app may
 * touch IndexedDB or fetch('/api/...') directly.
 */

export const KINDS = ['characters', 'campaigns', 'homebrew', 'npcs', 'shops'];

const DB_NAME = 'toon-anvil';
const DB_VERSION = 1;
const EVENT_STORE = 'events';

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const kind of KINDS) {
        if (!db.objectStoreNames.contains(kind)) {
          db.createObjectStore(kind, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        const store = db.createObjectStore(EVENT_STORE, {
          keyPath: 'seq', autoIncrement: true,
        });
        store.createIndex('characterId', 'characterId');
        store.createIndex('campaignId', 'campaignId');
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

class IndexedDBAdapter {
  constructor() { this.mode = 'local'; this.label = 'This device'; }

  async init() { this.db = await idbOpen(); return this; }

  async list(kind) {
    return tx(this.db, kind, 'readonly', (s) => s.getAll());
  }
  async get(kind, id) {
    return tx(this.db, kind, 'readonly', (s) => s.get(id));
  }
  async put(kind, record) {
    record.updatedAt = new Date().toISOString();
    await tx(this.db, kind, 'readwrite', (s) => s.put(record));
    return record;
  }
  async del(kind, id) {
    await tx(this.db, kind, 'readwrite', (s) => s.delete(id));
    return true;
  }
  async appendEvents(events) {
    await tx(this.db, EVENT_STORE, 'readwrite', (s) => {
      for (const ev of events) s.add(ev);
    });
    return events.length;
  }
  async queryEvents({ characterId, campaignId, limit = 5000 } = {}) {
    const all = await tx(this.db, EVENT_STORE, 'readonly', (s) => s.getAll());
    let out = all;
    if (characterId) out = out.filter((e) => e.characterId === characterId);
    if (campaignId) out = out.filter((e) => e.campaignId === campaignId);
    return out.slice(-limit);
  }
}

/* ------------------------------------------------------------------ */
/* Memory (headless)                                                   */
/* ------------------------------------------------------------------ */

/**
 * In-memory adapter for the campaign emulator.
 *
 * A simulated campaign generates tens of thousands of events that nobody will
 * ever read individually - only the aggregate matters. Writing them through
 * IndexedDB would dominate the runtime and pollute real data, so the sim gets
 * a store that lives and dies with the run. Same interface, so events.js and
 * the rest of the app are none the wiser.
 */
export class MemoryAdapter {
  constructor() {
    this.mode = 'memory';
    this.label = 'in-memory (simulation)';
    this.stores = new Map(KINDS.map((k) => [k, new Map()]));
    this.events = [];
  }

  async init() { return this; }

  async list(kind) { return [...(this.stores.get(kind)?.values() || [])]; }

  async get(kind, id) { return this.stores.get(kind)?.get(id); }

  async put(kind, record) {
    if (!this.stores.has(kind)) this.stores.set(kind, new Map());
    record.updatedAt = new Date().toISOString();
    this.stores.get(kind).set(record.id, record);
    return record;
  }

  async del(kind, id) { return Boolean(this.stores.get(kind)?.delete(id)); }

  async appendEvents(events) {
    this.events.push(...events);
    return events.length;
  }

  async queryEvents({ characterId, campaignId, limit = Infinity } = {}) {
    let out = this.events;
    if (characterId) out = out.filter((e) => e.characterId === characterId);
    if (campaignId) out = out.filter((e) => e.campaignId === campaignId);
    return Number.isFinite(limit) ? out.slice(-limit) : out;
  }

  /** Drop everything - called between simulated campaigns. */
  reset() {
    for (const store of this.stores.values()) store.clear();
    this.events.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

class ServerAdapter {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.mode = 'server';
    this.label = this.base;
  }

  async #json(path, opts) {
    const res = await fetch(this.base + path, {
      headers: { 'Content-Type': 'application/json' }, ...opts,
    });
    if (!res.ok) throw new Error(`${opts?.method || 'GET'} ${path} -> ${res.status}`);
    return res.json();
  }

  async init() { await this.#json('/api/health'); return this; }

  list(kind) { return this.#json(`/api/${kind}`); }

  async get(kind, id) {
    try { return await this.#json(`/api/${kind}/${encodeURIComponent(id)}`); }
    catch { return undefined; }
  }

  async put(kind, record) {
    await this.#json(`/api/${kind}/${encodeURIComponent(record.id)}`, {
      method: 'PUT', body: JSON.stringify(record),
    });
    return record;
  }

  async del(kind, id) {
    await this.#json(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  }

  async appendEvents(events) {
    await this.#json('/api/events', { method: 'POST', body: JSON.stringify(events) });
    return events.length;
  }

  queryEvents({ characterId, campaignId, limit = 5000 } = {}) {
    const q = new URLSearchParams();
    if (characterId) q.set('character', characterId);
    if (campaignId) q.set('campaign', campaignId);
    q.set('limit', String(limit));
    return this.#json(`/api/events?${q}`);
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

const PREF_KEY = 'toonanvil.dataSource';

/** Where the extension should look for the shared server. */
export const DEFAULT_SERVER = 'http://127.0.0.1:7801';

export function serverBase() {
  // Served by serve.py: same origin. Inside the extension: the localhost server.
  if (location.protocol.startsWith('http')) return location.origin;
  return localStorage.getItem('toonanvil.serverBase') || DEFAULT_SERVER;
}

let adapter = null;

/**
 * Pick a backend. Preference order:
 *   explicit user setting -> shared server if reachable -> IndexedDB.
 *
 * Falling back is silent by design: the app must open and be usable when
 * serve.py is not running. `db.mode` tells the UI which one it got.
 */
export async function initDb({ prefer, inject } = {}) {
  // The emulator injects a MemoryAdapter so a sweep never touches real data.
  if (inject) {
    adapter = await inject.init();
    return adapter;
  }
  const choice = prefer || localStorage.getItem(PREF_KEY) || 'auto';

  // Ephemeral mode. Everything - characters AND the event log, since both go
  // through this adapter - lives in memory and is gone on reload. The UI test
  // tier runs the real app this way so that clicking through it cannot create
  // junk characters or append to somebody's real chronicle.
  //
  // Deliberately NOT reachable from the stored preference: it is opt-in per
  // load, so nobody can leave the app in a state where their work silently
  // stops being saved.
  if (choice === 'memory') {
    adapter = await new MemoryAdapter().init();
    return adapter;
  }

  if (choice !== 'local') {
    try {
      adapter = await new ServerAdapter(serverBase()).init();
      return adapter;
    } catch (err) {
      if (choice === 'server') {
        console.warn('[db] shared server unreachable, using local storage', err);
      }
    }
  }
  adapter = await new IndexedDBAdapter().init();
  return adapter;
}

export function setDataSource(pref) {
  localStorage.setItem(PREF_KEY, pref);
}

export function getDataSource() {
  return localStorage.getItem(PREF_KEY) || 'auto';
}

/** The live adapter. Throws if used before initDb() resolves. */
export const db = new Proxy({}, {
  get(_t, prop) {
    if (!adapter) throw new Error('db used before initDb()');
    const v = adapter[prop];
    return typeof v === 'function' ? v.bind(adapter) : v;
  },
});

/* ------------------------------------------------------------------ */
/* compendium (read-only, cached)                                      */
/* ------------------------------------------------------------------ */

const cache = new Map();

// Resolve data paths relative to THIS MODULE, not to the page. The sim console
// lives at /sim/sim.html, so a page-relative "./data/..." would look for
// /sim/data/... and 404.
const dataUrl = (path) => new URL(`../data/${path}`, import.meta.url).href;

/** Load a bundled SRD compendium file. Cached for the session. */
export async function compendium(name) {
  if (cache.has(name)) return cache.get(name);
  const p = fetch(dataUrl(`compendium/${name}.json`)).then((r) => {
    if (!r.ok) throw new Error(`compendium ${name} -> ${r.status}`);
    return r.json();
  });
  cache.set(name, p);
  return p;
}

/** Load a non-compendium data file (srd-effects, spell-mechanics). */
export async function dataFile(name, fallback = null) {
  try {
    const res = await fetch(dataUrl(name));
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch (err) {
    if (fallback !== null) return fallback;
    throw new Error(`data file ${name}: ${err.message}`);
  }
}

/** Load several at once: `const {spells, monsters} = await compendia('spells','monsters')` */
export async function compendia(...names) {
  const loaded = await Promise.all(names.map(compendium));
  return Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
}
