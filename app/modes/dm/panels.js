/**
 * The treasure and improvisation panels.
 *
 * Split out of dm.js purely for size - that file already carries the encounter
 * budgeter, the bestiary and the rules reference. These two take the same
 * shape as the rest: a small control row, a result, and a chip on every result
 * saying whether it came from the SRD or was written for this tool.
 *
 * That chip matters more than it looks. A DM reading a generated line aloud is
 * entitled to know whether they are quoting the rules or quoting me.
 */

import { getState, setState, el, toast } from '../../core/store.js';
import { db } from '../../core/db.js';
import { rollHoard, applyToCharacter } from './loot.js';
import * as gen from './generators.js';
import { generateText } from '../../core/providers.js';

/** Label + control, matching the layout dm.js uses elsewhere. */
function field(label, control) {
  const wrap = el('label', { style: 'display:grid;gap:3px' });
  wrap.append(el('span', { class: 'eyebrow' }, label));
  wrap.append(control);
  return wrap;
}

/** SRD or mine - shown on every generated result. */
function sourceChip(source) {
  return el('span', {
    class: 'chip',
    style: source === 'srd' ? '' : 'background:rgba(154,106,18,.25)',
    title: source === 'srd'
      ? 'From the System Reference Document'
      : 'Written for this tool - not official content',
  }, source === 'srd' ? 'SRD' : 'authored');
}

/* ------------------------------------------------------------------ */
/* treasure                                                            */
/* ------------------------------------------------------------------ */

export function lootPanel({ tables, magicItems, loot, redraw, saveCharacter }) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Treasure'));

  if (!tables) {
    panel.append(el('div', { class: 'empty' },
      'dm-tables.json did not load, so treasure is unavailable.'));
    return panel;
  }

  panel.append(el('h3', {}, 'Roll a hoard'));
  panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
    'Coin bands and gems follow the SRD; art objects are written for this tool '
    + 'and labelled so. Rolls are seeded — write the seed down and you can get '
    + 'the same hoard back at the table.'));

  const crIn = el('input', {
    type: 'number', min: '0', max: '30', value: String(loot.cr), style: 'width:80px',
  });
  const seedIn = el('input', {
    type: 'number', value: String(loot.seed), style: 'width:100px',
  });
  const indiv = el('input', { type: 'checkbox' });
  indiv.checked = loot.individual;

  const row = el('div', {
    style: 'display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:12px',
  });
  row.append(field('Encounter CR', crIn));
  row.append(field('Seed', seedIn));

  const indivWrap = el('label', {
    style: 'display:flex;gap:6px;align-items:center;font-size:13px;padding-bottom:6px',
  });
  indivWrap.append(indiv);
  indivWrap.append(el('span', {}, 'One creature, not a hoard'));
  row.append(indivWrap);

  row.append(el('button', {
    class: 'act',
    onClick: () => {
      loot.cr = Number(crIn.value) || 0;
      loot.seed = Number(seedIn.value) || 1;
      loot.individual = indiv.checked;
      loot.result = rollHoard({
        tables, magicItems, cr: loot.cr, seed: loot.seed, individual: loot.individual,
      });
      redraw();
    },
  }, 'Roll'));
  row.append(el('button', {
    class: 'act ghost',
    onClick: () => { seedIn.value = String(Math.floor(Math.random() * 1e6)); },
  }, 'New seed'));
  panel.append(row);

  const h = loot.result;
  if (!h) {
    panel.append(el('div', { class: 'empty' }, 'Nothing rolled yet.'));
    return panel;
  }

  panel.append(el('h3', { style: 'margin-top:12px' },
    `${h.totalGp.toLocaleString()} gp total`));
  panel.append(el('p', { class: 'mono', style: 'font-size:12px;color:var(--muted)' },
    `CR band ${h.band} · seed ${h.seed}${h.individual ? ' · single creature' : ''}`));

  if (h.coins.length) {
    panel.append(el('p', { style: 'font-size:15px' },
      h.coins.map((c) => `${c.amount.toLocaleString()} ${c.unit.toUpperCase()}`)
        .join(' · ')));
  }

  for (const [heading, list] of [['Gems & art', h.valuables], ['Magic items', h.items]]) {
    if (!list.length) continue;
    panel.append(el('h3', { style: 'margin-top:14px;font-size:16px' }, heading));
    for (const v of list) {
      const line = el('div', {
        style: 'display:flex;gap:8px;align-items:center;padding:4px 0;'
          + 'border-bottom:1px solid var(--etch)',
      });
      line.append(el('span', { style: 'flex:1;font-size:14px' },
        v.name + (v.rarity ? ` — ${v.rarity}` : '')));
      if (v.gp) line.append(el('span', { class: 'mono' }, `${v.gp} gp`));
      line.append(sourceChip(v.source));
      panel.append(line);
    }
  }

  const chars = getState().characters || [];
  if (chars.length) {
    panel.append(el('h3', { style: 'margin-top:16px;font-size:16px' }, 'Hand it out'));
    const give = el('div', { class: 'btnrow' });
    for (const ch of chars) {
      give.append(el('button', {
        class: 'act ghost small',
        onClick: async () => {
          const next = applyToCharacter(ch, h);
          // Route the active character through saveCharacter so its derived
          // sheet refreshes; anybody else is a plain write.
          if (getState().characterId === ch.id) await saveCharacter(next);
          else await db.put('characters', next);
          setState({ characters: await db.list('characters') });
          toast(`${h.totalGp.toLocaleString()} gp of loot to ${ch.name}`, 'ok');
        },
      }, `Give to ${ch.name || 'Unnamed'}`));
    }
    panel.append(give);
  }
  return panel;
}

/* ------------------------------------------------------------------ */
/* improvisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * The one connector capability that is actually wired up.
 *
 * The generator gives you {name, trait, want, secret}. That is a slot fill,
 * not a person, and putting a voice on it is the part a DM does at 11pm with
 * four people looking at them. This turns those four facts into two lines of
 * description and one line to read aloud.
 *
 * Three things it deliberately is not:
 *
 *   - not automatic. It costs money on a hosted model, so it happens when
 *     you press it and not before.
 *   - not an authority. It arrives as a DRAFT beside the facts that produced
 *     it, and the facts stay on screen underneath.
 *   - not a rules answer. Nothing here decides anything - it writes.
 *
 * contentClass is 'none' in the catalogue because the four facts came from
 * local tables, so pressing this sends nothing of yours anywhere.
 */
function npcVoice(npc, redraw) {
  const box = el('div', { style: 'margin:2px 0 10px' });

  if (npc._voice) {
    const draft = el('div', {
      class: 'note', style: 'margin:6px 0',
    });
    draft.append(el('p', { style: 'margin:0 0 4px;font-size:13px' },
      el('strong', {}, 'A draft, to change however you like')));
    for (const line of String(npc._voice).split(/\n+/).filter(Boolean)) {
      draft.append(el('p', { style: 'margin:3px 0;font-size:14px' }, line));
    }
    if (npc._voiceCost) {
      draft.append(el('p', {
        class: 'mono muted', style: 'margin:6px 0 0;font-size:11px',
      }, npc._voiceCost));
    }
    box.append(draft);
  }

  const row = el('div', { class: 'btnrow' });
  row.append(el('button', {
    class: 'act ghost small',
    disabled: npc._voiceBusy || undefined,
    onClick: async () => {
      npc._voiceBusy = true;
      redraw();
      const r = await generateText({
        capability: 'npc_voice',
        maxTokens: 220,
        system: 'You write short, concrete NPC descriptions for a tabletop '
          + 'game master. No rules, no dice, no stat blocks.',
        prompt: `An NPC called ${npc.name}. They are ${npc.trait}. They want `
          + `${npc.want}. Their secret: ${npc.secret}. `
          + 'Write two short lines describing how they look and carry '
          + 'themselves, then one line of dialogue they might open with. '
          + 'Do not mention the secret outright.',
      });
      npc._voiceBusy = false;
      if (r.ok) {
        npc._voice = r.text;
        // What it actually cost, from the ledger row the server just wrote -
        // measured where the provider reports usage, and labelled when it is
        // only an estimate. Shown next to the thing it bought.
        const sp = r.spend;
        if (sp && sp.cents !== null && sp.cents !== undefined) {
          const d = sp.cents / 100;
          npc._voiceCost = sp.cents === 0
            ? `${sp.provider} - no cost`
            : `${sp.provider} - ${d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(3)}`}`
              + `${sp.centsAreEstimate ? ' (estimated)' : ''}`;
        }
      } else {
        toast(r.reason || 'no answer', 'bad');
      }
      redraw();
    },
  }, npc._voiceBusy ? 'Writing...' : npc._voice ? 'Try again' : 'Give them a voice'));
  box.append(row);
  return box;
}


export function improvPanel({ tables, monsters, improv, redraw, sendToFight }) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Improvise'));

  if (!tables) {
    panel.append(el('div', { class: 'empty' },
      'dm-tables.json did not load, so the generators are unavailable.'));
    return panel;
  }

  panel.append(el('h3', {}, 'When they ask about something you had not planned'));
  panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
    'Names, traits and rumours are written for this tool — they are not '
    + 'official content. Monsters and their numbers come from the SRD. Terrain '
    + 'is an authored weighting, because the bestiary carries no environment '
    + 'data.'));

  const seedIn = el('input', {
    type: 'number', value: String(improv.seed), style: 'width:100px',
  });
  const lvlIn = el('input', {
    type: 'number', min: '1', max: '20', value: String(improv.level), style: 'width:75px',
  });
  const terrainIn = el('select', {});
  for (const t of gen.TERRAINS) terrainIn.append(el('option', { value: t }, t));
  terrainIn.value = improv.terrain;

  const row = el('div', {
    style: 'display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:12px',
  });
  row.append(field('Seed', seedIn));
  row.append(field('Party level', lvlIn));
  row.append(field('Terrain', terrainIn));
  row.append(el('button', {
    class: 'act',
    onClick: () => {
      improv.seed = Number(seedIn.value) || 1;
      improv.level = Number(lvlIn.value) || 3;
      improv.terrain = terrainIn.value;
      improv.result = gen.rollAll(tables, monsters, improv);
      redraw();
    },
  }, 'Roll everything'));
  row.append(el('button', {
    class: 'act ghost',
    onClick: () => { seedIn.value = String(Math.floor(Math.random() * 1e6)); },
  }, 'New seed'));
  panel.append(row);

  const r = improv.result;
  if (!r) {
    panel.append(el('div', { class: 'empty' }, 'Nothing rolled yet.'));
    return panel;
  }

  const block = (heading, lines, source) => {
    const head = el('div', {
      style: 'display:flex;gap:8px;align-items:baseline;margin-top:16px',
    });
    head.append(el('h3', { style: 'font-size:16px;margin:0' }, heading));
    head.append(sourceChip(source));
    panel.append(head);
    for (const line of lines.filter(Boolean)) {
      panel.append(el('p', { style: 'margin:3px 0;font-size:14px' }, line));
    }
  };

  block(r.npc.name, [
    r.npc.trait,
    `Wants: ${r.npc.want}`,
    `Secret: ${r.npc.secret}`,
  ], 'authored');
  panel.append(npcVoice(r.npc, redraw));

  block(r.tavern.name, [r.tavern.detail, `Kept by ${r.tavern.keeper}`], 'authored');

  block('Rumour', [
    `"${r.rumour.text}"`,
    r.rumour.true ? 'This one is true.' : 'This one is false.',
  ], 'authored');

  block(`Trap: ${r.trap.name}`, [
    `Triggered by ${r.trap.trigger}`,
    `DC ${r.trap.dc} ${String(r.trap.save).toUpperCase()} save — ${r.trap.effect}`,
    r.trap.damage ? `Damage: ${r.trap.damage}` : null,
  ], 'authored');

  const e = r.encounter;
  block(`Encounter — ${e.terrain}`,
    e.monsters.length
      ? [`${e.monsters[0].count} × ${e.monsters[0].name} (CR ${e.monsters[0].cr})`,
        `${e.distance} away, ${e.doing}`]
      : [e.note],
    'srd');

  if (e.monsters.length) {
    panel.append(el('button', {
      class: 'act small', style: 'margin-top:10px',
      onClick: () => sendToFight(e.monsters[0]),
    }, 'Send to the fight'));
  }
  return panel;
}
