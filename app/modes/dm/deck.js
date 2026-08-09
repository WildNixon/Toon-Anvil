/**
 * DECK - the campaign as a control panel.
 *
 * The captain's instruments, top to bottom: the dials (day, sky, where the
 * party stands, the forge, the table), then the levers. Advance the day and
 * every player's Party screen dates itself; the sky is computed, never
 * stored, so every client derives the same weather from the campaign's seed.
 *
 * This commit: campaign + calendar + weather + regions. The map, the
 * factions and the economy dock here next.
 */

import { getState, el, toast } from '../../core/store.js';
import * as session from '../../core/session.js';
import * as live from '../../core/live.js';
import { log } from '../../core/events.js';
import {
  listCampaigns, activeCampaign, saveCampaign, setActive, newCampaign,
  newRegion, currentRegion,
} from '../../core/campaign.js';
import { weatherFor } from '../../core/weather.js';
import { statTile } from '../../ui/kit.js';
import { dmData } from './shared.js';

export const title = 'Deck';

let container = null;
let unsubscribe = null;
let tables = null;
let campaign = null;
let all = [];

export async function render(root) {
  container = root;
  ({ tables } = await dmData());
  await refresh();
  draw();

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['campaigns', 'table'], async () => {
    if (container.dataset.rendered !== 'dm-deck') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    await refresh();
    draw();
  });
}

async function refresh() {
  all = await listCampaigns();
  campaign = await activeCampaign();
}

function draw() {
  container.innerHTML = '';
  if (!campaign) {
    container.append(newCampaignPanel());
    return;
  }
  container.append(dialsPanel());
  container.append(regionsPanel());
  container.append(campaignPanel());
}

/* ------------------------------------------------------------------ */
/* dials                                                               */
/* ------------------------------------------------------------------ */

function dialsPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, campaign.name));

  const region = currentRegion(campaign);
  const sky = region
    ? weatherFor(tables, { seed: campaign.seed, day: campaign.day, region })
    : null;
  const status = session.current() || {};
  const players = (status.profiles || []).filter((p) => p.role === 'player');

  const dials = el('div', { class: 'grid stats', style: 'margin-bottom:12px' });
  dials.append(statTile('Day', campaign.day, 'of the campaign'));
  dials.append(statTile('The sky', sky ? sky.summary : '—',
    region ? region.name : 'add a region below'));
  dials.append(statTile('The party', region ? region.name : '—',
    region ? region.terrain : 'no region yet'));
  dials.append(statTile('Forge', session.isOpen()
    ? (session.forgeOpen() ? 'open' : 'shut') : '—',
  session.isOpen() ? 'toggle in Setup or Stage' : 'no table'));
  dials.append(statTile('Table', session.isOpen()
    ? `${players.length} joined` : 'solo',
  session.isOpen() ? 'open' : 'open one in Setup'));
  panel.append(dials);

  if (sky?.event) {
    panel.append(el('p', {
      class: 'mono', style: 'font-size:12px;color:var(--accent-text);margin:0 0 10px',
    }, `Today: ${sky.event}`));
  }

  const row = el('div', { class: 'btnrow' });
  row.append(el('button', {
    class: 'act',
    title: 'End the day. Tomorrow has its own sky.',
    onClick: async () => {
      campaign.day += 1;
      await saveCampaign(campaign);
      await log('day_advanced', { day: campaign.day },
        { campaignId: campaign.id });
      toast(`Day ${campaign.day} dawns`, 'ok');
      draw();
    },
  }, 'Advance the day'));
  panel.append(row);
  return panel;
}

/* ------------------------------------------------------------------ */
/* regions                                                             */
/* ------------------------------------------------------------------ */

function regionsPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Regions'));

  if (!campaign.regions.length) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      'A region is a place with its own sky and its own prices. Add the '
      + 'first one and the dials wake up.'));
  }

  const terrains = Object.keys(tables?.terrain || {})
    .filter((k) => !k.startsWith('_'));

  for (const region of campaign.regions) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
        + 'padding:7px 0;border-bottom:1px solid var(--etch)',
    });
    const here = campaign.currentRegionId === region.id;
    row.append(el('button', {
      class: `act ${here ? '' : 'ghost'} small`,
      title: here ? 'The party is here' : 'Move the party here',
      onClick: async () => {
        if (here) return;
        campaign.currentRegionId = region.id;
        await saveCampaign(campaign);
        await log('region_moved',
          { regionId: region.id, regionName: region.name, day: campaign.day },
          { campaignId: campaign.id });
        toast(`The party crossed into ${region.name}`, 'ok');
        draw();
      },
    }, here ? 'Party is here' : 'Move party here'));
    row.append(el('strong', { style: 'min-width:120px' }, region.name));

    const terr = el('select', {
      'aria-label': `Terrain of ${region.name}`, style: 'width:auto',
    });
    for (const k of terrains) {
      terr.append(el('option', { value: k, selected: k === region.terrain }, k));
    }
    terr.addEventListener('change', async () => {
      region.terrain = terr.value;
      await saveCampaign(campaign);
      draw();
    });
    row.append(terr);

    const sky = weatherFor(tables,
      { seed: campaign.seed, day: campaign.day, region });
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px;flex:1' },
      sky ? sky.summary : ''));
    panel.append(row);
  }

  // Add row: a name field is fine here (no gym flow greps this screen's
  // inputs positionally).
  const name = el('input', {
    type: 'text', placeholder: 'New region name...',
    'aria-label': 'New region name', style: 'max-width:220px',
  });
  const add = el('div', { class: 'btnrow', style: 'margin-top:10px' });
  add.append(name);
  add.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      const n = name.value.trim();
      if (!n) return toast('Name the region first', 'warn');
      campaign.regions.push(newRegion(n));
      if (!campaign.currentRegionId) {
        campaign.currentRegionId = campaign.regions[0].id;
      }
      await saveCampaign(campaign);
      name.value = '';
      draw();
      return null;
    },
  }, 'Add region'));
  panel.append(add);
  return panel;
}

/* ------------------------------------------------------------------ */
/* the campaign itself                                                 */
/* ------------------------------------------------------------------ */

function campaignPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Campaign'));

  for (const c of all) {
    const row = el('div', {
      style: 'display:flex;gap:10px;align-items:center;padding:5px 0',
    });
    row.append(el('strong', { style: 'flex:1' }, c.name));
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
      `day ${c.day} · seed ${c.seed}`));
    if (c.active) row.append(el('span', { class: 'chip accent' }, 'active'));
    else {
      row.append(el('button', {
        class: 'act ghost small',
        onClick: async () => { await setActive(c.id); await refresh(); draw(); },
      }, 'Make active'));
    }
    panel.append(row);
  }

  panel.append(newCampaignRow());
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:10px' },
    'The seed is public and predicts nothing but the sky - players compute '
    + 'the same weather you do. Agendas are the secrets, and those never '
    + 'leave this machine for a player.'));
  return panel;
}

function newCampaignPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'The Deck'));
  panel.append(el('h3', {}, 'No campaign yet'));
  panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
    'A campaign is the world the Deck drives: its calendar, its skies, its '
    + 'regions and prices, its factions. Name it and take the wheel.'));
  panel.append(newCampaignRow());
  return panel;
}

function newCampaignRow() {
  const name = el('input', {
    type: 'text', placeholder: 'Campaign name...',
    'aria-label': 'Campaign name', style: 'max-width:240px',
  });
  const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
  row.append(name);
  row.append(el('button', {
    class: 'act',
    onClick: async () => {
      const n = name.value.trim();
      if (!n) return toast('Name it first', 'warn');
      const c = newCampaign(n);
      c.active = all.length === 0;
      await saveCampaign(c);
      await setActive(c.id);
      await refresh();
      draw();
      toast(`${c.name} begins`, 'ok');
      return null;
    },
  }, 'Found the campaign'));
  return row;
}
