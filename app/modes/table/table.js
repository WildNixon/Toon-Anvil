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
import { activeCampaign, currentRegion } from '../../core/campaign.js';
import { weatherFor } from '../../core/weather.js';
import { mapView } from '../../ui/map.js';
import { db, dataFile } from '../../core/db.js';

export const title = 'Table';

let container = null;
let tab = 'fight';
let unsubscribe = null;
let campaign = null;      // the REDACTED campaign - the server stripped it
let mapRecord = null;     // likewise: revealed pins only, no notes
let dmTables = null;

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
  unsubscribe = live.subscribe(
    ['encounters', 'table', 'characters', 'campaigns', 'maps'], async () => {
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

async function refresh() {
  const record = await pull();
  // A cleared encounter comes back as null. Adopting an empty snapshot rather
  // than leaving the last one on screen is the honest answer: the fight ended.
  adopt(record || { combatants: [], round: 0, turn: 0, started: false });

  // The world as the server tells it to a player: the campaign without its
  // agendas or hidden factions, the map without its hidden pins. Nothing to
  // filter here - the client never received what it must not show.
  campaign = await activeCampaign();
  if (!dmTables) dmTables = await dataFile('dm-tables.json', null);
  mapRecord = campaign?.mapId
    ? await db.get('maps', campaign.mapId).catch(() => null)
    : null;
}

function draw() {
  if (!container) return;
  container.innerHTML = '';
  const world = worldStrip();
  if (world) container.append(world);
  container.append(tabsPanel());
  if (tab === 'fight') {
    container.append(runnerPanel({
      readOnly: true,
      mine: session.ownedCharacterIds(),
      redraw: draw,
    }));
  } else if (tab === 'map') {
    container.append(mapPanel());
  } else {
    container.append(partyPanel(getState().characters || [], sources()));
  }
}

/**
 * The day and the sky: in-world facts everyone at a real table feels, so
 * they are always shared. Computed client-side from the campaign's seed -
 * the same pure function the DM's Deck runs.
 */
function worldStrip() {
  if (!campaign) return null;
  const region = currentRegion(campaign);
  const strip = el('div', { class: 'strip' });
  if (!region) {
    // A campaign fresh off a book has a name and a day before it has any
    // region - the players should still see the world exists.
    strip.append(el('span', { class: 'grow' },
      `Day ${campaign.day} — ${campaign.name}`));
    for (const f of campaign.factions || []) {
      strip.append(el('span', {
        class: `chip ${f.standing > 2 ? 'ok' : f.standing < -2 ? 'bad' : ''}`,
        title: 'How they currently regard the party',
      }, `${f.name} ${f.standing >= 0 ? '+' : ''}${f.standing}`));
    }
    return strip;
  }
  const sky = weatherFor(dmTables,
    { seed: campaign.seed, day: campaign.day, region });
  strip.append(el('span', { class: 'grow' },
    `Day ${campaign.day} — ${region.name}`
    + (sky ? `: ${sky.summary.toLowerCase()}` : '')));
  if (sky?.event) {
    strip.append(el('span', { class: 'mono', style: 'font-size:11px' },
      sky.event));
  }
  // The powers that be - only the factions the DM has made public. Ambient
  // world state, so it lives on the strip with the day and the sky.
  for (const f of campaign.factions || []) {
    strip.append(el('span', {
      class: `chip ${f.standing > 2 ? 'ok' : f.standing < -2 ? 'bad' : ''}`,
      title: 'How they currently regard the party',
    }, `${f.name} ${f.standing >= 0 ? '+' : ''}${f.standing}`));
  }
  return strip;
}

function mapPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The map'));
  if (!mapRecord) {
    panel.append(el('div', { class: 'empty' },
      'The DM has not put a map on the table yet.'));
    return panel;
  }
  const host = el('div', {});
  panel.append(host);
  // Read-only: what the server sent is already only what was revealed.
  mapView(host, { record: mapRecord, editable: false });
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Wheel to zoom, drag to pan. What you see is what has been revealed.'));
  return panel;
}

function tabsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Table'));
  const me = session.me();
  panel.append(el('h3', {}, me ? `Playing as ${me.name}` : 'At the table'));

  const items = [
    { id: 'fight', label: 'The fight' },
    { id: 'party', label: 'The party' },
  ];
  if (mapRecord) items.push({ id: 'map', label: 'The map' });
  panel.append(tabs({
    items,
    active: tab,
    onSelect: (id) => { tab = id; draw(); },
  }));
  return panel;
}
