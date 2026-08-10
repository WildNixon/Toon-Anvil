/**
 * The party, at a glance.
 *
 * The numbers a DM looks up constantly and currently cannot see at all: every
 * character's AC, passive Perception, passive Investigation, passive Insight,
 * saving throws, senses and speeds, side by side.
 *
 * Passive scores are the point. "Do they notice?" is asked several times a
 * session and answering it means opening each player's sheet in turn. One
 * table settles it.
 *
 * Everything comes from derive() - the same engine the player's own sheet and
 * the simulator use - so the DM's copy of a number can never disagree with the
 * player's.
 */

import { el, esc } from '../../core/store.js';
import { derive } from '../../core/derive.js';
import { ABILITIES, ABILITY_NAMES } from '../../core/rules2024.js';
import { colourOf } from '../../core/session.js';

/**
 * Passive score for a skill: 10 + modifier.
 *
 * Perception defers to derive()'s own passivePerception rather than
 * recomputing it. Two routes to one number is how a DM's copy and a player's
 * copy end up disagreeing, which is the exact failure this screen exists to
 * prevent.
 */
export function passive(d, skill) {
  if (skill === 'perception' && Number.isFinite(d.passivePerception)) {
    return d.passivePerception;
  }
  const s = d.skills?.[skill];
  if (!s) return 10;
  return 10 + (s.mod || 0);
}

/** derive() reports senses as an object or not at all; normalise for display. */
function sensesList(d) {
  const s = d.senses;
  if (!s) return [];
  if (Array.isArray(s)) return s.map(String);
  return Object.entries(s)
    .filter(([, v]) => v)
    .map(([k, v]) => (typeof v === 'number' ? `${k} ${v}ft` : String(k)));
}

export function partyRow(character, sources) {
  const d = derive(character, sources);
  return {
    id: character.id,
    name: character.name || 'Unnamed',
    classes: (character.classes || [])
      .map((c) => `${c.class} ${c.level}`).join(' / ') || 'level 0',
    level: d.level,
    ac: d.ac,
    hp: d.hp,
    initiative: d.initiative,
    speed: d.speeds?.walk ?? 30,
    perception: passive(d, 'perception'),
    investigation: passive(d, 'investigation'),
    insight: passive(d, 'insight'),
    saves: Object.fromEntries(ABILITIES.map((a) => [a, d.saves[a].mod])),
    senses: sensesList(d),
    resistances: d.resistances || [],
    conditions: d.conditions || [],
    exhaustion: d.exhaustion || 0,
  };
}

const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;

export function partyPanel(characters, sources) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'The party'));

  if (!characters.length) {
    panel.append(el('div', { class: 'empty' },
      'No characters yet. Anything built in Build shows up here - including '
      + 'the players\' characters if you share a server.'));
    return panel;
  }

  const rows = characters.map((c) => partyRow(c, sources));
  panel.append(el('h3', {}, `${rows.length} character${rows.length === 1 ? '' : 's'}`));
  panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
    'Passive scores are what you check without asking anyone to roll. '
    + 'Everything here is derived, so it matches each player\'s own sheet.'));

  const table = el('table', { style: 'width:100%;border-collapse:collapse' });
  const head = el('tr', {});
  for (const h of ['Character', 'AC', 'HP', 'Init', 'Speed',
    'Pass. Perc', 'Pass. Inv', 'Pass. Ins']) {
    head.append(el('th', { style: 'text-align:left' }, h));
  }
  table.append(head);

  for (const r of rows) {
    const tr = el('tr', {});
    const seat = colourOf(r.id);
    const nameCell = el('td', {
      dataset: seat ? { colour: seat } : {},
      style: seat ? `border-left:3px solid ${seat};padding-left:7px` : '',
    });
    nameCell.append(el('strong', {}, r.name));
    nameCell.append(el('div', { class: 'muted', style: 'font-size:11px' }, r.classes));
    if (r.conditions.length || r.exhaustion) {
      nameCell.append(el('div', { style: 'font-size:11px' },
        [...r.conditions, r.exhaustion ? `exhaustion ${r.exhaustion}` : null]
          .filter(Boolean).join(', ')));
    }
    tr.append(nameCell);
    tr.append(el('td', { class: 'mono' }, String(r.ac)));
    // Wounded is worth seeing at a glance, so colour it rather than making the
    // DM compare two numbers in their head.
    const frac = r.hp.max ? r.hp.current / r.hp.max : 1;
    tr.append(el('td', {
      class: 'mono',
      style: frac <= 0.25 ? 'color:var(--bad)' : frac < 1 ? 'color:var(--warn)' : '',
    }, `${r.hp.current}/${r.hp.max}`));
    tr.append(el('td', { class: 'mono' }, sign(r.initiative)));
    tr.append(el('td', { class: 'mono' }, `${r.speed}ft`));
    tr.append(el('td', { class: 'mono' }, String(r.perception)));
    tr.append(el('td', { class: 'mono' }, String(r.investigation)));
    tr.append(el('td', { class: 'mono' }, String(r.insight)));
    table.append(tr);
  }
  // Eight columns on a phone must scroll INSIDE the panel, never widen the
  // page - this screen is a player's main view of the fight on the couch.
  panel.append(el('div', { class: 'scroll-x' }, table));

  // Saves get their own table: eight columns of numbers is already dense, and
  // saves are looked up in a different moment ("everyone make a Dex save").
  panel.append(el('h3', { style: 'margin-top:18px' }, 'Saving throws'));
  const saves = el('table', { style: 'width:100%;border-collapse:collapse' });
  const sh = el('tr', {});
  sh.append(el('th', { style: 'text-align:left' }, 'Character'));
  for (const a of ABILITIES) {
    sh.append(el('th', { style: 'text-align:left' }, ABILITY_NAMES[a].slice(0, 3)));
  }
  saves.append(sh);
  for (const r of rows) {
    const tr = el('tr', {});
    tr.append(el('td', {}, r.name));
    for (const a of ABILITIES) {
      tr.append(el('td', { class: 'mono' }, sign(r.saves[a])));
    }
    saves.append(tr);
  }
  panel.append(el('div', { class: 'scroll-x' }, saves));

  const withSenses = rows.filter((r) => r.senses.length || r.resistances.length);
  if (withSenses.length) {
    panel.append(el('h3', { style: 'margin-top:18px' }, 'Senses & defences'));
    for (const r of withSenses) {
      panel.append(el('p', { style: 'font-size:13px;margin:4px 0' },
        `${esc(r.name)}: `
        + [r.senses.join(', '), r.resistances.length
          ? `resists ${r.resistances.join(', ')}` : null]
          .filter(Boolean).join(' · ')));
    }
  }

  return panel;
}
