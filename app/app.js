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
  const next = typeof patch === 'function'
    ? patch(structuredClone(character))
    : { ...character, ...patch };
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
 * Max HP became derived from class, level and Constitution; before that it was
 * stored and stuck at 10 forever. A character saved under the old scheme has a
 * stale hp.max, and if it was at full health it must stay at full health
 * rather than looking like it has taken 24 points of damage.
 *
 * This runs ONCE, when the character is loaded, because it is a write. The
 * same check inside derive() would be wrong: after real damage the stored max
 * is stale, so "current >= storedMax" reads as full and the character heals
 * itself on every render.
 */
async function migrateHp(character) {
  const { compendium, homebrew } = getState();
  if (!character?.classes?.length) return character;
  const storedMax = Number(character.hp?.max || 0);
  const d = derive(character, {
    classes: compendium.classes || [], species: compendium.species || [],
    backgrounds: compendium.backgrounds || [], feats: compendium.feats || [],
    srdEffects: compendium.srdEffects || {}, homebrew: homebrew || [],
  });
  if (storedMax === d.hp.max) return character;

  const wasFull = character.hp?.current === undefined
    || Number(character.hp.current) >= storedMax;
  const next = {
    ...character,
    hp: {
      ...character.hp,
      max: d.hp.max,
      current: wasFull ? d.hp.max : Math.min(Number(character.hp.current), d.hp.max),
    },
  };
  await db.put('characters', next);
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
  const adapter = await initDb();
  setState({ dataSource: adapter.mode });

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
