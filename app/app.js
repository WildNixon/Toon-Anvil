/**
 * Toon Anvil shell: boot, mode routing, chrome.
 *
 * Modes are lazily imported so opening the app doesn't parse the DM screen or
 * the shop generator. Each mode module exports `render(container)` and may
 * export `title`.
 */

import { initDb, db, compendia, getDataSource, setDataSource, openRealStore }
  from './core/db.js';
import { getState, setState, subscribe, watch, esc, el, $, toast } from './core/store.js';
import { setContext, subscribe as onEvent } from './core/events.js';
import { derive } from './core/derive.js';
import * as session from './core/session.js';
import * as live from './core/live.js';
import * as theme from './ui/theme.js';

/**
 * TWO SHELLS. `shell` decides which app a mode belongs to, and the seat
 * decides which shell exists - the DM's app is the captain's screens and
 * nothing else, the player's app is about what they control. The seat
 * plaque in the top bar is the switch (solo) and the lock (at a table).
 * `tableOnly` / `soloOnly` refine within a shell; the gear serves both.
 *
 * This is navigation, not security. A player who types a hash reaches
 * nothing the server would not refuse anyway.
 */
// Each `blurb` is the one sentence under the screen's name - what it is and
// what it is for, in plain words. RULES: no digits (the phone gym counts
// numeric tokens on screen) and nothing that needs updating when a feature
// lands, or fourteen sentences become fourteen small lies.
const MODES = [
  { id: 'sheet',     label: 'Play',      shell: 'player', group: 'Your Hero', ribbon: true,
    blurb: 'Your character in play: roll checks, cast spells, take damage, and rest.',
    load: () => import('./modes/sheet/sheet.js') },
  { id: 'build',     label: 'Build',     shell: 'player', group: 'Your Hero', ribbon: true,
    blurb: 'Make and grow characters: abilities, class, species, background, and gear.',
    load: () => import('./modes/build/build.js') },
  { id: 'combat',    label: 'Combat',    shell: 'player', group: 'Adventure', ribbon: true,
    // The solo tracker. At a table the DM's runner IS the fight; a second,
    // unsynced initiative list is clutter that disagrees with the real one.
    soloOnly: true,
    blurb: 'A solo fight tracker: line up combatants, roll initiative, and keep every hit point straight.',
    load: () => import('./modes/combat/combat.js') },
  { id: 'rp',        label: 'Roleplay',  shell: 'player', group: 'Adventure', ribbon: true,
    blurb: 'Log the story as it happens: promises made, people met, and moments worth keeping.',
    load: () => import('./modes/rp/rp.js') },
  { id: 'shop',      label: 'Market',    shell: 'player', group: 'Adventure', ribbon: true,
    blurb: 'Generate shops, browse their stock, buy kit, and sell your loot.',
    load: () => import('./modes/shop/shop.js') },
  { id: 'chronicle', label: 'Chronicle', shell: 'player', group: 'Adventure', ribbon: true,
    blurb: 'The full record of your adventures: every roll, purchase, and story beat, kept by day.',
    load: () => import('./modes/chronicle/chronicle.js') },
  { id: 'table',     label: 'Party',     shell: 'player', group: 'Adventure', tableOnly: true, ribbon: true,
    blurb: 'Everyone at the table: who is playing, how the party is doing, and the world you are in.',
    load: () => import('./modes/table/table.js') },

  // The DM shell: an entirely different app. Same solo as at a table.
  { id: 'dm-stage',  label: 'Stage', shell: 'dm', group: 'The Session',
    blurb: 'Run the session live: the fight, the party board, and the levers only you hold.',
    load: () => import('./modes/dm/stage-mode.js') },
  { id: 'dm-deck',   label: 'Deck',  shell: 'dm', group: 'The Session',
    blurb: 'The campaign dashboard: the calendar, the sky, regions, factions, clocks, and the map.',
    load: () => import('./modes/dm/deck.js') },
  { id: 'dm-world',  label: 'World', shell: 'dm', group: 'The Campaign',
    blurb: 'Prep and reference: the bestiary, encounter building, treasure, and the rules.',
    load: () => import('./modes/dm/world-mode.js') },
  { id: 'dm-story',  label: 'Story', shell: 'dm', group: 'The Campaign',
    blurb: 'How the campaign is going: pacing, spotlight, and what the record says between sessions.',
    load: () => import('./modes/dm/story-mode.js') },
  { id: 'dm-setup',  label: 'Setup', shell: 'dm', group: 'The Campaign',
    blurb: 'Get ready to play: forge a ready party, open the forge, and accept homebrew and books.',
    load: () => import('./modes/dm/setup-mode.js') },

  // Where a session starts and where everyone waits. Belongs to BOTH shells,
  // because hosting and joining are one room seen from two sides. Listed
  // LAST on purpose: the boot mode falls back to visibleModes()[0], and
  // putting the lobby earlier would quietly move the DM's home screen.
  { id: 'lobby',     label: 'Lobby',     always: true,    group: 'The Table',
    blurb: 'Where a session starts: set the campaign, host the table, and watch everyone arrive.',
    load: () => import('./modes/lobby/lobby.js') },

  // No shell: the gear serves both.
  { id: 'settings',  label: 'Settings',  gear: true,
    blurb: 'This device: theme, seat, where your work is kept, and the optional connectors.',
    load: () => import('./modes/settings/settings.js') },
];

/** Which modes belong in the nav for whoever is using this browser. */
function visibleModes() {
  return session.navFor({
    tableOpen: session.isOpen(),
    seat: session.isDm() ? 'dm' : 'player',
    forgeOpen: session.forgeOpen(),
    hasGrant: session.hasAnyGrant(),
  }, MODES);
}

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

/**
 * Damage or heal the active character. Negative is damage.
 *
 * Shell-level on purpose: the sheet's Damage button and the hero ribbon's
 * quick adjust both call THIS, so there is exactly one rule for what 7 damage
 * does - temp HP spent first, the floor at 0, concentration prompted. It runs
 * through the same engine the simulator uses.
 */
export async function adjustHp(delta) {
  const { derived } = getState();
  if (!delta || !derived) return null;
  const { applyDamage } = await import('./core/engine.js');
  const res = applyDamage(
    { hp: derived.hp, hpMax: derived.hp.max, temp: derived.hp.temp,
      concentrating: derived.concentration },
    delta, { name: derived.name },
  );
  await saveCharacter((c) => {
    c.hp = { ...c.hp, current: res.hp, temp: res.temp };
    return c;
  });
  const { log } = await import('./core/events.js');
  for (const ev of res.events) await log(ev.type, ev.payload);
  if (res.concentrationDc) {
    const { toast } = await import('./core/store.js');
    toast(`Concentration save: DC ${res.concentrationDc}`, 'warn');
  }
  return res;
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
  try {
    await db.put('characters', next);
  } catch (err) {
    // The server said no - the level gate, a frozen field, somebody else's
    // sheet. Its reason is written for a person; show it and keep the
    // stored state untouched rather than pretending the save happened.
    const { toast } = await import('./core/store.js');
    toast(String(err.message || err), 'bad');
    return character;
  }
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

/**
 * Bring an old HP shape up to date - and never die trying.
 *
 * This runs during boot, for a cosmetic normalisation nobody asked for. A
 * player arriving at an open table without a join code is a READ-ONLY
 * visitor: the server correctly refuses their write, and until this catch
 * existed that 401 propagated out of boot() and painted a dead "could not
 * start" panel instead of the join gate. The thing that would have let them
 * in was the thing that failed to render. (BOOT-1.)
 *
 * Only a REFUSAL is swallowed. A refused write is a fact about who you are,
 * not a fault; reconcileHp is idempotent, so the record migrates on the next
 * boot after you join. Any other failure still throws, because a broken
 * server must not be quietly absorbed by a migration.
 */
async function migrateHp(character) {
  const next = reconcileHp(character);
  if (next !== character) {
    try {
      await db.put('characters', next);
    } catch (err) {
      if (!err?.refused) throw err;
    }
  }
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
let renderSeq = 0;

async function renderMode() {
  // Renders await module imports, and two calls can be in flight when the
  // seat resolves mid-boot. Only the NEWEST call may paint - a stale async
  // render finishing last must not win the screen.
  const seq = ++renderSeq;
  const { mode } = getState();
  const view = $('#view');
  // A hash can point at a mode this browser should not be on - a player who
  // joined while sitting on the DM screen, or one who typed #dm. Fall back to
  // the first mode they DO have rather than rendering a screen full of
  // controls the server will refuse.
  const allowed = visibleModes();
  let entry = allowed.find((m) => m.id === mode);
  if (!entry) {
    entry = allowed[0] || MODES[0];
    setState({ mode: entry.id });
    if (location.hash.replace('#', '') !== entry.id) location.hash = `#${entry.id}`;
  }
  if (currentMode === entry.id && view.dataset.rendered === entry.id) {
    // Already mounted; modes re-render themselves via their own subscriptions.
  }
  currentMode = entry.id;
  view.dataset.rendered = entry.id;
  // The screen's own nameplate: the nav label again, plus one sentence on
  // what the screen is for. Painted OUTSIDE <main> on purpose - modes wipe
  // and repaint their container freely, and the gym's text probes read main,
  // so the header must be neither casualty nor contaminant. Dumb text only:
  // no controls, ever.
  const head = $('#modehead');
  if (head) {
    head.hidden = false;
    head.innerHTML = `<div class="head"><h2>${esc(entry.label)}</h2>`
      + '<div class="bar"></div></div>'
      + `<p class="lens-sub">${esc(entry.blurb || '')}</p>`;
  }
  document.title = `${entry.label} · Toon Anvil`;
  view.innerHTML = '<div class="empty">Loading&hellip;</div>';
  try {
    const mod = await entry.load();
    if (seq !== renderSeq) return;
    view.innerHTML = '';
    await mod.render(view);
    if (seq !== renderSeq) return;
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

/**
 * Rebuild everything above <main> after something changed which modes exist -
 * a seat flip in Settings, joining a table. If the mode on screen just
 * stopped existing for this browser, renderMode's own guard bounces to one
 * that does.
 */
/**
 * Say it when the server has gone.
 *
 * The failure this replaces: with the server stopped the app looked entirely
 * healthy - full nav, full lobby, every button present - and pressing one did
 * nothing at all. No error, no toast, no change. From the outside that is
 * indistinguishable from "the app is broken", which is exactly what it gets
 * reported as.
 *
 * The banner names the fix, because "connection lost" tells somebody sitting
 * at their own machine nothing they can act on.
 */
function renderServerDown(reachable) {
  const box = $('#serverdown');
  if (!box) return;
  box.hidden = Boolean(reachable);
  if (reachable) return;
  box.innerHTML = '<strong>The server stopped</strong>'
    + '<span>Nothing will save until it is back. Start it again with '
    + '<code>python run.py</code> in the Toon Anvil folder, then reload.</span>';
}

export async function refreshChrome() {
  renderNav();
  renderWho();
  if (!visibleModes().some((m) => m.id === getState().mode)) await renderMode();
}

// A cog, drawn inline so it inherits currentColor and ships no asset.
const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/>'
  + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1'
  + 'M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>';

/**
 * The seat plaque: which app this is, always on screen.
 *
 * Solo it IS the switch - one click flips the whole shell. At a table it is
 * a lock, because the table decides the seat. Lives OUTSIDE nav#modes on
 * purpose (the tests sweep nav labels), and its text is never the exact
 * string 'DM' (a nav label the tests assert about).
 */
function renderSeatPlaque() {
  const host = $('#seat');
  if (!host) return;
  const dm = session.isDm();
  const locked = session.isOpen();
  host.dataset.seat = dm ? 'dm' : 'player';
  host.textContent = dm ? 'Dungeon Master' : 'Hero';
  host.title = locked
    ? 'A table is open - your seat there decides'
    : `Switch to the ${dm ? 'Hero' : "Dungeon Master's"} seat`;
  host.setAttribute('aria-disabled', String(locked));
  host.onclick = locked ? null : async () => {
    session.setLocalRole(dm ? 'player' : 'dm');
    applySeatAttr();
    await refreshChrome();
    // A shell switch is a mode switch too: the mode you were on does not
    // exist over here. refreshChrome's visibility re-check handles it.
  };
  applySeatAttr();
}

/** The whole chrome tints off this attribute - crimson command vs oak. */
function applySeatAttr() {
  document.documentElement.dataset.seat = session.isDm() ? 'dm' : 'player';
}

function renderNav() {
  renderSeatPlaque();
  const nav = $('#modes');
  const { mode } = getState();
  nav.innerHTML = '';

  const makeButton = (m) => {
    const b = document.createElement('button');
    if (m.gear) {
      b.className = 'gearbtn';
      // The word stays in textContent (visually hidden) so the button still
      // answers to "Settings" - for screen readers and for the UI tests,
      // which find buttons by their text.
      b.innerHTML = `${GEAR_SVG}<span class="vh">Settings</span>`;
      b.title = 'Settings';
    } else {
      b.textContent = m.label;
    }
    b.setAttribute('aria-current', String(m.id === mode));
    b.addEventListener('click', () => go(m.id));
    return b;
  };

  // Group labels are spans, never buttons - they must not be clickable and
  // must never collide with a button-by-label lookup.
  let currentGroup = null;
  let groupBox = null;
  for (const m of visibleModes()) {
    if (m.gear) continue;
    if (m.group !== currentGroup) {
      currentGroup = m.group;
      groupBox = document.createElement('div');
      groupBox.className = 'navgroup';
      const label = document.createElement('span');
      label.className = 'navgroup-label';
      label.textContent = m.group;
      groupBox.append(label);
      nav.append(groupBox);
    }
    groupBox.append(makeButton(m));
  }
  const gear = MODES.find((m) => m.gear);
  if (gear) nav.append(makeButton(gear));
}

// The corner readout became the hero ribbon (ui/ribbon.js), mounted at boot.
// This stays as the one call site the rest of the shell knows about.
let ribbonModule = null;

function renderWho() { ribbonModule?.refresh(); }

async function mountRibbon() {
  ribbonModule = await import('./ui/ribbon.js');
  ribbonModule.mount($('#ribbon'), {
    ribbonModes: MODES.filter((m) => m.ribbon).map((m) => m.id),
    describeClasses,
    adjustHp,
    selectCharacter,
    go,
    startSandbox,
    // A ribbon heal repaints only the modes that display vitals; anything
    // else keeps its half-typed state.
    rerenderVitals: () => {
      if (['sheet', 'combat', 'table'].includes(getState().mode)) renderMode();
    },
    rerenderMode: () => renderMode(),
  });
}

function describeClasses(ch) {
  const parts = (ch.classes || []).map((c) => `${cap(c.class)} ${c.level}`);
  return parts.length ? parts.join(' / ') : 'Level 0';
}

const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

/* ------------------------------------------------------------------ */
/* live updates                                                        */
/* ------------------------------------------------------------------ */

/**
 * Re-read what somebody else changed.
 *
 * The stream says only WHAT changed, so this re-fetches from the store rather
 * than trusting a pushed copy - one source of truth, and no chance of the
 * screen disagreeing with the file on disk.
 *
 * Modes render once and do not watch the store, so refreshing state alone
 * changes nothing on screen - the sheet went on showing the old hit points.
 * The screen is therefore re-rendered explicitly, but ONLY when the change
 * touches the character being looked at. A full re-render on every change
 * would throw away half-typed input elsewhere.
 *
 * Our own writes never reach here: live.js drops them by client id, so typing
 * in Build does not re-render Build underneath the cursor.
 */
async function watchTheTable() {
  await live.start();

  // My own snapshot of "was this browser seated at an open table", for the
  // close signal below. A snapshot rather than reading session before the
  // refresh, because mode subscriptions share the session cache and whichever
  // callback refreshes first would blind the others to what just changed.
  let seat = { open: session.isOpen(), seated: Boolean(session.me()) };

  live.subscribe(['characters', 'table'], async ({ changes, gap }) => {
    const mine = getState().characterId;
    const touchedMe = gap || changes.some(
      (c) => c.kind === 'characters' && c.id === mine,
    );
    const tableChanged = gap || changes.some((c) => c.kind === 'table');

    // The roster changes when anybody's character does.
    setState({ characters: await db.list('characters') });

    if (tableChanged) {
      // Joining or leaving changes which modes exist, so the nav is rebuilt
      // and the current mode re-checked - a player who joined while on the DM
      // screen should not be left sitting on it.
      await session.refresh();

      // The one thing a closing table owes every seat it strands: a word.
      // Found at a real table: a player parked on her sheet learned nothing
      // when the DM closed - the rail just quietly emptied. Only OTHER
      // people's closes arrive here (live.js drops this client's own writes),
      // so the DM who pressed Close keeps their button's local toast and
      // never hears this one.
      const open = session.isOpen();
      if (seat.open && seat.seated && !open) {
        toast('The table was closed', 'warn');
      }
      seat = { open, seated: Boolean(session.me()) };
      renderNav();
      if (!visibleModes().some((m) => m.id === getState().mode)) await renderMode();
      // A table change can be a grant or the forge - the sheet's banner and
      // Build's locks read them, so the visible mode repaints. Rare events;
      // nothing worth protecting is typed on those screens.
      else if (['sheet', 'build'].includes(getState().mode)) await renderMode();
      // And it can be the table opening or closing around a browser that
      // never joined - the gate appears and disappears live.
      await mountGates();
    }

    if (touchedMe && mine) {
      const fresh = await db.get('characters', mine);
      if (fresh) {
        setState({ character: fresh });
        recompute();
        await renderMode();
      }
    }
    renderWho();
  });
}

/**
 * Mount whichever body-level overlay this browser's situation calls for.
 *
 * Called at boot and again on every table change, so a table opening while
 * somebody browses solo invites them in live, and a table closing takes the
 * gate away again.
 */
// A join code carried in from a ?code= link, held until the join gate mounts
// and consumed by the first mount. Module state, not store state: it is a
// boot-time fact about how this tab was opened, not something to render.
let deepLinkCode = null;

async function mountGates() {
  const { ephemeral } = getState();
  const gate = await import('./ui/joingate.js');
  const welcome = await import('./ui/welcome.js');

  if (!ephemeral && session.isOpen() && session.needsJoin()) {
    welcome.unmount();
    gate.mount({
      prefillCode: deepLinkCode,
      onDone: async (picked) => {
        await session.refresh();
        await refreshChrome();
        if (picked === 'new') go('build');
        else if (picked) {
          await selectCharacter(picked);
          // Say where to go rather than inheriting whatever the boot mode
          // happened to be. This used to rely on the player shell's first
          // mode already being the sheet, so adding the lobby silently left
          // a player who had just picked a character sitting in the queue
          // looking at it. You chose someone - here they are.
          go('sheet');
        }
        await renderMode();
      },
    });
    deepLinkCode = null;
    return;
  }
  // Only a CLOSED table removes a mounted gate. Joining flips needsJoin
  // mid-conversation - the join itself bumps the table, this function runs,
  // and tearing the overlay down here would rip the claim step out from
  // under the person using it. The gate unmounts itself when they finish.
  if (!session.isOpen()) gate.unmount();

  if (session.needsSeat()) {
    welcome.mount({ onChoose: () => refreshChrome() });
  } else {
    welcome.unmount();
  }
}

/* ------------------------------------------------------------------ */
/* sandbox - a session that keeps nothing                              */
/* ------------------------------------------------------------------ */

/**
 * Try things without saving them.
 *
 * The whole app runs against an in-memory store: characters, homebrew, NPCs
 * and the event log all live for exactly as long as the tab does. It exists so
 * you can take a subclass apart, roll a dozen characters, or hand the app to
 * somebody else without any of it reaching your real library.
 *
 * Two things make it safe rather than a trap:
 *   - the bar is always visible and says plainly that nothing is being saved;
 *   - there is a way OUT that does not silently throw the work away. "Keep
 *     what I made" downloads everything as JSON, which Build's Import JSON
 *     reads straight back. A sandbox you can only lose things in would be
 *     worse than no sandbox.
 */
export function startSandbox() {
  const url = new URL(location.href);
  url.searchParams.set('storage', 'memory');
  location.href = url.toString();
}

function leaveSandbox(count) {
  if (count > 0) {
    const ok = window.confirm(
      `Leaving the sandbox discards ${count} unsaved item${count === 1 ? '' : 's'}.\n\n`
      + 'Use "Keep what I made" first if you want to bring any of it with you.\n\n'
      + 'Leave anyway?',
    );
    if (!ok) return;
  }
  const url = new URL(location.href);
  url.searchParams.delete('storage');
  // Skip the beforeunload guard: the user has just answered this exact
  // question, and asking twice teaches people to click through warnings.
  sandboxLeaving = true;
  location.href = url.toString();
}

const SANDBOX_KINDS = ['characters', 'homebrew', 'npcs', 'shops', 'campaigns'];

/** Everything made in this session, by kind. */
async function sandboxContents() {
  const out = {};
  let total = 0;
  for (const kind of SANDBOX_KINDS) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.list(kind).catch(() => []);
    if (rows.length) { out[kind] = rows; total += rows.length; }
  }
  return { out, total };
}

/**
 * Write this session's work into the real library.
 *
 * Two things this must never do, because the whole point of a sandbox is that
 * it cannot hurt what you already have:
 *
 *   - overwrite an existing record. Sandbox ids are generated the same way
 *     real ones are, so a collision is possible; anything that clashes gets a
 *     fresh id and is written ALONGSIDE the original rather than over it.
 *   - happen without being asked. It is a write to real data initiated from a
 *     session whose entire promise was that it writes nothing, so it confirms
 *     first and says exactly what is about to land.
 */
async function keepSandbox() {
  const { out, total } = await sandboxContents();
  if (!total) return setState({ toast: { message: 'Nothing made yet', kind: 'warn' } });

  const summary = Object.entries(out)
    .map(([kind, rows]) => `${rows.length} ${kind}`).join(', ');
  const ok = window.confirm(
    `Save to your library?\n\n${summary}\n\n`
    + 'These are copied into your real saved data. Nothing already there is '
    + 'replaced - anything with a clashing id is saved as a copy.',
  );
  if (!ok) return null;

  let real;
  try {
    real = await openRealStore();
  } catch (err) {
    return setState({
      toast: { message: `Could not reach your library: ${err.message}`, kind: 'bad' },
    });
  }

  let written = 0;
  let renamed = 0;
  for (const [kind, rows] of Object.entries(out)) {
    // eslint-disable-next-line no-await-in-loop
    const existing = new Set((await real.list(kind).catch(() => [])).map((r) => r.id));
    for (const row of rows) {
      const record = { ...row };
      if (existing.has(record.id)) {
        record.id = `${record.id}-copy-${Math.random().toString(36).slice(2, 7)}`;
        record.name = `${record.name || 'Untitled'} (copy)`;
        renamed += 1;
      }
      existing.add(record.id);
      // eslint-disable-next-line no-await-in-loop
      await real.put(kind, record);
      written += 1;
    }
  }

  sandboxKept = true;
  await refreshSandboxBar();
  return setState({
    toast: {
      message: `Saved ${written} item(s) to your library`
        + (renamed ? ` (${renamed} kept as a copy to avoid overwriting)` : ''),
      kind: 'ok',
    },
  });
}

/** The same work as a file, for moving it to another machine. */
async function downloadSandbox() {
  const { out, total } = await sandboxContents();
  if (!total) return setState({ toast: { message: 'Nothing made yet', kind: 'warn' } });
  const bundle = {
    kind: 'toon-anvil-sandbox', exported: new Date().toISOString(), ...out,
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `toon-anvil-sandbox-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  sandboxKept = true;
  await refreshSandboxBar();
  return setState({
    toast: { message: `Downloaded ${total} item(s)`, kind: 'ok' },
  });
}

let sandboxKept = false;
let sandboxLeaving = false;

/** How much would be lost right now. */
async function sandboxCount() {
  let n = 0;
  for (const kind of ['characters', 'homebrew', 'npcs', 'shops', 'campaigns']) {
    // eslint-disable-next-line no-await-in-loop
    n += (await db.list(kind).catch(() => [])).length;
  }
  return n;
}

async function refreshSandboxBar() {
  const bar = $('#sandbox-bar');
  if (!bar) return;
  const n = await sandboxCount();
  bar.querySelector('.detail').textContent = n
    ? `${n} item${n === 1 ? '' : 's'} made here. Nothing is written to disk — `
      + 'it all disappears when you close or reload this tab.'
    : 'Nothing is written to disk. Build, break and throw away as much as you like.';
  bar.querySelector('.keep').disabled = n === 0;
  bar.querySelector('.keep').textContent = sandboxKept && n
    ? 'Save again' : 'Save to my library';
  const dl = bar.querySelector('.download');
  if (dl) dl.disabled = n === 0;
  bar.dataset.count = String(n);
}

function mountSandboxBar() {
  document.body.classList.add('sandbox');
  const bar = document.createElement('div');
  bar.id = 'sandbox-bar';
  bar.className = 'sandbox-bar';
  bar.innerHTML = '<span class="label">Sandbox</span>'
    + '<span class="detail"></span>';

  const keep = document.createElement('button');
  keep.className = 'keep';
  keep.textContent = 'Save to my library';
  keep.addEventListener('click', keepSandbox);

  // Kept alongside the direct save because a file is still the only way to
  // move work to another machine, and removing a working capability to add
  // one is not an upgrade.
  const dl = document.createElement('button');
  dl.className = 'download';
  dl.textContent = 'Download';
  dl.title = 'Save as a JSON file instead - Build\'s Import JSON reads it back';
  dl.addEventListener('click', downloadSandbox);

  const leave = document.createElement('button');
  leave.textContent = 'Leave sandbox';
  leave.addEventListener('click',
    () => leaveSandbox(Number(bar.dataset.count || 0)));

  bar.append(keep, dl, leave);
  document.body.append(bar);

  // Keep the count honest as things are made, without polling hard.
  subscribe(() => { refreshSandboxBar(); });
  refreshSandboxBar();

  // Closing the tab is the other way to lose everything, and the browser will
  // not let us explain why - but it will ask.
  window.addEventListener('beforeunload', (e) => {
    if (sandboxLeaving || sandboxKept) return;
    if (Number(bar.dataset.count || 0) === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

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

// The ribbon watches the store itself; nothing else needs these hooks now.
watch('mode', renderMode);

/* ------------------------------------------------------------------ */
/* the level-up moment                                                 */
/* ------------------------------------------------------------------ */

// level_up finally has a listener. Same-tab: the player who took the level
// sees the moment. The overlay's backdrop passes every click through
// (pointer-events: none) - celebration must never block play, or the level-
// up flow's own next step. Only the card itself is tappable, to dismiss.
onEvent((ev) => {
  if (ev.type !== 'level_up') return;
  document.querySelector('.levelup-overlay')?.remove();
  const wrap = el('div', { class: 'levelup-overlay', role: 'status' });
  const card = el('div', { class: 'levelup-card', onClick: () => wrap.remove() });
  card.append(el('div', { class: 'lu-burst' },
    `Level ${ev.payload?.level ?? '?'}!`));
  const gained = (getState().derived?.features || [])
    .filter((f) => Number(f.level) === Number(ev.payload?.level))
    .map((f) => f.name).filter(Boolean).slice(0, 6);
  if (gained.length) {
    card.append(el('div', { class: 'lu-features' }, gained.join(' · ')));
  }
  card.append(el('div', { class: 'welcome-fine' }, 'tap to dismiss'));
  wrap.append(card);
  document.body.append(wrap);
  setTimeout(() => wrap.remove(), 7000);
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // Theme first: everything below renders under it.
  theme.init();

  // ?storage=memory boots an ephemeral session: nothing is written to disk or
  // to the server, and everything is gone on reload. The UI test tier uses it
  // so that driving the real app cannot touch real characters or append to a
  // real chronicle. It is per-load and never stored as a preference.
  const params = new URLSearchParams(location.search);
  const prefer = params.get('storage') === 'memory' ? 'memory' : undefined;

  // ?code= arrives from the join link/QR on the DM's Setup screen. Remember
  // it for the join gate, then scrub it from the address bar straight away
  // so a reload or a bookmark does not carry a stale code. Only the CODE
  // ever rides in a URL - never a token.
  if (params.has('code')) {
    deepLinkCode = (params.get('code') || '').trim();
    // The lobby's own join face reads this stash, so a player who dismisses
    // the overlay gate ("Not now") has not thrown away the code they
    // arrived with. sessionStorage on purpose: it dies with the tab, like
    // the code it carries dies with the table.
    try { sessionStorage.setItem('toonanvil.joincode', deepLinkCode); }
    catch { /* storage denied - the overlay prefill still works */ }
    params.delete('code');
    const qs = params.toString();
    history.replaceState({}, '',
      location.pathname + (qs ? `?${qs}` : '') + location.hash);
  }

  const adapter = await initDb({ prefer });
  setState({ dataSource: adapter.mode, ephemeral: prefer === 'memory' });

  if (prefer === 'memory') mountSandboxBar();

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


  // Who am I at this table? With none open the answer is "the only person
  // here". This must land BEFORE the boot mode is chosen: which shell exists
  // depends on the seat, and the seat is not knowable from stale local state
  // - a device remembered as DM booting into an open table is a player.
  //
  // It also lands before selectCharacter, which WRITES: the app used to
  // decide to save an HP migration six lines before it knew whether it was
  // even allowed to. Working out who you are costs one request and is the
  // honest order. recompute() reads only the compendium and homebrew, so
  // selecting a character does not need the seat - the dependency only ever
  // ran the other way.
  await session.refresh();

  const last = localStorage.getItem('toonanvil.lastCharacter');
  if (last && characters.some((c) => c.id === last)) await selectCharacter(last);
  else if (characters.length) await selectCharacter(characters[0].id);

  // Legacy hash: the DM screen used to be one mode with lens tabs.
  const rawHash = location.hash.replace('#', '');
  const hash = rawHash === 'dm' ? 'dm-stage' : rawHash;
  // A table that is open but not started means everyone is still gathering,
  // and the lobby is where gathering happens - so that is where a boot lands
  // rather than dropping someone onto a character sheet with no sense that
  // anyone else is there. An explicit hash still wins: somebody who
  // bookmarked their sheet gets their sheet.
  const gathering = session.isOpen() && !session.started();
  const mode = visibleModes().some((m) => m.id === hash)
    ? hash
    : gathering ? 'lobby'
      : (visibleModes()[0]?.id || 'build');
  setState({ mode });

  // Watch BEFORE anything renders. The watcher baselines on the current
  // revision the moment it starts; putting it after the first paint left a
  // window where a change landing mid-boot - a forge closing, a grant - was
  // never delivered, because the baseline was taken after it. A screen that
  // exists must already be listening.
  await watchTheTable();

  // One watcher for the whole shell: the poll already knew the server had
  // gone, it simply never said so.
  renderServerDown(live.serverReachable());
  live.onReachChange(renderServerDown);

  renderNav();
  await mountRibbon();
  await renderMode();

  // Overlays, in rank order. A table being open outranks the seat question:
  // the table decides the seat, so asking "player or DM?" under a join gate
  // would be noise. Neither appears in a sandbox - its whole point is being
  // free of ceremony.
  await mountGates();

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
  if (visibleModes().some((m) => m.id === hash)) setState({ mode: hash });
});

// Surface real failures instead of a blank page.
window.addEventListener('error', (e) => console.error('[toon-anvil]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[toon-anvil]', e.reason));

/**
 * A locked door and a broken one need different voices.
 *
 * Anything this browser is REFUSED during boot means "you have no seat
 * here yet", and the join gate already knows how to say that. Painting a
 * dead panel instead strands the visitor with no way forward - the control
 * that would let them in is the one that failed to render. So a refusal
 * tries the gate first, and only a genuine fault gets the panel.
 *
 * migrateHp already swallows the specific refusal that caused BOOT-1; this
 * is the general case, so the next write added to boot cannot resurrect it.
 */
boot().catch(async (err) => {
  console.error('[toon-anvil] boot failed', err);
  if (err?.refused) {
    try {
      await session.refresh();
      if (session.isOpen() && session.needsJoin()) {
        await mountGates();
        renderNav();
        renderWho();
        return;
      }
    } catch (gateErr) {
      // The gate could not be raised either - fall through and say so
      // plainly rather than leaving a blank page behind a caught error.
      console.error('[toon-anvil] the join gate could not be raised', gateErr);
    }
  }
  $('#view').innerHTML = `<div class="panel accent rivets">
    <span class="lvl accent">Boot failure</span>
    <h3>Toon Anvil could not start</h3>
    <p class="mono">${esc(err.message)}</p>
    <p class="muted">If the compendium is missing, run
      <code>python tools/srd_convert.py</code>.</p>
  </div>`;
});

export { MODES };
