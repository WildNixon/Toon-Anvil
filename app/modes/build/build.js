/**
 * Build mode - create and level characters.
 *
 * Homebrew subclasses appear in the same picker as SRD ones. Once ingested,
 * a subclass is just another source; nothing here special-cases it.
 */

import { getState, setState, esc, el, sign, toast } from '../../core/store.js';
import { db } from '../../core/db.js';
import { log } from '../../core/events.js';
import {
  ABILITIES, ABILITY_NAMES, SKILLS, abilityMod, proficiencyBonus,
  parseStartingEquipment, pointBuySpend, arrayAssignment,
  POINT_BUY_BUDGET, STANDARD_ARRAY,
} from '../../core/rules2024.js';
import { rollAbilityScores } from '../../core/dice.js';
import { saveCharacter, selectCharacter, recompute, go } from '../../app.js';
import * as session from '../../core/session.js';

export const title = 'Build';

let container = null;

export async function render(root) {
  container = root;
  draw();
}

function draw() {
  const { characters, character, compendium, homebrew } = getState();
  container.innerHTML = '';

  // At a table, a player's Build is THEIR bench: their characters only, and
  // only as editable as the forge and the grants allow. Solo (owned === null)
  // none of this exists.
  const owned = session.ownedCharacterIds();
  const mine = owned === null ? characters
    : characters.filter((c) => owned.has(c.id));
  const active = character && (owned === null || owned.has(character.id))
    ? character : null;

  container.append(rosterPanel(mine, active));
  if (!active) {
    container.append(el('div', { class: 'empty' },
      owned === null
        ? 'Create a character above, or import one, to start building.'
        : 'No character of yours is selected. Claim one at the table, or '
          + 'create one while the forge is open.'));
    return;
  }

  const gate = buildGate(active);
  if (gate.banner) container.append(gate.banner);
  container.append(identityPanel(active, compendium, homebrew));
  container.append(abilitiesPanel(active));
  container.append(skillsPanel(active, compendium));
  container.append(equipmentPanel(active, compendium));
  container.append(featuresPanel());
  if (gate.locked) lockInputs(container);
}

/**
 * What may THIS browser do to THIS character right now?
 *
 * Mirrors the server's rule for the screen's sake - the server still refuses
 * regardless. Locked means every identity input renders disabled; a grant
 * unlocks the sheet up to its level cap.
 */
function buildGate(ch) {
  if (session.ownedCharacterIds() === null) return { locked: false, banner: null };
  if (session.forgeOpen()) {
    const banner = el('div', { class: 'panel accent rivets' });
    banner.append(el('span', { class: 'lvl accent' }, 'The forge is open'));
    banner.append(el('p', { style: 'margin:0;font-size:14px' },
      'Build freely - name, species, class, everything. The DM closes the '
      + 'forge when the campaign starts.'));
    return { locked: false, banner };
  }
  const grantCap = session.myGrant(ch.id);
  if (grantCap !== null) {
    const banner = el('div', { class: 'panel accent rivets' });
    banner.append(el('span', { class: 'lvl accent' }, 'Level up'));
    banner.append(el('p', { style: 'margin:0;font-size:14px' },
      `The DM has granted a level-up: you can reach level ${grantCap}. `
      + 'Raise your class level and take what comes with it.'));
    return { locked: false, cap: grantCap, banner };
  }
  const banner = el('div', { class: 'panel rivets' });
  banner.append(el('span', { class: 'lvl' }, 'Sealed'));
  banner.append(el('p', { style: 'margin:0;font-size:14px;color:var(--muted)' },
    'Your sheet is set at the forge. Ask the DM to open it, or to grant a '
    + 'level-up - until then this page is read-only.'));
  return { locked: true, banner };
}

/** Disable every control below the roster - the sheet is sealed. */
function lockInputs(root) {
  for (const elmt of root.querySelectorAll(
    '.panel:not(:first-child) input, .panel:not(:first-child) select, '
    + '.panel:not(:first-child) button:not(.tab)',
  )) {
    elmt.disabled = true;
  }
}

/* ------------------------------------------------------------------ */
/* roster                                                              */
/* ------------------------------------------------------------------ */

function rosterPanel(characters, active) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Roster'));

  const row = el('div', { class: 'btnrow', style: 'margin-bottom:14px' });
  // Creation and retirement are forge acts at a table; the server refuses
  // them anyway, so offering the buttons would only manufacture error toasts.
  const atTable = session.ownedCharacterIds() !== null;
  const mayForge = !atTable || session.forgeOpen();
  if (mayForge) {
    row.append(el('button', { class: 'act', onClick: createCharacter }, 'New character'));
    row.append(el('button', { class: 'act ghost', onClick: importCharacter }, 'Import JSON'));
  }
  if (active) {
    row.append(el('button', { class: 'act ghost', onClick: exportCharacter }, 'Export'));
    if (mayForge) {
      row.append(el('button', {
        class: 'act ghost',
        onClick: () => deleteCharacter(active),
      }, 'Delete'));
    }
  }
  panel.append(row);

  if (!characters.length) {
    panel.append(el('p', { class: 'muted' }, 'No characters yet.'));
    return panel;
  }

  const list = el('div', { class: 'grid three' });
  for (const c of characters) {
    const card = el('div', {
      class: `stat clickable${c.id === active?.id ? ' active' : ''}`,
      style: c.id === active?.id ? 'border-top-color:var(--accent)' : '',
      onClick: async () => { await selectCharacter(c.id); draw(); },
    });
    card.append(el('div', { class: 'k' }, classLine(c)));
    card.append(el('div', { class: 'v', style: 'font-size:17px' }, c.name || 'Unnamed'));
    card.append(el('div', { class: 'sub' }, `Level ${totalLevel(c)}`));
    list.append(card);
  }
  panel.append(list);
  return panel;
}

/* ------------------------------------------------------------------ */
/* starting equipment                                                  */
/* ------------------------------------------------------------------ */

/**
 * Class (and background) starting gear, chosen once. A new character used
 * to start with nothing and AC 10 until they visited the Market - the
 * README listed it as the app's second-biggest gap. Buttons only: the gym
 * navigates Build by input POSITION, and a stray number input here would
 * hijack the Level field.
 */
function equipmentPanel(ch, compendium) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Starting equipment'));

  const clsId = ch.classes?.[0]?.class;
  const clsDef = (compendium.classes || []).find((c) => c.id === clsId);
  const parsed = parseStartingEquipment(
    clsDef?.startingEquipment, compendium.equipment);
  if (!parsed) {
    panel.append(el('p', { class: 'muted' },
      'This class ships no starting-equipment options.'));
    return panel;
  }

  if (ch.startingEquipment) {
    panel.append(el('p', { class: 'muted', style: 'margin:0' },
      ch.startingEquipment === 'skipped'
        ? 'Kept the 15 GP stake. The Market is open whenever you are.'
        : `Took option ${ch.startingEquipment.toUpperCase()}. `
          + 'Armour arrived equipped; the rest is in your inventory on Play.'));
  } else {
    panel.append(el('p', { class: 'muted', style: 'font-size:13px' },
      'One package, once - taking it replaces the 15 GP stake with the '
      + "option's own purse, and armour arrives already equipped."));
    for (const opt of parsed.options) {
      panel.append(optionRow(ch, opt, 'Take option'));
    }
    panel.append(el('div', { class: 'btnrow', style: 'margin-top:8px' },
      el('button', {
        class: 'act ghost small',
        onClick: () => update({ startingEquipment: 'skipped' }),
      }, 'Keep the 15 GP stake')));
  }

  // The background's package rides the same grammar - additive, since the
  // rules grant class AND background equipment.
  const bg = (compendium.backgrounds || []).find((b) => b.id === ch.background);
  const bgParsed = parseStartingEquipment(bg?.equipment, compendium.equipment);
  if (bgParsed) {
    panel.append(el('div', { class: 'eyebrow', style: 'margin:12px 0 4px' },
      `From your background (${bg.name})`));
    if (ch.startingEquipmentBg) {
      panel.append(el('p', { class: 'muted', style: 'margin:0' },
        `Took background option ${ch.startingEquipmentBg.toUpperCase()}.`));
    } else {
      for (const opt of bgParsed.options) {
        panel.append(optionRow(ch, opt, 'Take background option', true));
      }
    }
  }
  return panel;
}

function optionRow(ch, opt, verb, isBackground = false) {
  const row = el('div', {
    style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
      + 'padding:6px 0;border-bottom:1px solid var(--etch)',
  });
  row.append(el('span', { class: 'chip' }, opt.key.toUpperCase()));
  row.append(el('span', { style: 'flex:1;min-width:220px;font-size:13px' },
    opt.label));
  row.append(el('button', {
    class: 'act small',
    onClick: () => takeOption(ch, opt, isBackground),
  }, `${verb} ${opt.key.toUpperCase()}`));
  return row;
}

async function takeOption(ch, opt, isBackground) {
  await saveCharacter((c) => {
    const granted = opt.items.map((it) => packItem(it));
    // Armour goes on as it arrives; a shield is a shield, not body armour.
    for (const g of granted) {
      if (g.kind === 'armor') g.equipped = true;
    }
    c.inventory = [...(c.inventory || []), ...granted];
    if (isBackground) {
      // Background gold is EARNED on top - the class package (or the
      // stake) already set the purse.
      c.currency = { ...(c.currency || {}), gp: (c.currency?.gp || 0) + opt.gp };
      c.startingEquipmentBg = opt.key;
    } else {
      c.currency = { gp: opt.gp };
      c.startingEquipment = opt.key;
    }
    return c;
  });
  await log('journal', {
    text: `Starting equipment${isBackground ? ' (background)' : ''}: `
      + `option ${opt.key.toUpperCase()} — ${opt.label}`,
  });
  toast(`Option ${opt.key.toUpperCase()} taken`, 'ok');
  draw();
}

/** An option item as the same record shape the Market writes. */
function packItem(it) {
  const base = it.ref || {};
  return {
    id: `it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    name: it.ref ? it.ref.name : it.name,
    kind: base.kind || 'gear',
    qty: it.qty || 1,
    weight: base.weight, damage: base.damage, properties: base.properties,
    mastery: base.mastery, ac: base.ac, rarity: base.rarity,
    attunement: base.attunement, equipped: false, costCp: base.costCp || 0,
  };
}

const totalLevel = (c) => (c.classes || []).reduce((n, x) => n + (x.level || 0), 0) || 1;
const cap = (s) => String(s || '').replace(/^./, (m) => m.toUpperCase());
const classLine = (c) => (c.classes || [])
  .map((x) => `${cap(x.class)} ${x.level}`).join(' / ') || 'Unclassed';

async function createCharacter() {
  const id = `ch-${Date.now().toString(36)}`;
  const character = {
    id,
    name: 'New Character',
    ruleset: '2024',
    species: null,
    background: null,
    classes: [{ class: 'fighter', subclass: null, level: 1 }],
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    abilityMethod: 'pointbuy',
    skills: [], expertise: [], feats: [],
    hp: { max: 10, current: 10, temp: 0 },
    inventory: [], currency: { gp: 15 },
    spells: { prepared: [], known: [] },
    slotState: {}, resourceState: {}, toggles: {},
    conditions: [], exhaustion: 0,
    deathSaves: { successes: 0, failures: 0 },
    createdAt: new Date().toISOString(),
  };
  await db.put('characters', character);
  // At a table, claim what you just made. Without this the character sits
  // unowned, and the player's very next save hits the server's "no owner
  // yet" refusal - a trap that used to be unreachable only because no join
  // UI existed.
  if (session.isOpen() && session.me()) await session.claim(id);
  setState({ characters: await db.list('characters') });
  await selectCharacter(id);
  await log('journal', { text: `Created ${character.name}` }, { characterId: id });
  draw();
}

async function deleteCharacter(c) {
  if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
  await db.del('characters', c.id);
  const characters = await db.list('characters');
  setState({ characters });
  await selectCharacter(characters[0]?.id || null);
  toast(`Deleted ${c.name}`);
  draw();
}

function exportCharacter() {
  const { character } = getState();
  const blob = new Blob([JSON.stringify(character, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `${(character.name || 'character').replace(/\W+/g, '-').toLowerCase()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported character JSON');
}

function importCharacter() {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      data.id = data.id || `ch-${Date.now().toString(36)}`;
      await db.put('characters', data);
      setState({ characters: await db.list('characters') });
      await selectCharacter(data.id);
      toast(`Imported ${data.name || 'character'}`, 'ok');
      draw();
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'bad');
    }
  });
  input.click();
}

/* ------------------------------------------------------------------ */
/* identity                                                            */
/* ------------------------------------------------------------------ */

function identityPanel(ch, compendium, homebrew) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Identity'));
  panel.append(el('h3', {}, 'Who they are'));

  const grid = el('div', { class: 'grid two' });

  grid.append(field('Name', el('input', {
    type: 'text', value: ch.name || '',
    onChange: (e) => update({ name: e.target.value }),
  })));

  grid.append(field('Species', picker(
    compendium.species || [], ch.species,
    (v) => update({ species: v }),
  )));

  grid.append(field('Background', picker(
    compendium.backgrounds || [], ch.background,
    (v) => update({ background: v }),
  )));

  const src = getState().dataSource;
  grid.append(field('Campaign', el('input', {
    type: 'text', value: ch.campaignId || '', placeholder: 'e.g. curse-of-strahd',
    onChange: (e) => update({ campaignId: e.target.value || null }),
  })));

  panel.append(grid);
  panel.append(el('div', { class: 'rule' }));

  // --- classes
  panel.append(el('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, 'Classes'));
  for (const [i, entry] of (ch.classes || []).entries()) {
    panel.append(classRow(entry, i, compendium, homebrew));
  }
  panel.append(el('button', {
    class: 'act ghost small', style: 'margin-top:8px',
    onClick: () => update((c) => {
      c.classes.push({ class: 'fighter', subclass: null, level: 1 });
      return c;
    }),
  }, '+ Multiclass'));

  return panel;
}

function classRow(entry, index, compendium, homebrew) {
  const row = el('div', {
    style: 'display:grid;grid-template-columns:1fr 1fr 90px auto;gap:8px;'
         + 'align-items:end;margin-bottom:8px',
  });

  const classes = compendium.classes || [];
  row.append(field('Class', picker(classes, String(entry.class).toLowerCase(),
    (v) => update((c) => { c.classes[index].class = v; c.classes[index].subclass = null; return c; }))));

  // SRD subclasses for this class, plus any ingested homebrew that targets it.
  const cls = classes.find((c) => c.id === String(entry.class).toLowerCase());
  const srdSubs = (cls?.subclasses || []).map((s) => ({ id: s.id, name: s.name }));
  const brewSubs = (homebrew || [])
    .filter((h) => h.kind === 'subclass'
      && String(h.class || '').toLowerCase() === String(entry.class).toLowerCase())
    .map((h) => ({ id: h.id, name: `${h.name} (homebrew)` }));
  const subs = [...srdSubs, ...brewSubs];

  row.append(field('Subclass', picker(subs, entry.subclass,
    (v) => update((c) => { c.classes[index].subclass = v || null; return c; }),
    subs.length ? 'Choose...' : 'None available')));

  row.append(field('Level', el('input', {
    type: 'number', min: '1', max: '20', value: String(entry.level || 1),
    onChange: (e) => {
      const level = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1));
      const before = totalLevel(getState().character);
      update((c) => { c.classes[index].level = level; return c; }).then((next) => {
        const after = totalLevel(next);
        if (after > before) {
          log('level_up', { level: after, class: entry.class });
        }
      });
    },
  })));

  row.append(el('button', {
    class: 'act ghost small',
    disabled: (getState().character.classes || []).length < 2,
    onClick: () => update((c) => { c.classes.splice(index, 1); return c; }),
  }, 'Remove'));

  return row;
}

/* ------------------------------------------------------------------ */
/* abilities                                                           */
/* ------------------------------------------------------------------ */

function abilitiesPanel(ch) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Abilities'));
  panel.append(el('h3', {}, 'Ability scores'));

  const method = ch.abilityMethod || 'pointbuy';
  const methods = el('div', { class: 'btnrow', style: 'margin-bottom:14px' });
  for (const [key, label] of Object.entries({
    pointbuy: 'Point buy', array: 'Standard array', roll: 'Roll 4d6', manual: 'Manual',
  })) {
    methods.append(el('button', {
      class: `act ${method === key ? '' : 'ghost'} small`,
      onClick: () => update({ abilityMethod: key }),
    }, label));
  }
  panel.append(methods);

  if (method === 'pointbuy') {
    const { spent, over, outOfRange } = pointBuySpend(ch.abilities);
    panel.append(el('p', { class: 'mono', style: `color:${over ? 'var(--bad)' : 'var(--muted)'}` },
      `${spent} / ${POINT_BUY_BUDGET} points spent${over ? ' - over budget' : ''}`));
    if (outOfRange.length) {
      // Scores that predate enforcement (rolled, imported, manual). Named,
      // not silently priced at zero - and never auto-rewritten.
      panel.append(el('p', { class: 'mono', style: 'color:var(--warn);font-size:12px' },
        `Outside point buy's 8-15: ${outOfRange.map((a) => a.toUpperCase())
          .join(', ')} - bring them into range, or Manual keeps them.`));
    }
  }

  if (method === 'array') {
    panel.append(el('p', { class: 'muted' },
      `Assign ${STANDARD_ARRAY.join(', ')} across the six abilities.`));
    panel.append(el('div', { class: 'btnrow', style: 'margin-bottom:10px' },
      el('button', {
        class: 'act ghost small',
        title: '15 to Strength down through 8 to Charisma - a starting point',
        onClick: () => update((c) => {
          ABILITIES.forEach((a, i) => { c.abilities[a] = STANDARD_ARRAY[i]; });
          return c;
        }),
      }, 'Assign in order')));
  }

  if (method === 'roll') {
    panel.append(el('button', {
      class: 'act ghost small', style: 'margin-bottom:12px',
      onClick: () => {
        const rolls = rollAbilityScores();
        toast(`Rolled: ${rolls.map((r) => r.total).join(', ')}`);
        update((c) => {
          ABILITIES.forEach((a, i) => { c.abilities[a] = rolls[i].total; });
          return c;
        });
      },
    }, 'Roll 4d6 drop lowest'));
  }

  const grid = el('div', { class: 'grid stats' });
  const assign = method === 'array' ? arrayAssignment(ch.abilities) : null;
  for (const ab of ABILITIES) {
    const score = ch.abilities?.[ab] ?? 10;
    const bonus = ch.abilityBonuses?.[ab] ?? 0;
    const total = score + bonus;
    const cell = el('div', { class: 'stat' });
    cell.append(el('div', { class: 'k' }, ABILITY_NAMES[ab]));

    if (method === 'array') {
      // The array is a multiset: each value assignable once. The select
      // offers only what remains (plus the current value), so duplicates
      // cannot be CREATED here - pre-existing ones show red, never
      // auto-rewritten.
      const sel = el('select', {
        'aria-label': `${ABILITY_NAMES[ab]} assigned value`,
        style: 'font-family:var(--display);font-size:20px;text-align:center;'
          + 'padding:4px;width:100%',
      });
      const offered = [...new Set([score, ...assign.remaining])]
        .sort((a, b) => b - a);
      for (const v of offered) {
        sel.append(el('option', { value: String(v), selected: v === score },
          String(v)));
      }
      if (assign.duplicates.includes(ab) || assign.unassigned.includes(ab)) {
        sel.style.color = 'var(--bad)';
        sel.title = 'Not available from the standard array';
      }
      sel.addEventListener('change', () => {
        update((c) => { c.abilities[ab] = Number(sel.value); return c; });
      });
      cell.append(sel);
    } else {
      const isPB = method === 'pointbuy';
      cell.append(el('input', {
        type: 'number', min: isPB ? '8' : '1', max: isPB ? '15' : '30',
        value: String(score),
        'aria-label': `${ABILITY_NAMES[ab]} score`,
        style: 'font-family:var(--display);font-size:22px;text-align:center;padding:4px',
        onChange: (e) => {
          let v = parseInt(e.target.value, 10);
          if (!Number.isFinite(v)) v = score;
          if (isPB) {
            // Enforce, don't advise: out-of-range and over-budget changes
            // revert. Manual is the named escape hatch.
            if (v < 8 || v > 15) {
              toast("Point buy runs 8-15 - Manual keeps anything.", 'warn');
              e.target.value = String(score);
              return;
            }
            const check = pointBuySpend({ ...ch.abilities, [ab]: v });
            if (check.spent > POINT_BUY_BUDGET) {
              toast(`That would spend ${check.spent} of ${POINT_BUY_BUDGET} points`, 'warn');
              e.target.value = String(score);
              return;
            }
          }
          v = Math.max(1, Math.min(30, v));
          update((c) => { c.abilities[ab] = v; return c; });
        },
      }));
    }

    cell.append(el('div', { class: 'sub' },
      `${sign(abilityMod(total))}${bonus ? ` (${sign(bonus)} bonus)` : ''}`));
    grid.append(cell);
  }
  panel.append(grid);

  // Species/background ASI go here rather than being baked into the score.
  panel.append(el('label', { class: 'field' }, 'Bonuses from origin (comma list, e.g. dex+2, con+1)'));
  panel.append(el('input', {
    type: 'text',
    value: Object.entries(ch.abilityBonuses || {})
      .filter(([, v]) => v).map(([k, v]) => `${k}+${v}`).join(', '),
    placeholder: 'dex+2, con+1',
    onChange: (e) => {
      const bonuses = {};
      for (const part of e.target.value.split(/[,;]/)) {
        const m = /([a-z]{3})\s*\+?\s*(-?\d+)/i.exec(part.trim());
        if (m && ABILITIES.includes(m[1].toLowerCase())) {
          bonuses[m[1].toLowerCase()] = parseInt(m[2], 10);
        }
      }
      update({ abilityBonuses: bonuses });
    },
  }));

  return panel;
}

/* ------------------------------------------------------------------ */
/* skills                                                              */
/* ------------------------------------------------------------------ */

function skillsPanel(ch, compendium) {
  const panel = el('div', { class: 'panel rivets' });
  panel.append(el('span', { class: 'lvl' }, 'Proficiencies'));
  panel.append(el('h3', {}, 'Skills'));

  const cls = (compendium.classes || [])
    .find((c) => c.id === String(ch.classes?.[0]?.class).toLowerCase());
  if (cls?.skillChoices) {
    panel.append(el('p', { class: 'muted' }, cls.skillChoices));
  }

  const pb = proficiencyBonus(totalLevel(ch));
  const chosen = new Set((ch.skills || []).map((s) => s.toLowerCase()));
  const expert = new Set((ch.expertise || []).map((s) => s.toLowerCase()));

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px',
  });
  for (const [skill, ab] of Object.entries(SKILLS)) {
    const prof = chosen.has(skill);
    const exp = expert.has(skill);
    const mod = abilityMod((ch.abilities?.[ab] || 10) + (ch.abilityBonuses?.[ab] || 0))
      + (exp ? pb * 2 : prof ? pb : 0);
    const row = el('label', {
      style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer',
    });
    row.append(el('input', {
      type: 'checkbox', checked: prof, style: 'width:auto;margin:0',
      onChange: () => update((c) => {
        const set = new Set((c.skills || []).map((s) => s.toLowerCase()));
        if (set.has(skill)) set.delete(skill); else set.add(skill);
        c.skills = [...set];
        return c;
      }),
    }));
    row.append(el('span', { style: 'flex:1;font-size:14px' }, cap(skill)));
    row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
      `${ab.toUpperCase()} ${sign(mod)}`));
    if (prof) {
      row.append(el('button', {
        class: 'act ghost small', style: 'padding:2px 6px;font-size:9px',
        title: 'Toggle expertise',
        onClick: (e) => {
          e.preventDefault();
          update((c) => {
            const set = new Set((c.expertise || []).map((s) => s.toLowerCase()));
            if (set.has(skill)) set.delete(skill); else set.add(skill);
            c.expertise = [...set];
            return c;
          });
        },
      }, exp ? 'EXP' : '+'));
    }
    grid.append(row);
  }
  panel.append(grid);
  return panel;
}

/* ------------------------------------------------------------------ */
/* features preview                                                    */
/* ------------------------------------------------------------------ */

function featuresPanel() {
  const { derived } = getState();
  const panel = el('div', { class: 'panel rivets accent' });
  panel.append(el('span', { class: 'lvl accent' }, 'Resolved'));
  panel.append(el('h3', {}, 'What this build actually gives you'));

  if (!derived) {
    panel.append(el('p', { class: 'muted' }, 'Nothing derived yet.'));
    return panel;
  }

  const stats = el('div', { class: 'grid stats' });
  const add = (k, v, sub) => {
    const s = el('div', { class: 'stat' });
    s.append(el('div', { class: 'k' }, k));
    s.append(el('div', { class: 'v' }, String(v)));
    if (sub) s.append(el('div', { class: 'sub' }, sub));
    stats.append(s);
  };
  add('AC', derived.ac, derived.acSource);
  add('Initiative', sign(derived.initiative));
  add('Prof', sign(derived.proficiencyBonus));
  add('Passive Perc', derived.passivePerception);
  if (derived.spellcasting) {
    add('Spell DC', derived.spellcasting.saveDc,
      derived.spellcasting.ability.toUpperCase());
  }
  add('Speed', `${derived.speeds.walk} ft`);
  panel.append(stats);

  if (derived.features.length) {
    panel.append(el('div', { class: 'rule' }));
    const list = el('div', { class: 'scroll-x' });
    const table = el('table');
    table.innerHTML = '<tr><th>Level</th><th>Feature</th><th>From</th><th>Mechanics</th></tr>';
    for (const f of derived.features.slice(0, 60)) {
      const mapped = (f.effects || []).filter((e) => e.type !== 'narrative_only').length;
      const tr = el('tr');
      tr.append(el('td', { class: 'mono' }, String(f.level)));
      tr.append(el('td', {}, f.name));
      tr.append(el('td', { class: 'muted', style: 'font-size:13px' }, f.origin));
      tr.append(el('td', {}, mapped
        ? el('span', { class: 'chip ok' }, `${mapped} live`)
        : el('span', { class: 'chip' }, 'text')));
      table.append(tr);
    }
    list.append(table);
    panel.append(list);
  }

  panel.append(el('div', { class: 'btnrow' },
    el('button', { class: 'act', onClick: () => go('sheet') }, 'Open the sheet')));
  return panel;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function field(label, control) {
  const wrap = el('div');
  wrap.append(el('label', { class: 'field' }, label));
  wrap.append(control);
  return wrap;
}

function picker(items, value, onChange, placeholder = 'None') {
  const sel = el('select', { onChange: (e) => onChange(e.target.value || null) });
  sel.append(el('option', { value: '' }, placeholder));
  for (const it of items) {
    sel.append(el('option', {
      value: it.id, selected: it.id === value,
    }, it.name));
  }
  return sel;
}

async function update(patch) {
  const next = await saveCharacter(patch);
  draw();
  return next;
}
