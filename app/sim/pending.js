/**
 * Reproductions for defects that are CONFIRMED and NOT YET FIXED.
 *
 * The gym holds the line: every scenario in it passes, and a commit that
 * reddens it does not ship. That is what makes it worth anything, and it
 * is exactly why a known-but-unfixed bug cannot live there - a suite with
 * a permanent red in it stops being a gate within a week.
 *
 * So the reproductions live here instead, and the sign is inverted: a
 * scenario in this file is EXPECTED TO FAIL, and a failure is the bug
 * still being present. When a fix lands, its reproduction turns green,
 * and green here means "promote me into appgym.js and delete me from
 * this file". The to-do list is executable rather than a description.
 *
 * Open /sim/pending.html to run them. Each carries the finding id it
 * belongs to, so the report and the code agree on what is being talked
 * about.
 *
 * These import the modules they need directly rather than taking the
 * gym's ctx, so this file stands alone and does not wait on buildCtx
 * being lifted out of gym.html.
 */

const base = () => location.origin;

async function api(path, opts = {}, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Toon-Token'] = token;
  const res = await fetch(base() + path, { headers, ...opts });
  let body = {};
  try { body = await res.json(); } catch { /* empty or not json */ }
  return { status: res.status, body };
}

/** A throwaway table, so a reproduction never leans on what came before. */
async function freshTable(name = 'Pending DM') {
  await api('/api/table/close', { method: 'POST' });
  const out = await api('/api/table/open',
    { method: 'POST', body: JSON.stringify({ name }) });
  return out.body;
}

export const PENDING = [
  {
    id: 'FIGHT-4-death-saves-persist',
    title: 'Being healed above 0 clears the death saves',
    why: 'deathSaves is reset only by longRest, so a healed character keeps '
       + 'their failures and starts the next fight part-way to dead.',
    async run(c) {
      const engine = await import('../core/engine.js');
      const ch = {
        id: 'p', name: 'Pending', classes: [{ classId: 'fighter', level: 3 }],
        abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
        hp: { current: 0 }, deathSaves: { successes: 0, failures: 2 },
      };
      const healed = engine.adjustHp
        ? engine.adjustHp(ch, 5)
        : { ...ch, hp: { current: 5 } };
      c.eq(healed.deathSaves?.failures ?? 0, 0,
        'healing above 0 clears the failures',
        JSON.stringify(healed.deathSaves));
    },
  },
  {
    id: 'RAIL-1-createdAt-no-offset',
    title: 'The table records when it opened in a format with a timezone',
    why: 'table.py writes createdAt as a bare local wall clock while every '
       + 'event ts is UTC, so the dice rail compares them on different '
       + 'clocks whenever the phone and the server disagree.',
    async run(c) {
      const t = await freshTable();
      const status = await api('/api/table', {}, t.token);
      const created = status.body?.createdAt || '';
      c.ok(/(Z|[+-]\d{2}:?\d{2})$/.test(created),
        'createdAt carries an offset', created);
      await api('/api/table/close', { method: 'POST' });
    },
  },
];
