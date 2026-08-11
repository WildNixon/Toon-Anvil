/**
 * Roll cards - results worth looking at.
 *
 * A d20 result used to be a grey toast that vanished in 4.2 seconds: the
 * nat 20 and the shopping receipt got the same voice. Cards stack beside
 * the toast, name the roll, show the die faces (both of them under
 * advantage, the used one marked), break the total down, and let a crit
 * LOOK like a crit.
 *
 * cardModel() is pure - roll result in, display model out - so the logic
 * tier grades face marking, crit flags and breakdown maths without a DOM.
 * The crit/fumble state is carried by TEXT and border, not only by motion:
 * prefers-reduced-motion kills the flare, never the meaning.
 *
 * toast() remains the voice for notices ("saved", "copied", refusals).
 * Rolls come here.
 */

import { el, sign } from '../../core/store.js';

const MAX_CARDS = 4;
const CARD_MS = 9000;

/**
 * The last few rolls, kept because the cards do not keep themselves.
 *
 * A card lives CARD_MS and then leaves, which is right for a notification
 * and wrong for a record - "what did I actually roll for that" is asked
 * about thirty seconds later, by which time the card is gone. This is the
 * short memory the rail reads.
 */
const HISTORY_MAX = 10;
const history = [];
const listeners = new Set();

export function rollHistory() { return history.slice(); }

/** Subscribe to pushes. Returns an unsubscribe. */
export function onRoll(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pure display model for one d20-style roll. */
export function cardModel({ label, roll, extra = null, why = null }) {
  let marked = false;
  const faces = (roll.faces || []).map((v) => {
    const used = !marked && v === roll.nat;
    if (used) marked = true;
    return { v, used };
  });
  return {
    label: String(label || 'Roll'),
    total: roll.total,
    faces,
    mod: roll.mod || 0,
    advantage: !!roll.advantage,
    disadvantage: !!roll.disadvantage,
    crit: !!roll.isCrit,
    fumble: !!roll.isFumble,
    extra,
    // Where the modifier came from, in words. The faces already say what
    // the dice did; this says what the sheet added and why.
    why: why || null,
  };
}

function mount(doc) {
  let host = doc.getElementById('rollcards');
  if (!host) {
    // The app's index.html ships the mount; embedded contexts get one made.
    host = el('div', { id: 'rollcards', 'aria-live': 'polite' });
    doc.body.append(host);
  }
  return host;
}

/** Render a model into the stack. Returns the card element. */
export function pushRollCard(model, doc = document) {
  const host = mount(doc);

  const card = el('div', {
    class: `rollcard${model.crit ? ' crit' : ''}${model.fumble ? ' fumble' : ''}`,
    'aria-label': `${model.label}: ${model.total}`
      + `${model.crit ? ', critical' : model.fumble ? ', fumble' : ''}`,
  });

  const head = el('div', { class: 'rc-head' });
  head.append(el('span', { class: 'rc-label' }, model.label));
  if (model.advantage) head.append(el('span', { class: 'rc-mode' }, 'advantage'));
  if (model.disadvantage) head.append(el('span', { class: 'rc-mode' }, 'disadvantage'));
  card.append(head);

  const row = el('div', { class: 'rc-row' });
  row.append(el('span', { class: 'rc-total' }, String(model.total)));
  const detail = el('span', { class: 'rc-detail' });
  const dice = el('span', { class: 'rc-faces' });
  for (const f of model.faces) {
    dice.append(el('span', {
      class: `face${f.used ? ' used' : ' spare'}`,
    }, String(f.v)));
  }
  detail.append(dice);
  if (model.mod) detail.append(el('span', { class: 'rc-mod' }, sign(model.mod)));
  row.append(detail);
  card.append(row);

  // The state a glance must read even with animation off.
  if (model.crit) card.append(el('div', { class: 'rc-flag' }, 'Critical!'));
  if (model.fumble) card.append(el('div', { class: 'rc-flag' }, 'Fumble'));
  if (model.why) card.append(el('div', { class: 'rc-why' }, model.why));
  if (model.extra) card.append(el('div', { class: 'rc-extra' }, model.extra));

  host.append(card);
  while (host.children.length > MAX_CARDS) host.firstElementChild.remove();
  setTimeout(() => card.remove(), CARD_MS);

  history.push(model);
  while (history.length > HISTORY_MAX) history.shift();
  for (const fn of listeners) {
    try { fn(model); } catch { /* a stale listener must not stop a roll */ }
  }
  return card;
}
