/**
 * Parsers for the content kinds that are not subclasses.
 *
 * tools/split_pdf.py already pulls monsters, magic items and spells out of a
 * dropped PDF, but it emits raw {title, text} blocks and nothing consumed
 * them. These turn that text into records shaped exactly like the compendium's
 * own, so everything downstream - the bestiary, the encounter runner, the
 * simulator - needs no idea where a record came from.
 *
 * A statblock is far more tractable than subclass prose: it carries fixed
 * labels (Armor Class, Hit Points, Challenge) in a conventional order. So
 * unlike the subclass mapper, which guesses at meaning, this is genuine
 * parsing - and it is testable against the 330 monsters already bundled by
 * rendering one to text and reading it back.
 *
 * Every parser returns { ok, record, coverage, parsed, missing, warnings }.
 * `coverage` is the fraction of expected fields actually found, and `missing`
 * names them. A parser that quietly returns a half-empty record is worse than
 * one that refuses, because the gap only surfaces mid-session.
 */

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const slug = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const clean = (s) => String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();

/** "1/4" -> 0.25, "5" -> 5, "—" -> null. */
export function parseCr(raw) {
  const s = clean(raw).replace(/^cr\s*/i, '');
  if (!s || /^[-—–]$/.test(s)) return null;
  const frac = /^(\d+)\s*\/\s*(\d+)/.exec(s);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = /^(\d+(?:\.\d+)?)/.exec(s);
  return n ? Number(n[1]) : null;
}

/** Number out of "15 (natural armor)" or "AC 15". */
const firstInt = (s) => {
  const m = /-?\d+/.exec(String(s ?? ''));
  return m ? Number(m[0]) : null;
};

/**
 * Find a labelled line's value.
 *
 * Statblocks put the label at the start of a line, but PDF extraction often
 * runs several onto one line, so this deliberately does not anchor to line
 * starts - it stops at the next known label instead.
 */
const LABELS = [
  'armor class', 'ac', 'hit points', 'hp', 'speed', 'initiative',
  'skills', 'senses', 'languages', 'challenge', 'cr', 'proficiency bonus', 'pb',
  'damage resistances', 'resistances', 'damage immunities', 'immunities',
  'damage vulnerabilities', 'vulnerabilities', 'condition immunities',
  'saving throws', 'saves', 'gear', 'traits', 'actions', 'bonus actions',
  'reactions', 'legendary actions',
];

function labelled(text, ...names) {
  const others = LABELS.filter((l) => !names.includes(l))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `\\b${esc}\\b\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${others})\\b|\\n\\s*\\n|$)`,
      'i',
    );
    const m = re.exec(text);
    if (m && clean(m[1])) return clean(m[1]).split('\n')[0].trim();
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* monsters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Render a monster to conventional statblock text.
 *
 * Exists so the parser can be tested against real data rather than a handful
 * of hand-written fixtures: render each of the 330 bundled monsters, read it
 * back, and the numbers must match. A fixture proves the parser handles the
 * fixture; this proves it handles the corpus.
 */
export function renderStatblock(m) {
  const lines = [];
  lines.push(m.name);
  lines.push(`${m.size || ''} ${m.type || ''}${m.tags ? ` (${m.tags})` : ''}`
    + `${m.alignment ? `, ${m.alignment}` : ''}`.trim());
  lines.push(`Armor Class ${m.ac}`);
  lines.push(`Hit Points ${m.hp}${m.hitDice ? ` (${m.hitDice})` : ''}`);
  lines.push(`Speed ${m.speed || '30 ft.'}`);

  for (const k of ABILITY_KEYS) {
    const a = m.abilities?.[k];
    if (!a) continue;
    const mod = a.mod >= 0 ? `+${a.mod}` : `${a.mod}`;
    const save = a.save >= 0 ? `+${a.save}` : `${a.save}`;
    lines.push(`${k.toUpperCase()} ${a.score} ${mod} ${save}`);
  }

  if (m.skills) lines.push(`Skills ${m.skills}`);
  if (m.resistances) lines.push(`Damage Resistances ${m.resistances}`);
  if (m.immunities) lines.push(`Damage Immunities ${m.immunities}`);
  if (m.vulnerabilities) lines.push(`Damage Vulnerabilities ${m.vulnerabilities}`);
  if (m.senses) lines.push(`Senses ${m.senses}`);
  if (m.languages) lines.push(`Languages ${m.languages}`);
  if (m.gear) lines.push(`Gear ${m.gear}`);
  lines.push(`Challenge ${m.crText || m.cr} (XP ${m.xp || 0}; PB +${m.pb || 2})`);

  for (const [heading, list] of [
    ['Traits', m.traits], ['Actions', m.actions],
    ['Bonus Actions', m.bonusActions], ['Reactions', m.reactions],
    ['Legendary Actions', m.legendaryActions]]) {
    if (!list?.length) continue;
    lines.push('');
    lines.push(heading);
    for (const a of list) lines.push(`${a.name}. ${a.text}`);
  }
  return lines.join('\n');
}

const SECTIONS = [
  ['traits', /^\s*traits\s*$/im],
  ['actions', /^\s*actions\s*$/im],
  ['bonusActions', /^\s*bonus actions\s*$/im],
  ['reactions', /^\s*reactions\s*$/im],
  ['legendaryActions', /^\s*legendary actions\s*$/im],
];

/**
 * Does this read as an action NAME rather than the first sentence of one?
 *
 * Word count is the obvious test and the wrong one: it rejected "Hand Crossbow
 * (Humanoid or Hybrid Form Only)" at seven words while happily accepting "The
 * target is cursed" at four. Title Case is the real signal - action names are
 * capitalised, sentences are not. Parenthesised qualifiers are ignored, and a
 * short list of connectives is allowed to stay lowercase.
 */
const CONNECTIVES = new Set(['or', 'and', 'of', 'the', 'a', 'an', 'in', 'on',
  'to', 'by', 'with', 'for', 'form', 'only']);

function looksLikeEntryName(s) {
  const bare = s.replace(/\([^)]*\)/g, ' ').trim();
  if (!bare || bare.length > 60) return false;
  const words = bare.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  return words.every((w) => CONNECTIVES.has(w.toLowerCase()) || /^[A-Z0-9]/.test(w));
}

/** Split "Name. Text" entries out of a section body. */
function parseEntries(body) {
  const out = [];
  const lines = clean(body).split('\n').map((l) => l.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    const m = /^([A-Z][^.]{0,58})\.\s*(.*)$/.exec(line);
    if (m && looksLikeEntryName(m[1])) {
      if (current) out.push(current);
      current = { name: m[1].trim(), text: m[2].trim() };
    } else if (current) {
      // A wrapped line belongs to the entry above it.
      current.text = `${current.text} ${line}`.trim();
    }
  }
  if (current) out.push(current);
  return out;
}

export function parseStatblock(text, meta = {}) {
  const src = String(text || '').replace(/\r/g, '');
  const warnings = [];
  const missing = [];

  // Name: the caller usually has a better one (the block title) than the text.
  const firstLine = src.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const name = clean(meta.name || firstLine) || 'Unnamed creature';

  const ac = firstInt(labelled(src, 'armor class', 'ac'));
  const hpRaw = labelled(src, 'hit points', 'hp');
  const hp = firstInt(hpRaw);
  const hitDice = hpRaw ? (/\(([^)]*d[^)]*)\)/.exec(hpRaw)?.[1] || null) : null;
  const speed = labelled(src, 'speed');

  // Abilities: "STR 8 -1 -1", or a grid where scores and mods are on
  // separate lines. The per-line form is tried first because it is
  // unambiguous; the grid is a fallback with a warning.
  const abilities = {};
  for (const k of ABILITY_KEYS) {
    const re = new RegExp(`\\b${k}\\b[^\\dA-Za-z+-]{0,4}(\\d{1,2})\\s*([+-]\\s*\\d+)?\\s*([+-]\\s*\\d+)?`, 'i');
    const m = re.exec(src);
    if (!m) continue;
    const score = Number(m[1]);
    const mod = m[2] !== undefined && m[2] !== null
      ? Number(String(m[2]).replace(/\s+/g, ''))
      : Math.floor((score - 10) / 2);
    const save = m[3] !== undefined && m[3] !== null
      ? Number(String(m[3]).replace(/\s+/g, '')) : mod;
    abilities[k] = { score, mod, save };
  }
  const gotAbilities = Object.keys(abilities).length;
  if (gotAbilities && gotAbilities < 6) {
    warnings.push(`only ${gotAbilities} of 6 ability scores were found`);
  }

  const crText = labelled(src, 'challenge', 'cr');
  const cr = parseCr(crText);
  const xp = crText ? firstInt(/XP\s*([\d,]+)/i.exec(crText)?.[1]) : null;
  const pbMatch = crText ? /PB\s*\+?(\d+)/i.exec(crText) : null;

  const typeLine = src.split('\n')[1] || '';
  const typeMatch = /(tiny|small|medium|large|huge|gargantuan)\s+([a-z]+)/i.exec(typeLine);

  const record = {
    id: slug(name),
    name,
    size: typeMatch ? cap(typeMatch[1]) : null,
    type: typeMatch ? typeMatch[2].toLowerCase() : null,
    tags: /\(([^)]+)\)/.exec(typeLine)?.[1] || null,
    alignment: /,\s*([A-Za-z ]+)$/.exec(clean(typeLine))?.[1] || null,
    ac,
    hp,
    hitDice,
    speed,
    abilities,
    skills: labelled(src, 'skills'),
    senses: labelled(src, 'senses'),
    languages: labelled(src, 'languages'),
    resistances: labelled(src, 'damage resistances', 'resistances'),
    immunities: labelled(src, 'damage immunities', 'immunities'),
    vulnerabilities: labelled(src, 'damage vulnerabilities', 'vulnerabilities'),
    gear: labelled(src, 'gear'),
    cr,
    crText: crText ? clean(crText).split(/\s*\(/)[0] : null,
    xp,
    pb: pbMatch ? Number(pbMatch[1]) : null,
    traits: [], actions: [], bonusActions: [], reactions: [], legendaryActions: [],
    source: meta.source || null,
    custom: true,
  };

  // Sections, in the order they appear.
  const found = SECTIONS
    .map(([key, re]) => ({ key, at: re.exec(src)?.index ?? -1, re }))
    .filter((s) => s.at >= 0)
    .sort((a, b) => a.at - b.at);
  for (const [i, s] of found.entries()) {
    const start = s.at + (s.re.exec(src)?.[0].length || 0);
    const end = i + 1 < found.length ? found[i + 1].at : src.length;
    record[s.key] = parseEntries(src.slice(start, end));
  }

  // Coverage: the fields that make a statblock usable, not every field.
  const REQUIRED = { ac, hp, speed, cr, abilities: gotAbilities === 6 ? 1 : null };
  for (const [k, v] of Object.entries(REQUIRED)) {
    if (v === null || v === undefined) missing.push(k);
  }
  const coverage = (Object.keys(REQUIRED).length - missing.length)
    / Object.keys(REQUIRED).length;

  return {
    ok: ac !== null && hp !== null && gotAbilities >= 4,
    kind: 'monster',
    record,
    coverage,
    missing,
    warnings,
  };
}

const cap = (s) => String(s || '').replace(/^./, (ch) => ch.toUpperCase());

/* ------------------------------------------------------------------ */
/* magic items                                                         */
/* ------------------------------------------------------------------ */

const RARITIES = ['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact'];

export function parseMagicItem(text, meta = {}) {
  const src = String(text || '').replace(/\r/g, '');
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const name = clean(meta.name || lines[0] || 'Unnamed item');
  const missing = [];

  // The type line: "Wondrous item, rare (requires attunement by a wizard)".
  const typeLine = lines.slice(0, 4)
    .find((l) => RARITIES.some((r) => l.toLowerCase().includes(r))) || '';

  const rarity = RARITIES
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((r) => typeLine.toLowerCase().includes(r)) || null;

  const attuneMatch = /requires attunement(?:\s+by\s+([^)]+))?/i.exec(src);

  const kind = typeLine
    ? cap(clean(typeLine.split(',')[0])) : null;

  if (!rarity) missing.push('rarity');
  if (!kind) missing.push('kind');

  const body = lines.slice(typeLine ? lines.indexOf(typeLine) + 1 : 1).join('\n');
  if (!clean(body)) missing.push('description');

  const required = 3;
  return {
    ok: Boolean(rarity || kind) && Boolean(clean(body)),
    kind: 'magic-item',
    record: {
      id: slug(name),
      name,
      kind,
      rarity: rarity ? rarity.replace(/\b\w/g, (ch) => ch.toUpperCase()) : null,
      attunement: Boolean(attuneMatch),
      attunementNote: attuneMatch?.[1] ? clean(attuneMatch[1]) : null,
      text: clean(body),
      source: meta.source || null,
      custom: true,
    },
    coverage: (required - missing.length) / required,
    missing,
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* spells                                                              */
/* ------------------------------------------------------------------ */

const SCHOOLS = ['abjuration', 'conjuration', 'divination', 'enchantment',
  'evocation', 'illusion', 'necromancy', 'transmutation'];

export function parseSpell(text, meta = {}) {
  const src = String(text || '').replace(/\r/g, '');
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const name = clean(meta.name || lines[0] || 'Unnamed spell');
  const missing = [];

  // "3rd-level evocation" or "Evocation cantrip" - both orders appear, and
  // the cantrip form puts the school first, which is what tripped the SRD
  // converter once already.
  let level = null;
  let school = null;
  const levelled = /(\d+)(?:st|nd|rd|th)[-\s]level\s+(\w+)/i.exec(src);
  const cantrip = new RegExp(`(${SCHOOLS.join('|')})\\s+cantrip`, 'i').exec(src);
  if (levelled) {
    level = Number(levelled[1]);
    school = levelled[2].toLowerCase();
  } else if (cantrip) {
    level = 0;
    school = cantrip[1].toLowerCase();
  }
  if (level === null) missing.push('level');
  if (!school || !SCHOOLS.includes(school)) {
    school = SCHOOLS.find((s) => src.toLowerCase().includes(s)) || null;
    if (!school) missing.push('school');
  }

  const castingTime = labelledSpell(src, 'Casting Time');
  const range = labelledSpell(src, 'Range');
  const components = labelledSpell(src, 'Components');
  const duration = labelledSpell(src, 'Duration');
  for (const [k, v] of Object.entries({ castingTime, range, components, duration })) {
    if (!v) missing.push(k);
  }

  const bodyStart = /Duration:?[^\n]*\n/i.exec(src);
  const body = bodyStart
    ? src.slice(bodyStart.index + bodyStart[0].length)
    : lines.slice(2).join('\n');

  const required = 6;
  return {
    ok: level !== null && Boolean(castingTime || range),
    kind: 'spell',
    record: {
      id: slug(name),
      name,
      level,
      school,
      castingTime,
      range,
      components,
      duration,
      concentration: /concentration/i.test(duration || ''),
      ritual: /\britual\b/i.test(src),
      text: clean(body),
      source: meta.source || null,
      custom: true,
    },
    coverage: (required - missing.length) / required,
    missing,
    warnings: [],
  };
}

function labelledSpell(src, label) {
  const re = new RegExp(`${label}\\s*:?\\s*([^\\n]+)`, 'i');
  const m = re.exec(src);
  return m ? clean(m[1]) : null;
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* sanity                                                              */
/* ------------------------------------------------------------------ */

/**
 * Is this block a CONTAINER rather than a record?
 *
 * The failure this exists to stop: a block titled "Spell Descriptions" holding
 * five spells parsed happily as one spell with 100% coverage, because the
 * fields of the first spell inside it were right there to be found. Full marks
 * for entirely the wrong thing, which is worse than a clean refusal.
 *
 * Two tells: a title that is a heading or a fragment, and a body containing
 * the same anchor label more than once.
 */
const HEADING_TITLE = new RegExp(
  '^\\s*(?:'
  + '(?:spell|tattoo|item|monster|creature|feat|trait|action)s?\\s+'
  + '(?:descriptions?|list|table|options?)'
  + '|new\\s+(?:spell|item|monster|feat|species)s?'
  + '|actions?|reactions?|bonus actions?|legendary actions?|traits?'
  // A statblock or spell LABEL captured as a title.
  + '|(?:armor class|hit points|speed|challenge|casting time|components?'
  + '|duration|range|prerequisite|target|classes|saving throw|hit)\\b.*'
  + '|(?:str|dex|con|int|wis|cha)(?:\\s+(?:str|dex|con|int|wis|cha)){2,}'
  // A phrase left hanging on a conjunction is mid-sentence.
  + '|.*\\b(?:and|or|of|the|with|for|to|by|in|that|which)\\s*'
  + ')\\s*$', 'i',
);

const ANCHORS = {
  monster: /Armor Class\s*\d+/gi,
  spell: /Casting Time\s*:/gi,
  'magic-item': /requires attunement/gi,
};

export function containerCheck(kind, text, name) {
  const title = clean(name || '');
  // A title that runs into prose, or is long enough to be a sentence, is a
  // captured line rather than the name of a thing.
  if (!title || title.length < 3 || title.length > 60
      || /\.\s+[A-Z]/.test(title) || HEADING_TITLE.test(title)) {
    return `"${title}" is a section heading or a fragment, not the name of a `
      + `${kind}. Whatever is inside it should be picked up separately.`;
  }
  const anchor = ANCHORS[kind];
  if (anchor) {
    const hits = String(text || '').match(anchor);
    if (hits && hits.length > 1) {
      return `this block contains ${hits.length} ${kind}s, not one. Splitting `
        + 'them apart is a separate job; parsing the first and calling it the '
        + 'whole block would be wrong.';
    }
  }
  return null;
}

/** Route a block to the right parser. */
export function parseContent(kind, text, meta = {}) {
  const norm = kind === 'magic_item' ? 'magic-item' : kind;

  // Refuse containers BEFORE parsing, so a heading can never come back with
  // high coverage borrowed from the records inside it.
  const container = containerCheck(norm, text, meta.name);
  if (container) {
    return {
      ok: false, kind: norm, record: null, coverage: 0,
      missing: ['a single record'], warnings: [container], container: true,
    };
  }

  switch (norm) {
    case 'monster': return parseStatblock(text, meta);
    case 'magic-item': return parseMagicItem(text, meta);
    case 'spell': return parseSpell(text, meta);
    default:
      return {
        ok: false, kind: norm, record: null, coverage: 0,
        missing: ['parser'], warnings: [`no parser for "${kind}"`],
      };
  }
}
