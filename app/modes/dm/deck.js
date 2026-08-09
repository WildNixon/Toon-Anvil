/**
 * DECK - the campaign as a control panel.
 *
 * The captain's instruments: the in-game day and its weather, where the
 * party stands, the map, the factions and their moods, the price of bread in
 * every region - each a dial the DM can read at a glance and turn with one
 * hand. Everything it changes lands on the players' screens live: advance
 * the day and their Party screen dates itself; turn a region's prices and
 * their open Market re-prices.
 *
 * This commit: the frame. The campaign record, calendar, weather, map,
 * factions and economy arrive in the next ones, each with its own tests.
 */

import { el } from '../../core/store.js';
import { dmData } from './shared.js';

export const title = 'Deck';

export async function render(root) {
  await dmData();
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'The Deck'));
  panel.append(el('h3', {}, 'The campaign, on one panel'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px;margin:0' },
    'Day and weather, the map, the factions, the markets - the world\'s '
    + 'instruments are being fitted. The Stage runs the fight; the Deck '
    + 'will run everything around it.'));
  root.append(panel);
}
