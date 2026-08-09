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
import { mapView, PIN_KINDS } from '../../ui/map.js';
import { db } from '../../core/db.js';
import { dmData } from './shared.js';

export const title = 'Deck';

let container = null;
let unsubscribe = null;
let tables = null;
let campaign = null;
let all = [];
let mapRecord = null;
let mapHandle = null;

export async function render(root) {
  container = root;
  ({ tables } = await dmData());
  await refresh();
  draw();

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['campaigns', 'maps', 'table'], async () => {
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
  mapRecord = campaign?.mapId
    ? await db.get('maps', campaign.mapId).catch(() => null)
    : null;
}

function draw() {
  container.innerHTML = '';
  if (!campaign) {
    container.append(newCampaignPanel());
    return;
  }
  container.append(dialsPanel());
  container.append(mapPanel());
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
/* the map                                                             */
/* ------------------------------------------------------------------ */

async function saveMap() {
  if (mapRecord) await db.put('maps', mapRecord);
}

function mapPanel() {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The map'));

  if (!mapRecord) {
    panel.append(el('p', { class: 'muted', style: 'font-size:14px' },
      "Drop the setting's map - the one from the book, or exported from any "
      + 'map tool. Pan, zoom, pin the places and the party; reveal pins to '
      + 'the players one by one.'));

    const file = el('input', {
      type: 'file', accept: 'image/*', 'aria-label': 'Map image file',
      style: 'max-width:280px',
    });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) {
        toast('That image is over 8 MB - export it smaller', 'bad');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => adoptImage(String(reader.result), f.name);
      reader.readAsDataURL(f);
    });
    panel.append(file);

    // The paste fallback: also what an automated test can drive, since
    // nothing can populate a file input.
    const url = el('input', {
      type: 'text', placeholder: 'or paste an image / data: URL...',
      'aria-label': 'Map image URL', style: 'max-width:280px;margin-top:8px',
    });
    const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
    row.append(url);
    row.append(el('button', {
      class: 'act ghost small',
      onClick: () => {
        const v = url.value.trim();
        if (!v) return toast('Paste an image URL first', 'warn');
        adoptImage(v, campaign.name);
        return null;
      },
    }, 'Use this image'));
    panel.append(row);
    return panel;
  }

  const bar = el('div', { class: 'btnrow', style: 'margin-bottom:8px' });
  for (const kind of PIN_KINDS) {
    bar.append(el('button', {
      class: 'act ghost small',
      title: `Then click the map to place the ${kind} pin`,
      onClick: () => {
        mapHandle?.armPlacement(kind);
        toast(`Click the map to place the ${kind}`, 'ok');
      },
    }, `+ ${kind}`));
  }
  bar.append(el('button', {
    class: 'act ghost small',
    onClick: async () => {
      if (!window.confirm('Remove the map and every pin on it?')) return;
      await db.del('maps', mapRecord.id).catch(() => null);
      campaign.mapId = null;
      await saveCampaign(campaign);
      mapRecord = null;
      draw();
    },
  }, 'Remove map'));
  panel.append(bar);

  const host = el('div', {});
  panel.append(host);
  mapHandle = mapView(host, {
    record: mapRecord,
    editable: true,
    regions: campaign.regions,
    onChange: () => saveMap(),
    onPartyMoved: async (regionId) => {
      if (campaign.currentRegionId === regionId) return;
      const region = campaign.regions.find((r) => r.id === regionId);
      campaign.currentRegionId = regionId;
      await saveCampaign(campaign);
      await log('region_moved',
        { regionId, regionName: region?.name, day: campaign.day },
        { campaignId: campaign.id });
      toast(`The party crossed into ${region?.name || 'a new region'}`, 'ok');
      draw();
    },
  });
  panel.append(el('p', { class: 'welcome-fine', style: 'margin-top:6px' },
    'Wheel to zoom, drag to pan. Dim pins are hidden from players; the '
    + 'server never sends them what you have not revealed. Drop the party '
    + 'flag near a regioned pin and the party moves there.'));
  return panel;
}

async function adoptImage(src, name) {
  const probe = new Image();
  probe.onload = async () => {
    mapRecord = {
      id: `map-${campaign.id}`,
      name: name || campaign.name,
      image: src,
      w: probe.naturalWidth, h: probe.naturalHeight,
      pins: [],
    };
    await db.put('maps', mapRecord);
    campaign.mapId = mapRecord.id;
    await saveCampaign(campaign);
    toast('The map is on the table', 'ok');
    draw();
  };
  probe.onerror = () => toast('That does not load as an image', 'bad');
  probe.src = src;
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
