/**
 * Shop mode - buying, selling, and where the money went.
 *
 * Every transaction is an event, so the Chronicle can tell your DM that you
 * spent 340 GP on rope and antitoxin and none on armour.
 */

import { getState, el, sign, toast } from '../../core/store.js';
import { compendium } from '../../core/db.js';
import { log } from '../../core/events.js';
import { d20, fmt } from '../../core/dice.js';
import { fromCopper, toCopper, COIN_CP } from '../../core/rules2024.js';
import { saveCharacter, go } from '../../app.js';
import { unitPrice, sellBack } from './pricing.js';
import {
  activeCampaign, currentRegion, priceModFor, stampDay,
} from '../../core/campaign.js';
import { weatherFor } from '../../core/weather.js';
import { dataFile } from '../../core/db.js';
import * as live from '../../core/live.js';

export const title = 'Market';

const SHOP_TYPES = {
  general:   { label: 'General store', kinds: ['gear'], markup: 1.0 },
  smith:     { label: 'Smith',         kinds: ['weapon', 'armor'], markup: 1.05 },
  alchemist: { label: 'Alchemist',     kinds: ['gear'], filter: /potion|acid|alchemist|antitoxin|oil/i, markup: 1.2 },
  arcane:    { label: 'Arcane dealer', kinds: ['magic'], markup: 1.5 },
};

const SETTLEMENT = {
  hamlet:   { label: 'Hamlet',   stock: 8,  variance: 0.25 },
  village:  { label: 'Village',  stock: 16, variance: 0.18 },
  town:     { label: 'Town',     stock: 30, variance: 0.12 },
  city:     { label: 'City',     stock: 55, variance: 0.08 },
};

let container = null;
let shop = null;
let catalog = null;
let campaign = null;
let dmTables = null;
let unsubscribe = null;

export async function render(root) {
  container = root;
  catalog = catalog || await loadCatalog();
  campaign = await activeCampaign();
  if (!dmTables) dmTables = await dataFile('dm-tables.json', null);
  draw();

  // The DM's Deck turns a region's price dial or moves the party; an open
  // Market must feel it without a reload.
  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['campaigns'], async () => {
    if (container.dataset.rendered !== 'shop') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    campaign = await activeCampaign();
    draw();
  });
}

async function loadCatalog() {
  const [equipment, magic] = await Promise.all([
    compendium('equipment'), compendium('magic-items'),
  ]);
  return [
    ...equipment.weapons.map((w) => ({ ...w, kind: 'weapon' })),
    ...equipment.armor.map((a) => ({ ...a, kind: 'armor' })),
    ...equipment.gear.map((g) => ({ ...g, kind: 'gear' })),
    ...magic.filter((m) => m.rarity).map((m) => ({
      ...m, kind: 'magic',
      costCp: { Common: 10000, Uncommon: 50000, Rare: 500000,
        'Very Rare': 5000000, Legendary: 50000000 }[m.rarity] || 10000,
    })),
  ];
}

function draw() {
  container.innerHTML = '';
  const strip = regionStrip();
  if (strip) container.append(strip);
  container.append(generatorPanel());
  if (shop) container.append(stockPanel());
  container.append(pursePanel());
}

/**
 * Where the party stands, and what that does to prices - the campaign's
 * world reaching the player's counter. In-world facts only: the day, the
 * sky, the multiplier. Nothing here is a control.
 */
function regionStrip() {
  const region = currentRegion(campaign);
  if (!campaign || !region) return null;
  const mod = priceModFor(campaign);
  const sky = weatherFor(dmTables,
    { seed: campaign.seed, day: campaign.day, region });
  const strip = el('div', { class: 'strip' });
  strip.append(el('span', { class: 'grow' },
    `Prices in ${region.name}: ×${mod}` + (sky
      ? ` — day ${campaign.day}, ${sky.summary.toLowerCase()}`
      : ` — day ${campaign.day}`)));
  return strip;
}

/* ------------------------------------------------------------------ */

function generatorPanel() {
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Market'));
  panel.append(el('h3', {}, shop ? shop.name : 'Generate a shop'));

  const row = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px',
  });
  const type = el('select', {});
  for (const [k, v] of Object.entries(SHOP_TYPES)) {
    type.append(el('option', { value: k }, v.label));
  }
  const size = el('select', {});
  for (const [k, v] of Object.entries(SETTLEMENT)) {
    size.append(el('option', { value: k, selected: k === 'town' }, v.label));
  }
  row.append(wrap('Shop type', type), wrap('Settlement', size));
  panel.append(row);

  panel.append(el('div', { class: 'btnrow', style: 'margin-top:12px' },
    el('button', {
      class: 'act', onClick: () => { generate(type.value, size.value); },
    }, 'Generate stock')));
  return panel;
}

function wrap(label, control) {
  const d = el('div');
  d.append(el('label', { class: 'field' }, label));
  d.append(control);
  return d;
}

const VENDORS = ['Aldric', 'Brenna', 'Corvin', 'Delphine', 'Ewan', 'Fenna',
  'Gorm', 'Hilde', 'Ilric', 'Jessa', 'Karn', 'Lisbet'];

function generate(typeKey, sizeKey) {
  const type = SHOP_TYPES[typeKey];
  const size = SETTLEMENT[sizeKey];
  let pool = catalog.filter((i) => type.kinds.includes(i.kind));
  if (type.filter) pool = pool.filter((i) => type.filter.test(i.name));
  // Cheap things are common; a hamlet does not stock plate armour.
  const affordable = pool.filter((i) => (i.costCp || 0) <= ({
    hamlet: 5000, village: 25000, town: 200000, city: 100000000,
  }[sizeKey]));
  const chosen = shuffle(affordable.length > 4 ? affordable : pool).slice(0, size.stock);

  shop = {
    name: `${VENDORS[Math.floor(Math.random() * VENDORS.length)]}'s ${type.label}`,
    vendor: VENDORS[Math.floor(Math.random() * VENDORS.length)],
    type: typeKey,
    size: sizeKey,
    attitude: 0,
    stock: chosen.map((item) => {
      const swing = 1 + (Math.random() * 2 - 1) * size.variance;
      return {
        ...item,
        qty: item.kind === 'gear' ? 1 + Math.floor(Math.random() * 5) : 1,
        priceCp: Math.max(1, Math.round((item.costCp || 100) * type.markup * swing)),
      };
    }),
  };
  toast(`${shop.name} - ${shop.stock.length} items in stock`);
  draw();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */

function stockPanel() {
  const { derived } = getState();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Stock'));

  const head = el('div', { class: 'btnrow', style: 'margin-bottom:12px' });
  head.append(el('button', { class: 'act ghost small', onClick: haggle }, 'Haggle'));
  if (shop.attitude) {
    head.append(el('span', { class: `chip ${shop.attitude > 0 ? 'ok' : 'bad'}` },
      `${shop.attitude > 0 ? 'Discount' : 'Markup'} ${Math.abs(shop.attitude)}%`));
  }
  panel.append(head);

  const wrapEl = el('div', { class: 'scroll-x' });
  const table = el('table');
  table.innerHTML = '<tr><th>Item</th><th>Kind</th><th>Price</th><th>Qty</th><th></th></tr>';
  for (const item of shop.stock) {
    const price = unitPrice(item.priceCp, shop.attitude, priceModFor(campaign));
    const canAfford = derived ? derived.copper >= price : false;
    const tr = el('tr');
    tr.append(el('td', {}, item.name));
    tr.append(el('td', { class: 'muted', style: 'font-size:13px' }, item.kind));
    tr.append(el('td', { class: 'mono' }, fromCopper(price)));
    tr.append(el('td', { class: 'mono' }, String(item.qty)));
    const cell = el('td');
    cell.append(el('button', {
      class: `act small ${canAfford ? '' : 'ghost'}`,
      disabled: !derived || item.qty <= 0,
      title: canAfford ? '' : 'Not enough coin',
      onClick: () => buy(item, price),
    }, 'Buy'));
    tr.append(cell);
    table.append(tr);
  }
  wrapEl.append(table);
  panel.append(wrapEl);
  return panel;
}

async function haggle() {
  const { derived } = getState();
  if (!derived) return toast('Select a character first', 'bad');
  const mod = derived.skills.persuasion.mod;
  const r = d20({ mod });
  const dc = 12 + Math.floor(Math.random() * 5);
  const won = r.total >= dc;
  shop.attitude = won ? Math.min(20, shop.attitude + 5 + Math.floor(r.nat / 5))
    : Math.max(-15, shop.attitude - 5);
  await log('haggle', {
    vendor: shop.name, roll: r.total, dc, success: won, attitude: shop.attitude,
  });
  toast(`Persuasion ${fmt(r)} vs DC ${dc} - ${won ? 'they soften' : 'they bristle'}`,
    won ? 'ok' : 'bad');
  draw();
  return null;
}

async function buy(item, priceCp) {
  const { derived, character } = getState();
  if (!derived) return toast('Select a character first', 'bad');
  if (derived.copper < priceCp) return toast('Not enough coin', 'bad');

  await saveCharacter((c) => {
    c.currency = subtractCoins(c.currency || {}, priceCp);
    c.inventory = [...(c.inventory || []), {
      id: `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      name: item.name, kind: item.kind, qty: 1,
      weight: item.weight, damage: item.damage, properties: item.properties,
      mastery: item.mastery, ac: item.ac, rarity: item.rarity,
      attunement: item.attunement, equipped: false, costCp: priceCp,
    }];
    return c;
  });
  item.qty -= 1;
  // Stamped with the campaign's day so the Deck's spending chart has a
  // real x-axis - unstamped, every purchase piled up at day zero.
  await log('purchase', stampDay({
    item: item.name, price: fromCopper(priceCp), priceCp,
    vendor: shop.name, kind: item.kind,
  }, campaign), { campaignId: campaign?.id });
  toast(`Bought ${item.name} for ${fromCopper(priceCp)}`, 'ok');
  draw();
  return null;
}

/** Spend copper, making change from larger coins as needed. */
function subtractCoins(purse, cp) {
  let remaining = toCopper(purse) - cp;
  const out = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  for (const coin of ['pp', 'gp', 'sp', 'cp']) {
    const mult = COIN_CP[coin];
    out[coin] = Math.floor(remaining / mult);
    remaining -= out[coin] * mult;
  }
  return out;
}

/* ------------------------------------------------------------------ */

function pursePanel() {
  const { derived } = getState();
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Purse'));
  if (!derived) {
    panel.append(el('div', { class: 'empty' }, 'No character selected.'));
    panel.append(el('div', { class: 'btnrow' },
      el('button', { class: 'act', onClick: () => go('build') }, 'Go to Build')));
    return panel;
  }
  panel.append(el('h3', {}, fromCopper(derived.copper)));
  panel.append(el('p', { class: 'mono muted' },
    `Carrying ${derived.carried} / ${derived.capacity} lb - ${derived.encumbrance}`));

  const row = el('div', { class: 'btnrow', style: 'margin-top:10px;align-items:center' });
  const amt = el('input', { type: 'number', value: '10', style: 'width:80px' });
  const coin = el('select', { style: 'width:80px' });
  for (const c of ['cp', 'sp', 'gp', 'pp']) {
    coin.append(el('option', { value: c, selected: c === 'gp' }, c.toUpperCase()));
  }
  row.append(el('span', { class: 'eyebrow' }, 'Adjust'), amt, coin);
  row.append(el('button', {
    class: 'act ghost small',
    onClick: () => adjustPurse(+amt.value * COIN_CP[coin.value]),
  }, 'Gain'));
  row.append(el('button', {
    class: 'act ghost small',
    onClick: () => adjustPurse(-(+amt.value * COIN_CP[coin.value])),
  }, 'Lose'));
  panel.append(row);

  if (derived.inventory.length) {
    panel.append(el('div', { class: 'rule' }));
    panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, 'Sell back'));
    const list = el('div', { class: 'btnrow' });
    for (const item of derived.inventory) {
      const back = sellBack(item.costCp, priceModFor(campaign));
      list.append(el('button', {
        class: 'act ghost small',
        // Equipment fetches half its cost when sold (SRD), scaled by where
        // you are standing - a cheap region buys cheap too.
        onClick: () => sell(item, back),
      }, `${item.name} → ${fromCopper(back)}`));
    }
    panel.append(list);
  }
  return panel;
}

async function adjustPurse(cp) {
  if (!cp) return;
  const { derived } = getState();
  const next = Math.max(0, derived.copper + cp);
  await saveCharacter((c) => {
    c.currency = subtractCoins(c.currency || {}, derived.copper - next);
    return c;
  });
  await log('gold_change', stampDay({ delta: cp, total: fromCopper(next) },
    campaign), { campaignId: campaign?.id });
  draw();
}

async function sell(item, priceCp) {
  await saveCharacter((c) => {
    c.inventory = (c.inventory || []).filter((i) => i.id !== item.id);
    c.currency = subtractCoins(c.currency || {}, -priceCp);
    return c;
  });
  await log('sale', stampDay(
    { item: item.name, price: fromCopper(priceCp), priceCp }, campaign),
  { campaignId: campaign?.id });
  toast(`Sold ${item.name} for ${fromCopper(priceCp)}`, 'ok');
  draw();
}
