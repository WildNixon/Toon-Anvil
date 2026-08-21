/**
 * The hero ribbon - your character, on every screen that is about them.
 *
 * A sticky strip under the top bar: name, class, an HP bar with quick
 * damage/heal, AC, conditions, and a switcher so changing characters stops
 * being a trip to Build. It replaces the old text-only corner readout.
 *
 * Two deliberate quiet rules:
 *
 *   - The adjust buttons are "−" and "+" with aria-labels, NEVER the words
 *     Damage/Heal. The UI tests find buttons by their visible text and the
 *     ribbon sits before <main> in the document; a ribbon button named
 *     "Damage" would be found first and the tests would drive the wrong one.
 *     Condition chips are spans for the same reason.
 *
 *   - Damage here goes through the SAME shell adjustHp as the sheet's Damage
 *     button, so the two can never disagree about what 7 damage does.
 */

import { getState, watch, el } from '../core/store.js';
import { soundButton } from './soundtoggle.js';

let host = null;
let deps = null;

/** Which modes show the ribbon - passed in from the shell's MODES table. */
let ribbonModes = new Set();

export function mount(hostEl, dependencies) {
  host = hostEl;
  deps = dependencies;
  ribbonModes = new Set(dependencies.ribbonModes || []);
  for (const key of ['character', 'derived', 'characters', 'mode', 'dataSource']) {
    watch(key, render);
  }
  render();
}

export function refresh() { render(); }

function render() {
  if (!host) return;
  const { character, derived, characters, mode, dataSource, ephemeral } = getState();

  if (!ribbonModes.has(mode)) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = '';

  const src = ephemeral ? 'sandbox'
    : dataSource === 'server' ? 'shared' : 'this device';

  /* -------- identity (keeps the #who id: tests and tools read it) ---- */
  const who = el('div', { class: 'rb-who', id: 'who' });
  if (character) {
    who.append(el('strong', {}, character.name || 'Unnamed'));
    who.append(el('span', { class: 'rb-line' },
      `${deps.describeClasses(character)} · ${src}`));
  } else {
    who.append(el('strong', {}, 'No character'));
    who.append(el('span', { class: 'rb-line' }, `Storage: ${src}`));
  }
  host.append(who);

  if (!character || !derived) {
    host.append(el('button', {
      class: 'rb-ac', style: 'cursor:pointer',
      onClick: () => deps.go('build'),
    }, 'Create a character'));
    host.append(el('span', { class: 'rb-spacer' }));
    appendTry(ephemeral);
    return;
  }

  /* -------- hit points --------------------------------------------- */
  const hp = derived.hp;
  const frac = hp.max ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;
  const tempFrac = hp.max ? Math.min(1, (hp.temp || 0) / hp.max) : 0;
  const bar = el('div', { class: 'hpbar', title: 'Hit points' });
  bar.append(el('div', { class: 'fill', style: `width:${(frac * 100).toFixed(1)}%` }));
  if (tempFrac > 0) {
    bar.append(el('div', {
      class: 'temp',
      style: `left:${(frac * 100).toFixed(1)}%;width:${(tempFrac * 100).toFixed(1)}%`,
    }));
  }
  const hpWrap = el('div', { class: 'rb-hp' });
  hpWrap.append(bar);
  hpWrap.append(el('span', { class: 'rb-num' },
    `${hp.current}/${hp.max}${hp.temp ? ` +${hp.temp}` : ''}`));
  hpWrap.append(el('span', { class: 'rb-ac' }, `AC ${derived.ac}`));
  host.append(hpWrap);

  /* -------- quick adjust ------------------------------------------- */
  const amount = el('input', {
    type: 'number', value: '1', min: '1', 'aria-label': 'Amount',
  });
  const adjust = async (mult) => {
    const n = Math.abs(Number(amount.value) || 0);
    if (!n) return;
    await deps.adjustHp(mult * n);
    // Modes render once; the store changing does not repaint them. The shell
    // re-renders the ones that display vitals - and only those, so a heal
    // never wipes a half-typed form in the Market or Roleplay.
    deps.rerenderVitals();
  };
  const row = el('div', { class: 'rb-adjust' });
  row.append(amount);
  row.append(el('button', {
    'aria-label': 'Damage', title: 'Damage', onClick: () => adjust(-1),
  }, '−'));
  row.append(el('button', {
    'aria-label': 'Heal', title: 'Heal', onClick: () => adjust(+1),
  }, '+'));
  host.append(row);

  /* -------- conditions (spans, never buttons) ----------------------- */
  const conditions = derived.conditions || [];
  if (conditions.length) {
    const wrap = el('div', { class: 'rb-conds' });
    for (const name of conditions.slice(0, 3)) {
      wrap.append(el('span', { class: 'chip bad rb-cond' }, name));
    }
    if (conditions.length > 3) {
      wrap.append(el('span', { class: 'chip bad rb-over' },
        `+${conditions.length - 3}`));
    }
    // The phone-sized summary: one chip carrying the count.
    wrap.append(el('span', { class: 'chip bad rb-more' },
      `${conditions.length} cond.`));
    host.append(wrap);
  }

  host.append(el('span', { class: 'rb-spacer' }));

  /* -------- switcher ------------------------------------------------ */
  if ((characters || []).length > 1) {
    const sel = el('select', { 'aria-label': 'Active character' });
    for (const c of characters) {
      sel.append(el('option', {
        value: c.id, ...(c.id === character.id ? { selected: 'selected' } : {}),
      }, c.name || 'Unnamed'));
    }
    sel.addEventListener('change', async () => {
      await deps.selectCharacter(sel.value);
      // Switching who you are re-renders the whole screen: every mode that
      // shows the ribbon shows character content, and keeping another
      // character's numbers on screen would be worse than losing a draft.
      deps.rerenderMode();
    });
    host.append(el('div', { class: 'rb-switch' }, sel));
  }

  // The speaker, on every screen a player plays on. Outside <main>, so the
  // gym's text probes and number counts never see it; textless, so no label
  // lookup ever picks it up; 44px on a phone like the adjust buttons.
  const sound = soundButton({ compact: true });
  sound.classList.add('rb-sound');
  host.append(sound);

  appendTry(ephemeral);
}

function appendTry(ephemeral) {
  if (ephemeral) return;
  const btn = el('button', {
    class: 'try',
    title: 'Open a throwaway session. Nothing you do in it is saved, and '
      + 'your real characters are untouched.',
    onClick: () => deps.startSandbox(),
  }, 'Try a sandbox');
  host.append(btn);
}
