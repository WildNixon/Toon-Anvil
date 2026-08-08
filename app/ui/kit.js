/**
 * Small shared UI pieces.
 *
 * Three helpers that had each been written four times across the modes,
 * promoted the moment a fourth copy was about to appear. Everything here
 * builds plain DOM through el() and styles itself entirely from design.css
 * classes - no inline layout.
 */

import { el } from '../core/store.js';

/**
 * A row of tabs. Returns the tablist element.
 *
 * Buttons carry role=tab and aria-selected, styled as parchment file-folders
 * (.tabs/.tab in design.css) - deliberately unlike .act buttons, because a
 * tab answers "where am I", not "do something".
 *
 * `items` is [{ id, label }]; `onSelect(id)` is called with the clicked id.
 * The caller owns the state and redraws; this stays stateless.
 */
export function tabs({ items, active, onSelect }) {
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  for (const { id, label } of items) {
    bar.append(el('button', {
      class: 'tab',
      role: 'tab',
      'aria-selected': String(id === active),
      onClick: () => { if (id !== active) onSelect(id); },
    }, label));
  }
  return bar;
}

/** A labelled control: the .field caption above whatever is passed in. */
export function field(label, control) {
  const wrap = el('div', {});
  wrap.append(el('label', { class: 'field' }, label));
  wrap.append(control);
  return wrap;
}

/**
 * One stat tile - the .stat card with its k/v/sub lines.
 * Pass onClick to make it a .clickable tile.
 */
export function statTile(k, v, sub = '', onClick = null) {
  const tile = el('div', {
    class: `stat${onClick ? ' clickable' : ''}`,
    ...(onClick ? { onClick, role: 'button', tabindex: '0' } : {}),
  });
  tile.append(el('div', { class: 'k' }, k));
  tile.append(el('div', { class: 'v' }, String(v)));
  if (sub) tile.append(el('div', { class: 'sub' }, sub));
  return tile;
}
