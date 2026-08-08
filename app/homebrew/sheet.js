/**
 * Character sheet for a subclass at a chosen level.
 *
 * Every number comes from derive.js - the same engine the live Play mode uses -
 * so the printed sheet and the in-app sheet can never disagree. Nothing here
 * recomputes AC or attack bonuses independently; that would be a second rules
 * engine and a second set of bugs.
 */

import { derive } from '../core/derive.js';
import {
  ABILITIES, ABILITY_NAMES, abilityMod, proficiencyBonus,
} from '../core/rules2024.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;

/** Standard array assigned by the class's usual priority. */
const PRIORITY = {
  barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  bard: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
  cleric: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
  druid: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
  fighter: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  monk: ['dex', 'wis', 'con', 'str', 'cha', 'int'],
  paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
  ranger: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  rogue: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
  sorcerer: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  warlock: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  wizard: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
};
const ARRAY = [15, 14, 13, 12, 10, 8];

/** Build a representative character of this subclass at `level`. */
export function sampleCharacter(brew, level, sources, opts = {}) {
  const priority = PRIORITY[brew.class] || PRIORITY.fighter;
  const abilities = {};
  priority.forEach((ab, i) => { abilities[ab] = ARRAY[i]; });

  const cls = (sources.classes || []).find((c) => c.id === brew.class);
  const hitDie = cls?.hitDie || 8;
  const con = abilityMod(abilities.con);
  const perLevel = Math.floor(hitDie / 2) + 1 + con;
  const maxHp = hitDie + con + perLevel * (level - 1);

  return {
    id: `sheet-${brew.id}`,
    name: opts.name || `${brew.name} (level ${level})`,
    ruleset: brew.ruleset || '2024',
    classes: [{ class: brew.class, subclass: brew.id, level }],
    abilities,
    skills: (cls?.savingThrows || []).slice(0, 2),
    feats: [],
    hp: { max: maxHp, current: maxHp, temp: 0 },
    hitDice: { die: hitDie, remaining: level },
    inventory: opts.inventory || [],
    currency: {},
    spells: { prepared: [], known: [] },
    slotState: {}, resourceState: {}, toggles: {},
    conditions: [], exhaustion: 0,
    deathSaves: { successes: 0, failures: 0 },
  };
}

/** Derived sheet data, ready to render in any format. */
export function sheetData(brew, level, sources) {
  const withBrew = {
    ...sources,
    homebrew: [...(sources.homebrew || []).filter((h) => h.id !== brew.id), brew],
  };
  const ch = sampleCharacter(brew, level, sources);
  const d = derive(ch, withBrew);
  return { character: ch, derived: d, brew, level };
}

/* ------------------------------------------------------------------ */

const SHEET_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1c2124;font-family:Georgia,serif;font-size:14px;line-height:1.45}
.sheet{max-width:820px;margin:0 auto;padding:26px}
h1,h2{font-family:'Arial Black',Impact,sans-serif;text-transform:uppercase;margin:0;letter-spacing:-.01em}
h1{font-size:30px;border-bottom:5px solid #1c2124;padding-bottom:7px}
h2{font-size:14px;color:#b84a16;margin:20px 0 8px;letter-spacing:.06em}
.sub{font-family:Consolas,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#3a4247;margin-top:6px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.box{border:2px solid #1c2124;border-radius:2px;padding:8px 10px;text-align:center;min-width:74px;flex:1}
.box .k{font-family:Consolas,monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#3a4247}
.box .v{font-family:'Arial Black',sans-serif;font-size:21px;line-height:1.1}
.box .s{font-family:Consolas,monospace;font-size:10px;color:#3a4247}
table{width:100%;border-collapse:collapse;margin-bottom:10px}
th,td{text-align:left;padding:5px 7px;border-bottom:1px solid #d7dbd8;font-size:13px}
th{font-family:Consolas,monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#3a4247}
.mono{font-family:Consolas,monospace}
.feat{border-left:3px solid #b84a16;padding:5px 0 5px 10px;margin-bottom:9px}
.feat .n{font-weight:700}
.feat .l{font-family:Consolas,monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#3a4247}
.slots{display:flex;gap:5px;flex-wrap:wrap}
.slot{border:1.5px solid #1c2124;width:26px;height:26px;border-radius:2px;
 font-family:Consolas,monospace;font-size:10px;display:flex;align-items:center;justify-content:center}
.note{font-size:11px;color:#3a4247;font-family:Consolas,monospace}
@media print{.sheet{padding:0}@page{margin:12mm}}
`;

/** Printable HTML character sheet. */
export function sheetHtml(brew, level, sources) {
  const { derived: d } = sheetData(brew, level, sources);
  const sc = d.spellcasting;

  const abilityBoxes = ABILITIES.map((ab) => `<div class="box">
    <div class="k">${ABILITY_NAMES[ab].slice(0, 3)}</div>
    <div class="v">${d.abilities[ab]}</div>
    <div class="s">${sign(d.mods[ab])} / sv ${sign(d.saves[ab].mod)}</div></div>`).join('');

  const attacks = d.attacks.map((a) => `<tr>
    <td>${esc(a.name)}${a.magical ? ' ✦' : ''}</td>
    <td class="mono">${sign(a.attackBonus)}</td>
    <td class="mono">${esc(a.damage)}${a.damageBonus ? sign(a.damageBonus) : ''} ${
      esc((a.damageTypes || []).join('/'))}</td>
    <td class="mono">${esc(a.mastery || '—')}</td></tr>`).join('');

  const resources = d.resources.length ? `<h2>Resources</h2><table>
    <tr><th>Pool</th><th>Max</th><th>Recharge</th><th>Track</th></tr>
    ${d.resources.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.max}</td>
      <td class="mono">${esc(r.recharge)}</td>
      <td class="slots">${Array.from({ length: Math.min(r.max, 12) },
    () => '<span class="slot"></span>').join('')}</td></tr>`).join('')}
  </table>` : '';

  const slots = sc?.slots?.length ? `<h2>Spell slots</h2><table>
    ${sc.slots.map((n, i) => `<tr><td class="mono">Level ${i + 1}</td>
      <td class="slots">${Array.from({ length: n },
    () => '<span class="slot"></span>').join('')}</td></tr>`).join('')}
  </table>` : '';

  const prepared = sc?.alwaysPrepared?.length ? `<h2>Always prepared</h2>
    <p>${sc.alwaysPrepared.map((s) => esc(s.name)).join(' · ')}</p>` : '';

  const toggles = d.toggles.length ? `<h2>Stances</h2>
    ${d.toggles.map((t) => `<p><strong>${esc(t.name)}:</strong>
      ${(t.options || []).map((o) => esc(o.label)).join(' / ')}
      <span class="note">(switchable)</span></p>`).join('')}` : '';

  const tables = (brew.rollTables || []).map((t) => `<h2>${esc(t.name)} (${esc(t.die)})</h2>
    <table>${t.entries.map((e) => `<tr><td class="mono" style="width:34px">${e.n}</td>
      <td>${esc(e.text)}</td></tr>`).join('')}</table>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(brew.name)} — level ${level} sheet</title><style>${SHEET_CSS}</style></head>
<body><div class="sheet">
<h1>${esc(brew.name)}</h1>
<div class="sub">${esc(brew.class || '')} · level ${level} · ${esc(brew.ruleset || '2024')}
  ${brew.source?.document ? `· ${esc(brew.source.document)}` : ''}</div>

<h2>Abilities</h2><div class="row">${abilityBoxes}</div>

<h2>Defence &amp; core</h2><div class="row">
  <div class="box"><div class="k">AC</div><div class="v">${d.ac}</div>
    <div class="s">${esc(d.acSource)}</div></div>
  <div class="box"><div class="k">HP</div><div class="v">${d.hp.max}</div>
    <div class="s">d${d.hitDice.die} hit dice</div></div>
  <div class="box"><div class="k">Init</div><div class="v">${sign(d.initiative)}</div></div>
  <div class="box"><div class="k">Speed</div><div class="v">${d.speeds.walk}</div>
    <div class="s">feet</div></div>
  <div class="box"><div class="k">Prof</div><div class="v">${sign(d.proficiencyBonus)}</div></div>
  <div class="box"><div class="k">Passive</div><div class="v">${d.passivePerception}</div>
    <div class="s">perception</div></div>
  ${sc ? `<div class="box"><div class="k">Spell DC</div><div class="v">${sc.saveDc}</div>
    <div class="s">${esc(sc.ability.toUpperCase())} ${sign(sc.attackBonus)} atk</div></div>` : ''}
</div>

${Object.keys(d.substitutions).length ? `<p class="note">Ability substitution: ${
  Object.entries(d.substitutions).map(([scope, s]) =>
    `${s.with.toUpperCase()} replaces ${s.replace.toUpperCase()} for ${scope}`).join('; ')}</p>` : ''}

<h2>Attacks</h2><table>
  <tr><th>Attack</th><th>Bonus</th><th>Damage</th><th>Mastery</th></tr>${attacks}</table>

${d.damageRiders.length ? `<p class="note">Riders: ${d.damageRiders.map((r) =>
    `+${esc(r.dice)} ${esc(r.damageType || '')} on ${esc(r.trigger)}`).join(' · ')}</p>` : ''}

${resources}${slots}${prepared}${toggles}

${d.actions.length ? `<h2>Actions</h2><table>
  <tr><th>Name</th><th>Action</th><th>Cost</th></tr>
  ${d.actions.map((a) => `<tr><td>${esc(a.name)}</td><td class="mono">${esc(a.action)}</td>
    <td class="mono">${a.cost ? `${a.cost.amount} ${esc(a.cost.resource)}` : '—'}</td></tr>`).join('')}
</table>` : ''}

<h2>Features</h2>
${d.features.filter((f) => /^(?!.*(Ability Score|Epic Boon))/.test(f.name))
    .map((f) => `<div class="feat"><div class="l">Level ${f.level} · ${esc(f.origin)}</div>
      <div class="n">${esc(f.name)}</div></div>`).join('')}

${tables}

<p class="note" style="margin-top:22px">
Generated by Toon Anvil from the same derivation engine the app plays with.
${brew.source?.licenseUrl ? `Source licence: ${esc(brew.source.licenseUrl)}` : ''}</p>
</div></body></html>`;
}

/** Compact JSON the PDF writer consumes. */
export function sheetJson(brew, level, sources) {
  const { derived: d } = sheetData(brew, level, sources);
  return {
    name: brew.name, class: brew.class, level,
    ruleset: brew.ruleset, source: brew.source || null,
    ac: d.ac, acSource: d.acSource, hp: d.hp.max, hitDie: d.hitDice.die,
    initiative: d.initiative, speed: d.speeds.walk,
    proficiencyBonus: d.proficiencyBonus, passivePerception: d.passivePerception,
    abilities: Object.fromEntries(ABILITIES.map((a) => [a, {
      score: d.abilities[a], mod: d.mods[a], save: d.saves[a].mod,
    }])),
    substitutions: d.substitutions,
    attacks: d.attacks.map((a) => ({
      name: a.name, bonus: a.attackBonus, damage: a.damage,
      damageBonus: a.damageBonus, types: a.damageTypes, mastery: a.mastery || null,
    })),
    riders: d.damageRiders.map((r) => ({
      dice: r.dice, type: r.damageType, trigger: r.trigger,
    })),
    resources: d.resources.map((r) => ({ name: r.name, max: r.max, recharge: r.recharge })),
    spellcasting: d.spellcasting ? {
      ability: d.spellcasting.ability, saveDc: d.spellcasting.saveDc,
      attackBonus: d.spellcasting.attackBonus, slots: d.spellcasting.slots,
      alwaysPrepared: d.spellcasting.alwaysPrepared.map((s) => s.name),
    } : null,
    actions: d.actions.map((a) => ({
      name: a.name, action: a.action,
      cost: a.cost ? `${a.cost.amount} ${a.cost.resource}` : null,
    })),
    toggles: d.toggles.map((t) => ({
      name: t.name, options: (t.options || []).map((o) => o.label),
    })),
    features: d.features.map((f) => ({ name: f.name, level: f.level, origin: f.origin })),
    rollTables: (brew.rollTables || []).map((t) => ({
      name: t.name, die: t.die, entries: t.entries,
    })),
  };
}

export function downloadSheet(brew, level, sources) {
  const html = sheetHtml(brew, level, sources);
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${brew.id}-level-${level}-sheet.html`;
  a.click();
  URL.revokeObjectURL(a.href);
  return html;
}
