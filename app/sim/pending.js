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
    id: 'FIGHT-1-resistance-dead',
    title: 'Resistance is halved in the shared fight',
    why: 'applyTo takes a damageType and the ribbon never passes one, so '
       + 'mitigate() returns early and a resistant creature takes full '
       + 'damage. The runner docstring and README both claim otherwise.',
    async run(c) {
      const runner = await import('../modes/dm/runner.js');
      runner.reset?.();
      runner.addCustom({ name: 'Stone Thing', ac: 12, hp: 40, initMod: 0 });
      const it = runner.state.combatants.at(-1);
      it.resistances = ['fire'];

      // What the ribbon does today: two arguments, no damage type.
      const before = it.hp;
      runner.applyTo(it.id, -10);
      const taken = before - runner.state.combatants
        .find((x) => x.id === it.id).hp;
      c.eq(taken, 5, 'a fire-resistant creature takes half of 10');
    },
  },
  {
    id: 'FIGHT-2-midfight-initiative',
    title: 'A monster deployed mid-fight gets a turn',
    why: 'rollInitiative is only offered before the fight starts, so anything '
       + 'added later keeps init:null, sorts to the bottom and never acts. '
       + 'This is what the C2 Deploy button does for a living.',
    async run(c) {
      const runner = await import('../modes/dm/runner.js');
      runner.reset?.();
      runner.addCustom({ name: 'A', ac: 10, hp: 10, initMod: 3 });
      runner.addCustom({ name: 'B', ac: 10, hp: 10, initMod: 1 });
      runner.rollInitiative();
      c.ok(runner.state.started, 'the fight has started');

      runner.addCustom({ name: 'Ambusher', ac: 13, hp: 15, initMod: 2 });
      const late = runner.state.combatants.find((x) => x.name === 'Ambusher');
      c.ok(late.init !== null,
        'the late arrival has an initiative', String(late.init));
    },
  },
  {
    id: 'FIGHT-3-remove-shifts-turn',
    title: 'Removing a combatant leaves the turn on the same creature',
    why: 'state.turn is a positional index and remove() only clamps the high '
       + 'end, so deleting anything above the marker silently moves the turn '
       + 'onto somebody else. Removing the dead thing is a constant action.',
    async run(c) {
      const runner = await import('../modes/dm/runner.js');
      runner.reset?.();
      for (const n of ['A', 'B', 'C', 'D', 'E']) {
        runner.addCustom({ name: n, ac: 10, hp: 10, initMod: 0 });
      }
      runner.rollInitiative();
      runner.state.turn = 3;
      const whose = runner.state.combatants[3].id;

      // Remove somebody EARLIER in the order than the current turn.
      runner.remove(runner.state.combatants[1].id);
      c.eq(runner.state.combatants[runner.state.turn]?.id, whose,
        'the turn still belongs to whoever it belonged to');
    },
  },
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
    id: 'FIGHT-5-custom-has-no-side',
    title: 'A custom combatant is born with a side',
    why: 'addCharacter emits ally and addMonsters emits enemy; addCustom '
       + 'emits neither, so the chip reads foe and the first tap changes '
       + 'nothing visible.',
    async run(c) {
      const runner = await import('../modes/dm/runner.js');
      runner.reset?.();
      runner.addCustom({ name: 'Hireling', ac: 12, hp: 9, initMod: 0 });
      const it = runner.state.combatants.at(-1);
      c.ok(it.side === 'ally' || it.side === 'enemy',
        'it has a side at all', String(it.side));
    },
  },
  {
    id: 'LEAK-1-clock-events',
    title: 'A secret clock does not leak through the event log',
    why: 'deck.js logs clock_advanced with the label whatever c.public says, '
       + 'and GET /api/events applies no redaction, so the Chronicle - a '
       + 'player mode - can read it.',
    async run(c) {
      const t = await freshTable();
      const dm = t.token;
      const joined = await api('/api/table/join', {
        method: 'POST',
        body: JSON.stringify({ code: t.code, name: 'Pending Player' }),
      });
      const player = joined.body.token;

      await api('/api/events', {
        method: 'POST',
        body: JSON.stringify([{
          id: `ev-pending-${Date.now()}`, type: 'clock_advanced',
          ts: new Date().toISOString(), campaignId: 'pending-camp',
          payload: { clock: 'PENDING-SECRET-LABEL', filled: 6, size: 6,
            struck: true },
        }]),
      }, dm);

      const seen = await api('/api/events?limit=100', {}, player);
      const leaked = (seen.body || []).some((e) => e?.type === 'clock_advanced'
        && String(e?.payload?.clock || '').includes('PENDING-SECRET-LABEL'));
      c.ok(!leaked, 'a player cannot read a secret clock label from the log');
      await api('/api/table/close', { method: 'POST' });
    },
  },
  {
    id: 'API-1-nondict-body-drops',
    title: 'A JSON body that is not an object is refused, not dropped',
    why: '_read_json only rejects null, so a list or a number reaches code '
       + 'that assumes a dict and the handler thread dies with the '
       + 'connection. Eleven routes do this.',
    async run(c) {
      for (const [label, body] of [['a list', '[1,2]'],
        ['a string', '"hello"'], ['a number', '42']]) {
        let status = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await fetch(`${base()}/api/characters/pending-probe`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body });
          status = r.status;
        } catch {
          status = null;   // the connection went away
        }
        c.eq(status, 400, `${label} body is refused with 400`, String(status));
      }
    },
  },
  {
    id: 'PWA-1-stale-service-worker',
    title: 'The service worker caches the modules the app actually imports',
    why: 'sw.js is still v9 and its SHELL lists none of the five modules the '
       + 'LAN epics added, so an installed PWA opened offline fails to '
       + 'import them.',
    async run(c) {
      const src = await fetch(`${base()}/sw.js`).then((r) => r.text());
      const want = ['ui/qr.js', 'ui/vendor/qrcodegen.js',
        'ui/components/rollcard.js', 'ui/components/dicerail.js',
        'core/pregen.js'];
      const missing = want.filter((m) => !src.includes(m));
      c.eq(missing.length, 0,
        'every module the LAN epics added is in the shell', missing.join(', '));
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
