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

/**
 * Record kinds.
 *
 * The `custom-*` kinds hold content ingested from a dropped PDF or written by
 * hand - monsters, magic items and spells that sit alongside the SRD rather
 * than inside it. Kept as separate stores rather than mixed into the
 * compendium files so that the bundled SRD data stays exactly as shipped and
 * can be rebuilt at any time without taking somebody's homebrew with it.
 */
export const KINDS = ['characters', 'campaigns', 'homebrew', 'npcs', 'shops',
  'custom-monsters', 'custom-items', 'custom-spells', 'profiles'];

/** Which compendium each custom store extends. */
export const CUSTOM_KINDS = {
  'custom-monsters': 'monsters',
  'custom-items': 'magic-items',
  'custom-spells': 'spells',
};

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

  /**
   * The table token, read straight from localStorage.
   *
   * session.js owns this key, but importing it here would be circular - it
   * needs serverBase() from this file. One string constant is a smaller price
   * than a dependency cycle, and it is asserted in the gym so the two cannot
   * drift apart.
   */
  static get TOKEN_KEY() { return 'toonanvil.token'; }

  #token() {
    try { return localStorage.getItem(ServerAdapter.TOKEN_KEY) || null; }
    catch { return null; }
  }

  async #json(path, opts) {
    const token = this.#token();
    const res = await fetch(this.base + path, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Toon-Token': token } : {}),
      },
      ...opts,
    });
    if (!res.ok) {
      // A refusal from the table carries a reason worth showing: "that is
      // somebody else's character" is far more use than "PUT -> 403".
      let detail = '';
      try {
        const body = await res.json();
        if (body?.error) detail = ` - ${body.error}`;
      } catch { /* not json */ }
      const err = new Error(`${opts?.method || 'GET'} ${path} -> ${res.status}${detail}`);
      err.status = res.status;
      err.refused = res.status === 401 || res.status === 403;
      throw err;
    }
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

/**
 * Open the REAL store alongside whatever is currently active.
 *
 * Exists for one job: a sandbox session runs on a MemoryAdapter, and "save
 * this to my library" has to reach past it to the store the app would
 * normally use. Returns a fresh adapter and deliberately does NOT replace the
 * module-level one - a sandbox that quietly reattached itself to real storage
 * would stop being a sandbox halfway through.
 *
 * Mirrors initDb()'s choice, minus the ephemeral option.
 */
export async function openRealStore() {
  const choice = localStorage.getItem(PREF_KEY) || 'auto';
  if (choice !== 'local') {
    try {
      return await new ServerAdapter(serverBase()).init();
    } catch { /* fall through to local */ }
  }
  return new IndexedDBAdapter().init();
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

/**
 * The compendium plus anything the user has added.
 *
 * Custom records carry `custom: true` and are appended rather than merged, so
 * the SRD list is always the prefix and a screen can tell the two apart
 * without keeping a second list. A custom record whose id collides with an SRD
 * one is renamed rather than shadowing it - somebody's homebrew goblin must
 * not quietly replace the goblin everything else refers to.
 */
export async function compendiumWithCustom(name) {
  const base = await compendium(name);
  const store = Object.entries(CUSTOM_KINDS).find(([, v]) => v === name)?.[0];
  if (!store || !Array.isArray(base)) return base;

  let custom = [];
  try {
    custom = await db.list(store);
  } catch { return base; }
  if (!custom.length) return base;

  const taken = new Set(base.map((r) => r.id));
  const merged = custom.map((r) => {
    if (!taken.has(r.id)) { taken.add(r.id); return { ...r, custom: true }; }
    const id = `${r.id}-custom`;
    taken.add(id);
    return { ...r, id, custom: true, shadowed: r.id };
  });
  return [...base, ...merged];
}

/** How much custom content exists, for badges and empty states. */
export async function customCounts() {
  const out = {};
  for (const store of Object.keys(CUSTOM_KINDS)) {
    try { out[store] = (await db.list(store)).length; } catch { out[store] = 0; }
  }
  return out;
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
