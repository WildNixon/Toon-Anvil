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
import { tabs } from '../../ui/kit.js';
import { partyPanel } from '../dm/party.js';
import { mapView } from '../../ui/map.js';
// The fight, the dice and the world now live in one place, because the
// sheet carries them too - see components/liveside.js.
import {
  LIVE_KINDS, refreshLive, liveMap, liveRecord, turnBanner, fightPanel,
  dicePanel, worldStrip,
} from '../../ui/components/liveside.js';

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
  unsubscribe = live.subscribe(LIVE_KINDS,
    async () => {
    // Only redraw if this screen still OWNS the view. The container is #view
    // itself, which is always connected - the honest check is the mode stamp,
    // or a stale listener paints the Party screen over whatever replaced it.
    if (container.dataset.rendered !== 'table') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    await refresh();
    draw();
  });
}

const refresh = refreshLive;

function draw() {
  if (!container) return;
  container.innerHTML = '';
  const world = worldStrip();
  if (world) container.append(world);
  container.append(tabsPanel());
  if (tab === 'fight') {
    const banner = turnBanner();
    if (banner) container.append(banner);
    container.append(fightPanel(draw));
    container.append(dicePanel());
  } else if (tab === 'map') {
    container.append(mapPanel());
  } else {
    container.append(partyPanel(getState().characters || [], sources()));
  }
}

function mapPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The map'));
  const mapRecord = liveMap();
  if (!mapRecord) {
    panel.append(el('div', { class: 'empty' },
      'The DM has not put a map on the table yet.'));
    return panel;
  }
  const host = el('div', {});
  panel.append(host);
  // Read-only: what the server sent is already only what was revealed.
  // Battle tokens ride the redacted encounter - only PLACED fighters show
  // (the DM's bench is the DM's mess), and the players watch the same
  // board the DM is dragging on the Stage.
  const tokens = (liveRecord()?.combatants || [])
    .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
    .map((c) => ({
      id: c.id,
      label: c.name,
      x: c.x,
      y: c.y,
      side: c.side,
      colour: c.kind === 'pc' ? session.colourOf(c.characterId) : null,
    }));
  mapView(host, { record: mapRecord, editable: false, tokens });
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Wheel to zoom, drag to pan. What you see is what has been revealed'
    + (tokens.length ? ' — and the fight, as the DM moves it.' : '.')));
  return panel;
}

function tabsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  // 'Party', like the nav button that got you here - one screen, one name.
  panel.append(el('span', { class: 'lvl accent' }, 'Party'));
  const me = session.me();
  panel.append(el('h3', {}, me ? `Playing as ${me.name}` : 'At the table'));

  const items = [
    { id: 'fight', label: 'The fight' },
    { id: 'party', label: 'The party' },
  ];
  if (liveMap()) items.push({ id: 'map', label: 'The map' });
  panel.append(tabs({
    items,
    active: tab,
    onSelect: (id) => { tab = id; draw(); },
  }));
  return panel;
}
