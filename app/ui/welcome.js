/**
 * The first-run seat choice.
 *
 * Shown once, when no table is open and no seat has been chosen on this
 * device. Picking Player keeps the menu about playing; picking Dungeon Master
 * adds the DM screen and the homebrew analyser. Switchable any time in
 * Settings, so the cost of a wrong answer is one click.
 *
 * Mounted on <body>, never inside <main>: the app's tests read <main> to
 * decide what a mode is showing, and an overlay is not part of any mode.
 */

import { el } from '../core/store.js';
import * as session from '../core/session.js';

let overlay = null;

export function mount({ onChoose }) {
  if (overlay) return;

  const card = el('div', { class: 'welcome-card', role: 'document' });
  card.append(el('h2', {}, 'Well met.'));
  card.append(el('p', {},
    'Who holds this device at the table? This only tidies the menu - '
    + 'you can change it any time in Settings.'));

  const choices = el('div', { class: 'welcome-choices' });
  const choose = (role) => {
    session.setLocalRole(role);
    unmount();
    onChoose?.(role);
  };
  choices.append(el('button', { onClick: () => choose('player') }, 'Player'));
  choices.append(el('button', { onClick: () => choose('dm') }, 'Dungeon Master'));
  card.append(choices);

  card.append(el('p', { class: 'muted', style: 'font-size:13px;margin:0 0 8px' },
    'Joining someone’s table? Choose Player - the Table screen appears '
    + 'when their table is open.'));
  card.append(el('p', { class: 'welcome-fine' },
    'This tidies the menu, nothing more. At a real table the server decides '
    + 'what you may change.'));

  overlay = el('div', {
    class: 'welcome', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Choose your seat',
  });
  overlay.append(card);
  document.body.append(overlay);
  // Focus the likelier answer so Enter works immediately.
  choices.querySelector('button')?.focus();
}

export function unmount() {
  overlay?.remove();
  overlay = null;
}
