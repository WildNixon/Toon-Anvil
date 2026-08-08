/**
 * Toon Anvil shell: boot, mode routing, chrome.
 *
 * Modes are lazily imported so opening the app doesn't parse the DM screen or
 * the shop generator. Each mode module exports `render(container)` and may
 * export `title`.
 */

import { initDb, db, compendia, getDataSource, setDataSource } from './core/db.js';
import { getState, setState, subscribe, watch, esc, $ } from './core/store.js';
import { setContext } from './core/events.js';
import { derive } from './core/derive.js';

const MODES = [
  { id: 'build',     label: 'Build',     load: () => import('./modes/build/build.js') },
  { id: 'sheet',     label: 'Play',      load: () => import('./modes/sheet/sheet.js') },
  { id: 'combat',    label: 'Combat',    load: () => import('./modes/combat/combat.js') },
  { id: 'shop',      label: 'Shop',      load: () => import('./modes/shop/shop.js') },
  { id: 'rp',        label: 'Roleplay',  load: () => import('./modes/rp/rp.js') },
  { id: 'chronicle', label: 'Chronicle', load: () => import('./modes/chronicle/chronicle.js') },
  { id: 'dm',        label: 'DM',        load: () => import('./modes/dm/dm.js') },
  { id: 'homebrew',  label: 'Homebrew',  load: () => import('./homebrew/homebrew-ui.js') },
];

/* ------------------------------------------------------------------ */
/* derived character - recomputed whenever the character changes       */
/* ------------------------------------------------------------------ */

export function recompute() {
  const { character, compendium, homebrew } = getState();
  if (!character) return setState({ derived: null });
  const derived = derive(character, {
    classes: compendium.classes || [],
    species: compendium.species || [],
    backgrounds: compendium.backgrounds || [],
    feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {},
    homebrew: homebrew || [],
  });
  return setState({ derived });
}

/** Persist the active character and refresh its derived sheet. */
export async function saveCharacter(patch) {
  const { character } = getState();
  if (!character) return null;
  const edited = typeof patch === 'function'
    ? patch(structuredClone(character))
    : { ...character, ...patch };
  // Reconcile on every save, not just on load. Levelling up in Build is an
  // edit, and without this the character keeps its old current HP against its
  // new maximum - a level 5 fighter reading 10 of 34 and looking wounded when
  // it has never been hit.
  const next = reconcileHp(edited);
  await db.put('characters', next);
  setState({ character: next });
  recompute();
  const list = await db.list('characters');
  setState({ characters: list });
  return next;
}

/**
 * Bring a character's stored HP into line with its derived maximum.
 *
 * Max HP is derived from class, level and Constitution, but `current` is play
 * state and stays stored. Whenever the maximum MOVES - levelling up, taking a
 * Constitution boost, respeccing - the stored pair goes stale and has to be
 * reconciled:
 *
 *   at full before  -> at full after. Levelling from 1 to 5 must read 34 of
 *                      34, not 10 of 34. Anything else means every character
 *                      looks wounded the moment it levels, which is exactly
 *                      what happened before this ran on save as well as load.
 *   wounded before  -> still wounded. You do not heal by gaining a level.
 *
 * Deliberately NOT inside derive(): this is a write, and the same test there
 * would compare against a stale stored max, so a damaged character would read
 * as full and heal itself on every render.
 */
function reconcileHp(character, state = getState()) {
  const { compendium, homebrew } = state;
  if (!character?.classes?.length || !compendium?.classes) return character;
  const storedMax = Number(character.hp?.max || 0);
  const d = derive(character, {
    classes: compendium.classes || [], species: compendium.species || [],
    backgrounds: compendium.backgrounds || [], feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {}, homebrew: homebrew || [],
  });
  if (storedMax === d.hp.max) return character;

  const wasFull = character.hp?.current === undefined
    || Number(character.hp.current) >= storedMax;
  return {
    ...character,
    hp: {
      ...character.hp,
      max: d.hp.max,
      current: wasFull ? d.hp.max : Math.min(Number(character.hp.current), d.hp.max),
    },
  };
}

async function migrateHp(character) {
  const next = reconcileHp(character);
  if (next !== character) await db.put('characters', next);
  return next;
}

export async function selectCharacter(id) {
  if (!id) {
    setContext({ characterId: null });
    return setState({ characterId: null, character: null, derived: null });
  }
  const character = await migrateHp(await db.get('characters', id));
  setContext({ characterId: id, campaignId: character?.campaignId || null });
  setState({ characterId: id, character, campaignId: character?.campaignId || null });
  recompute();
  localStorage.setItem('toonanvil.lastCharacter', id);
  return character;
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

let currentMode = null;

async function renderMode() {
  const { mode } = getState();
  const view = $('#view');
  const entry = MODES.find((m) => m.id === mode) || MODES[0];
  if (currentMode === entry.id && view.dataset.rendered === entry.id) {
    // Already mounted; modes re-render themselves via their own subscriptions.
  }
  currentMode = entry.id;
  view.dataset.rendered = entry.id;
  view.innerHTML = '<div class="empty">Loading&hellip;</div>';
  try {
    const mod = await entry.load();
    view.innerHTML = '';
    await mod.render(view);
  } catch (err) {
    console.error(`[app] mode "${entry.id}" failed`, err);
    view.innerHTML = `<div class="panel accent rivets">
      <span class="lvl accent">Error</span>
      <h3>${esc(entry.label)} failed to load</h3>
      <p class="mono">${esc(err.message)}</p>
      <p class="muted">The rest of the app still works - switch modes above.</p>
    </div>`;
  }
  renderNav();
}

export function go(mode) {
  if (getState().mode === mode) return;
  setState({ mode });
  location.hash = `#${mode}`;
}

function renderNav() {
  const nav = $('#modes');
  const { mode } = getState();
  nav.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.setAttribute('aria-current', String(m.id === mode));
    b.addEventListener('click', () => go(m.id));
    nav.append(b);
  }
}

function renderWho() {
  const { character, derived, dataSource } = getState();
  const src = dataSource === 'server' ? 'shared' : 'this device';
  $('#who').innerHTML = character
    ? `<strong>${esc(character.name || 'Unnamed')}</strong>`
      + `${esc(describeClasses(character))} &middot; AC ${derived?.ac ?? '--'}`
      + ` &middot; ${esc(src)}`
    : `<strong>No character</strong>Storage: ${esc(src)}`;
}

function describeClasses(ch) {
  const parts = (ch.classes || []).map((c) => `${cap(c.class)} ${c.level}`);
  return parts.length ? parts.join(' / ') : 'Level 0';
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */

watch('toast', (state) => {
  const node = $('#toast');
  if (!state.toast) { node.hidden = true; return; }
  node.hidden = false;
  node.className = state.toast.kind;
  node.textContent = state.toast.message;
});

watch('character', renderWho);
watch('derived', renderWho);
watch('mode', renderMode);

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // ?storage=memory boots an ephemeral session: nothing is written to disk or
  // to the server, and everything is gone on reload. The UI test tier uses it
  // so that driving the real app cannot touch real characters or append to a
  // real chronicle. It is per-load and never stored as a preference.
  const params = new URLSearchParams(location.search);
  const prefer = params.get('storage') === 'memory' ? 'memory' : undefined;
  const adapter = await initDb({ prefer });
  setState({ dataSource: adapter.mode, ephemeral: prefer === 'memory' });

  // An ephemeral session that looks exactly like a real one is a trap - it is
  // how somebody builds a character for an hour and then loses it. Say so.
  if (prefer === 'memory') {
    const flag = document.createElement('div');
    flag.id = 'ephemeral-banner';
    flag.textContent = 'EPHEMERAL SESSION — nothing is saved, everything is '
      + 'lost on reload';
    flag.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;'
      + 'background:#9a6a12;color:#fff;font:700 11px/1.9 Consolas,monospace;'
      + 'letter-spacing:.14em;text-align:center;text-transform:uppercase';
    document.body.append(flag);
  }

  const compendium = await compendia(
    'classes', 'species', 'backgrounds', 'feats', 'spells',
    'equipment', 'conditions', '_meta',
  );
  // The mechanical overlay for SRD class features lives outside compendium/,
  // which srd_convert.py owns and overwrites on every run.
  compendium.srdEffects = await fetch('./data/srd-effects.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  setState({ compendium });

  const [characters, homebrew] = await Promise.all([
    db.list('characters'), db.list('homebrew'),
  ]);
  setState({ characters, homebrew, ready: true });

  const hash = location.hash.replace('#', '');
  const mode = MODES.some((m) => m.id === hash) ? hash : 'build';

  const last = localStorage.getItem('toonanvil.lastCharacter');
  if (last && characters.some((c) => c.id === last)) await selectCharacter(last);
  else if (characters.length) await selectCharacter(characters[0].id);

  setState({ mode });
  renderNav();
  renderWho();
  await renderMode();

  // Register the service worker last so a failure here never blocks boot.
  // file:// and the extension's own origin do not support it; that is fine,
  // they have other offline stories.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.info('[toon-anvil] offline cache ready', reg.scope))
      .catch((err) => console.warn('[toon-anvil] service worker not registered', err));
  }

  console.info(
    `[toon-anvil] ready - storage: ${adapter.mode} (${adapter.label}), `
    + `${characters.length} characters, SRD ${compendium._meta?.srdVersion}`,
  );
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (MODES.some((m) => m.id === hash)) setState({ mode: hash });
});

// Surface real failures instead of a blank page.
window.addEventListener('error', (e) => console.error('[toon-anvil]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[toon-anvil]', e.reason));

boot().catch((err) => {
  console.error('[toon-anvil] boot failed', err);
  $('#view').innerHTML = `<div class="panel accent rivets">
    <span class="lvl accent">Boot failure</span>
    <h3>Toon Anvil could not start</h3>
    <p class="mono">${esc(err.message)}</p>
    <p class="muted">If the compendium is missing, run
      <code>python tools/srd_convert.py</code>.</p>
  </div>`;
});

export { MODES };
