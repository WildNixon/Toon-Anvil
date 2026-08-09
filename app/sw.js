/**
 * Service worker - makes Toon Anvil work with no server and no network.
 *
 * Strategy differs by what is being fetched:
 *   app source (js/css/html)  network-first, cache fallback
 *   data + fonts              cache-first   (immutable between releases)
 *   /api/*                    network-only  (live data; must never be stale)
 *
 * Source is network-FIRST on purpose. Cache-first is the obvious choice for a
 * PWA and it is wrong here: after `git pull` the browser keeps serving the old
 * modules until some later load happens to refresh them, so a user reports a
 * bug that was already fixed and nothing you tell them to do resolves it.
 * Costing one conditional request per module while online is a good trade for
 * never running yesterday's code. Offline still works - the cache is the
 * fallback, not the primary.
 *
 * The compendium is ~1.7 MB of SRD JSON. Precaching it is the difference
 * between "installed" and "actually usable on a train".
 */

const VERSION = 'toon-anvil-v5';

/** Immutable between releases: safe to serve from cache without asking. */
const IMMUTABLE = /\/(data\/fonts|data\/compendium|icons)\//;
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './ui/design.css',
  './ui/theme.js',
  './ui/kit.js',
  './ui/ribbon.js',
  './ui/welcome.js',
  './core/store.js',
  './core/db.js',
  './core/events.js',
  './core/derive.js',
  './core/dice.js',
  './core/rules2024.js',
  './core/engine.js',
  './core/session.js',
  './core/live.js',
  './core/rng.js',
  './homebrew/effects.js',
  './homebrew/ingest.js',
  './homebrew/mapping.js',
  './homebrew/scraper.js',
  './homebrew/homebrew-ui.js',
  './modes/build/build.js',
  './modes/sheet/sheet.js',
  './modes/combat/combat.js',
  './modes/shop/shop.js',
  './modes/rp/rp.js',
  './modes/chronicle/chronicle.js',
  './modes/dm/dm.js',
  './modes/dm/stage.js',
  './modes/dm/world.js',
  './modes/dm/story.js',
  './modes/dm/setup.js',
  './ui/joingate.js',
  './modes/dm/runner.js',
  './modes/dm/party.js',
  './modes/dm/loot.js',
  './modes/dm/panels.js',
  './modes/dm/generators.js',
  './modes/settings/settings.js',
  './modes/table/table.js',
  './core/providers.js',
  './homebrew/parse-content.js',
  './data/dm-tables.json',
  './data/srd-effects.json',
  './data/compendium/classes.json',
  './data/compendium/species.json',
  './data/compendium/backgrounds.json',
  './data/compendium/feats.json',
  './data/compendium/spells.json',
  './data/compendium/monsters.json',
  './data/compendium/equipment.json',
  './data/compendium/magic-items.json',
  './data/compendium/conditions.json',
  './data/compendium/glossary.json',
  './data/compendium/_meta.json',
  './data/fonts/cinzel-700.woff2',
  './data/fonts/alegreya-400.woff2',
  './data/fonts/alegreya-600.woff2',
  './data/fonts/alegreya-italic-400.woff2',
  './data/fonts/plex-mono-400.woff2',
  './data/fonts/plex-mono-600.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll is atomic - one 404 would reject the whole install and leave the
    // app permanently uninstallable, so add individually and tolerate misses.
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not precache', url, err); }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data must never come from cache, or you would edit a character and
  // watch the old one come back.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/samples/')) {
    return;
  }

  // An explicit cache-buster must actually bust the cache. Matching with
  // ignoreSearch:true strips the query string, so "?v=123" would silently
  // return the stale entry - which makes it impossible to load an updated
  // module without unregistering the worker entirely.
  if (url.search) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          // Store under the bare URL so the next plain request gets the new file.
          (await caches.open(VERSION)).put(new Request(url.pathname), fresh.clone());
        }
        return fresh;
      } catch {
        const fallback = await caches.match(url.pathname);
        if (fallback) return fallback;
        throw new Error(`offline and ${url.pathname} is not cached`);
      }
    })());
    return;
  }

  // Fonts, icons and the compendium do not change except at release, and they
  // are the expensive ones. Serve them from cache and refresh behind the back.
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(request);
            if (fresh.ok) (await caches.open(VERSION)).put(request, fresh.clone());
          } catch { /* offline: keep what we have */ }
        })());
        return cached;
      }
      const response = await fetch(request);
      if (response.ok) (await caches.open(VERSION)).put(request, response.clone());
      return response;
    })());
    return;
  }

  // Everything else - all app source - is network-first.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        (await caches.open(VERSION)).put(request, response.clone());
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      // Navigation offline with nothing cached: serve the shell.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
