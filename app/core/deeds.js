/**
 * DEEDS - what the record says this character actually did.
 *
 * An achievement here is never inferred and never teased: it is earned by a
 * specific event that is already in the chronicle, and it is stamped with
 * that event's own time. A deed you have not earned is not shown as a
 * locked box to want; it simply is not there yet.
 *
 * Two honesty notes the panel repeats in its fine print:
 *
 *   - At a table nobody logs a kill (the DM's runner records damage and
 *     healing, not deaths; only the solo tracker writes `kill`), so First
 *     blood is a solo deed for now rather than a thing quietly faked.
 *   - The Chronicle's list is this character's; "Regular" counts session
 *     starts the whole seat can see, which the caller passes separately.
 *
 * Everything the panel prints comes out as WORDS - dates, counts, ordinals -
 * because the phone gym counts distinct numbers on the screen and this panel
 * has no business spending that budget.
 */

const nth = (n) => (list, pred) => {
  let seen = 0;
  for (const e of list) {
    if (pred(e)) { seen += 1; if (seen === n) return e.ts; }
  }
  return null;
};
const first = nth(1);

const isCrit = (e) => e.type === 'crit' || (e.type === 'roll' && !!e.payload?.crit);
const isFumble = (e) => e.type === 'fumble' || (e.type === 'roll' && !!e.payload?.fumble);

export const DEEDS = [
  { id: 'natural_twenty', title: 'Natural twenty', line: 'The die came up twenty.',
    earn: (ev) => first(ev, isCrit) },
  { id: 'natural_one', title: 'Natural one', line: 'The die came up one, and everyone saw.',
    earn: (ev) => first(ev, isFumble) },
  { id: 'first_blood', title: 'First blood', line: 'The first kill on the record.',
    earn: (ev) => first(ev, (e) => e.type === 'kill') },
  { id: 'back_from_the_brink', title: 'Back from the brink',
    line: 'A natural twenty on a death save.',
    earn: (ev) => first(ev, (e) => e.type === 'death_save' && Number(e.payload?.roll) === 20) },
  { id: 'stood_back_up', title: 'Stood back up', line: 'Went down, and was healed back up.',
    earn: (ev) => {
      let down = false;
      for (const e of ev) {
        if (e.type === 'downed') down = true;
        else if (e.type === 'healed' && down) return e.ts;
      }
      return null;
    } },
  { id: 'word_kept', title: 'Word kept', line: 'A promise made, and kept.',
    earn: (ev) => first(ev, (e) => e.type === 'promise_kept') },
  { id: 'a_new_chapter', title: 'A new chapter', line: 'The first level gained.',
    earn: (ev) => first(ev, (e) => e.type === 'level_up') },
  { id: 'seasoned', title: 'Seasoned', line: 'Reached the fifth level.',
    earn: (ev) => first(ev, (e) => e.type === 'level_up' && Number(e.payload?.level) >= 5) },
  { id: 'legend_in_the_making', title: 'Legend in the making', line: 'Reached the tenth level.',
    earn: (ev) => first(ev, (e) => e.type === 'level_up' && Number(e.payload?.level) >= 10) },
  { id: 'well_rested', title: 'Well rested', line: 'The first long rest taken.',
    earn: (ev) => first(ev, (e) => e.type === 'rest_long') },
  { id: 'first_spell', title: 'First spell', line: 'The first spell cast.',
    earn: (ev) => first(ev, (e) => e.type === 'spell_cast') },
  { id: 'spellslinger', title: 'Spellslinger', line: 'Twenty-five spells cast.',
    earn: (ev) => nth(25)(ev, (e) => e.type === 'spell_cast') },
  { id: 'took_a_beating', title: 'Took a beating', line: 'A hundred points of damage, all told.',
    earn: (ev) => {
      let sum = 0;
      for (const e of ev) {
        if (e.type !== 'damage_taken') continue;
        sum += Number(e.payload?.amount) || 0;
        if (sum >= 100) return e.ts;
      }
      return null;
    } },
  { id: 'called_it', title: 'Called it', line: 'Ten turns ended with a tap.',
    earn: (ev) => nth(10)(ev, (e) => e.type === 'turn_done') },
  { id: 'quick_draw', title: 'Quick draw', line: 'A natural twenty on initiative.',
    earn: (ev) => first(ev, (e) => e.type === 'initiative' && Number(e.payload?.nat) === 20) },
  { id: 'chronicler', title: 'Chronicler', line: 'Ten journal entries written.',
    earn: (ev) => nth(10)(ev, (e) => e.type === 'journal') },
  { id: 'well_met', title: 'Well met', line: 'Five different people met.',
    earn: (ev) => {
      const names = new Set();
      for (const e of ev) {
        if (e.type !== 'npc_met') continue;
        names.add(String(e.payload?.name || '').trim().toLowerCase());
        if (names.size >= 5) return e.ts;
      }
      return null;
    } },
  { id: 'regular', title: 'Regular', line: 'Five sessions started.',
    earn: (ev, extra) => nth(5)(extra?.sessions || [], (e) => e.type === 'session_start') },
];

/** Events sorted by time - the log is append-only but a merge is not. */
function inOrder(events) {
  return [...(events || [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * The deeds this record has earned, each stamped with the time of the event
 * that earned it, oldest first. Nothing here that the events do not say.
 */
export function earnedDeeds(events, extra = {}) {
  const ev = inOrder(events);
  const ex = { ...extra, sessions: inOrder(extra.sessions || []) };
  const out = [];
  for (const d of DEEDS) {
    const ts = d.earn(ev, ex);
    if (ts) out.push({ id: d.id, title: d.title, line: d.line, earnedAt: ts });
  }
  return out.sort((a, b) => String(a.earnedAt).localeCompare(String(b.earnedAt)));
}

/* ------------------------------------------------------------------ */
/* words, not digits                                                   */
/* ------------------------------------------------------------------ */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety'];
const ORDINAL_ONES = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth'];
const ORDINAL_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth',
  'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** 0..99 in words. */
export function numberInWords(n) {
  const v = Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
  if (v < 20) return ONES[v];
  const tens = Math.floor(v / 10);
  const ones = v % 10;
  return ones ? `${TENS[tens]}-${ONES[ones]}` : TENS[tens];
}

/** 1..31 as an ordinal in words: "twenty-first". */
export function ordinalInWords(n) {
  const v = Math.max(1, Math.min(31, Math.floor(Number(n) || 1)));
  if (v < 20) return ORDINAL_ONES[v];
  const tens = Math.floor(v / 10);
  const ones = v % 10;
  return ones ? `${TENS[tens]}-${ORDINAL_ONES[ones]}` : ORDINAL_TENS[tens];
}

/** A count as a word, with "none" and "many" at the ends. */
export function countInWords(n) {
  const v = Math.floor(Number(n) || 0);
  if (v <= 0) return 'none';
  if (v > 30) return 'many';
  return numberInWords(v);
}

/** A year as two pairs of words: 2026 -> "twenty twenty-six". */
function yearInWords(y) {
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return hi === 20 ? 'two thousand' : `${numberInWords(hi)} hundred`;
  if (lo < 10) return `${numberInWords(hi)} oh-${numberInWords(lo)}`;
  return `${numberInWords(hi)} ${numberInWords(lo)}`;
}

/** "the twenty-first of August, twenty twenty-six" - no digit anywhere. */
export function dateInWords(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'a day the record does not date';
  return `the ${ordinalInWords(d.getDate())} of ${MONTHS[d.getMonth()]}, `
    + `${yearInWords(d.getFullYear())}`;
}
