/**
 * The table - what a player sees of the shared game.
 *
 * Two things, because they are the two things a player asks about between
 * their turns: what is happening in the fight, and how everyone is doing.
 *
 * The fight is rendered by the SAME function the DM uses, in read-only mode.
 * Writing a second renderer for players is how two views of one initiative
 * order end up disagreeing about whose turn it is.
 *
 * Nothing here can write. That is not politeness - the server refuses a
 * player's write to `encounters` regardless of what this screen offers, and
 * this screen simply does not offer it.
 */

import { getState, el } from '../../core/store.js';
import * as session from '../../core/session.js';
import * as live from '../../core/live.js';
import { runnerPanel, adopt, pull } from '../dm/runner.js';
import { tabs } from '../../ui/kit.js';
import { partyPanel } from '../dm/party.js';

export const title = 'Table';

let container = null;
let tab = 'fight';
let unsubscribe = null;

/** Sources for derive(), assembled the same way the shell does it. */
function sources() {
  const { compendium: c, homebrew } = getState();
  return {
    classes: c.classes || [], species: c.species || [],
    backgrounds: c.backgrounds || [], feats: c.feats || [],
    srdEffects: c.srdEffects || {}, equipment: c.equipment,
    homebrew: homebrew || [],
  };
}

export async function render(root) {
  container = root;
  await refresh();
  draw();

  // Re-read when the DM changes the fight. Subscribing on every render would
  // stack listeners - each mode is re-rendered on mode switches and on live
  // updates - so the previous one is dropped first.
  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['encounters', 'table'], async () => {
    // Only redraw if this screen is still the one mounted. A stale listener
    // writing into a detached node is invisible until it is not.
    if (!container.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
    await refresh();
    draw();
  });
}

async function refresh() {
  const record = await pull();
  // A cleared encounter comes back as null. Adopting an empty snapshot rather
  // than leaving the last one on screen is the honest answer: the fight ended.
  adopt(record || { combatants: [], round: 0, turn: 0, started: false });
}

function draw() {
  if (!container) return;
  container.innerHTML = '';
  container.append(tabsPanel());
  if (tab === 'fight') {
    container.append(runnerPanel({
      readOnly: true,
      mine: session.ownedCharacterIds(),
      redraw: draw,
    }));
  } else {
    container.append(partyPanel(getState().characters || [], sources()));
  }
}

function tabsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Table'));
  const me = session.me();
  panel.append(el('h3', {}, me ? `Playing as ${me.name}` : 'At the table'));

  panel.append(tabs({
    items: [{ id: 'fight', label: 'The fight' }, { id: 'party', label: 'The party' }],
    active: tab,
    onSelect: (id) => { tab = id; draw(); },
  }));
  return panel;
}
