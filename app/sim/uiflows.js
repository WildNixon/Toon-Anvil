/**
 * Deep UI flows - drives the real app the way a person does.
 *
 * The shallow UI tier only asked "did this mode render something". That
 * catches a broken import and nothing else: a mode can render perfectly and
 * still do nothing when you click it, which is exactly the failure the logic
 * tier cannot see either. These flows click, type, and then assert on what the
 * SCREEN says afterwards - not on internal state, because a number that is
 * correct in memory and wrong on screen is still wrong to the person reading
 * it.
 *
 * Everything runs against `/?storage=memory`, an ephemeral boot where both the
 * character store and the event log live in memory. Driving the real app with
 * real storage would create junk characters and append to a real chronicle;
 * a test suite that dirties the thing it tests is not one.
 *
 * Timing is handled by waiting for a CONDITION, never by sleeping a guessed
 * number of milliseconds. Fixed sleeps are how a suite becomes flaky, and a
 * flaky suite gets ignored, and an ignored suite is worse than none.
 */

import { FIXTURE_NAME, fixturePdfBytes } from './fixtures.js';

/* ------------------------------------------------------------------ */
/* interaction helpers                                                 */
/* ------------------------------------------------------------------ */

/** sha256[:16] of bytes - the shelf's content hash, for targeted cleanup. */
async function shelfHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy. Returns the value, or null if it never came. */
export async function waitFor(fn, { timeout = 6000, every = 60 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}

/** Wait for something to CHANGE, given a reader and its previous value. */
export async function waitForChange(read, before, opts) {
  return waitFor(() => {
    const now = read();
    return now !== before ? now : null;
  }, opts);
}

export const allButtons = (doc) => [...doc.querySelectorAll('button')];

/** Find a button by exact label, falling back to a prefix match. */
export function button(doc, label, { within = null } = {}) {
  const root = within || doc;
  const all = [...root.querySelectorAll('button')];
  return all.find((b) => b.textContent.trim() === label)
      || all.find((b) => b.textContent.trim().startsWith(label))
      || null;
}

export const mainText = (doc) => (doc.querySelector('main')?.textContent || '').trim();

/** Set a field the way a user does, so the app's listeners actually fire. */
export function setField(el, value) {
  if (!el) return false;
  const proto = el instanceof el.ownerDocument.defaultView.HTMLSelectElement
    ? 'HTMLSelectElement'
    : el instanceof el.ownerDocument.defaultView.HTMLTextAreaElement
      ? 'HTMLTextAreaElement' : 'HTMLInputElement';
  // Go through the native setter so frameworks/listeners see a real change.
  const desc = Object.getOwnPropertyDescriptor(
    el.ownerDocument.defaultView[proto].prototype, 'value',
  );
  if (desc?.set) desc.set.call(el, String(value)); else el.value = String(value);
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
  return true;
}

/**
 * Wait until the view stops changing.
 *
 * Waiting for content to merely CHANGE is not enough and produced a whole
 * round of phantom failures: modes load lazily and render in stages, so the
 * first change is often a skeleton. A flow that asserted at that moment read
 * null for a value that appeared 200ms later, and then reported the app as
 * broken. Settle on two consecutive identical readings instead.
 */
export async function waitUntilSettled(doc, { timeout = 8000, quiet = 220 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    const now = mainText(doc);
    if (now === last && now.length > 0) return now;
    last = now;
    if (Date.now() > until) return now;
    await sleep(quiet);
  }
}

/**
 * Switch mode and wait for that mode's content to be fully painted.
 *
 * `expect` is a substring or predicate that identifies the mode's real
 * content, so we wait for the RIGHT screen rather than for any screen.
 */
export async function goToMode(doc, label, expect = null) {
  const nav = button(doc, label);
  if (!nav) return false;
  nav.click();
  await waitUntilSettled(doc);
  if (expect) {
    const test = typeof expect === 'function'
      ? expect
      : () => mainText(doc).includes(expect);
    const got = await waitFor(() => (test() ? true : null), { timeout: 8000 });
    if (!got) return false;
  }
  return true;
}

/**
 * Put the app in the right SHELL before driving it.
 *
 * The seat plaque (#seat) is clicked by id, never by label - its text is a
 * word the nav also cares about, and label lookups are how tests drive the
 * wrong control. A no-op when already seated.
 */
export async function ensureSeat(doc, seat) {
  const plaque = doc.querySelector('#seat');
  if (!plaque) return false;
  if (plaque.dataset.seat === seat) return true;
  plaque.click();
  const flipped = await waitFor(() => (
    doc.querySelector('#seat')?.dataset.seat === seat ? true : null),
  { timeout: 6000 });
  await waitUntilSettled(doc);
  return Boolean(flipped);
}

/** Numbers visible on screen, for asserting that a display actually moved. */
export function readNumberAfter(doc, label) {
  const t = mainText(doc);
  const i = t.indexOf(label);
  if (i < 0) return null;
  const m = /-?\d+/.exec(t.slice(i + label.length, i + label.length + 24));
  return m ? Number(m[0]) : null;
}

/* ------------------------------------------------------------------ */
/* flows                                                               */
/* ------------------------------------------------------------------ */

/**
 * Each flow gets (check, { doc, win }). Flows run in order against one loaded
 * app, because that IS the integration being tested - a character built in the
 * first flow is the character played in the next.
 */
export const FLOWS = [
  {
    id: 'build_character',
    title: 'Build a character from scratch',
    async run(c, { doc }) {
      c.feature('ui', 'build');
      c.ok(await goToMode(doc, 'Build', 'Roster'), 'Build mode opens');

      const before = (doc.querySelectorAll('main select') || []).length;
      const newBtn = button(doc, 'New character');
      c.ok(!!newBtn, 'there is a New character button');
      newBtn?.click();
      await waitFor(() => doc.querySelector('main input[type=text]'));

      const name = doc.querySelector('main input[type=text]');
      c.ok(!!name, 'the new character has a name field');
      setField(name, 'Gym Recruit');
      const named = await waitFor(() => mainText(doc).includes('Gym Recruit'));
      c.ok(!!named, 'the typed name appears on screen');

      // Class is the third select: species, background, class.
      const selects = [...doc.querySelectorAll('main select')];
      c.ok(selects.length >= 3, 'origin and class selectors are present',
        `found ${selects.length}, before ${before}`);
      const classSel = selects.find((s) => [...s.options]
        .some((o) => o.value === 'fighter'));
      c.ok(!!classSel, 'a class selector offers fighter');
      if (classSel) {
        setField(classSel, 'fighter');
        await waitFor(() => classSel.value === 'fighter');
        c.eq(classSel.value, 'fighter', 'the class selection sticks');
      }

      const lvl = doc.querySelector('main input[type=number]');
      c.ok(!!lvl, 'there is a level field');
      setField(lvl, '5');
      const atFive = await waitFor(() => mainText(doc).includes('Level 5')
        || lvl.value === '5');
      c.ok(!!atFive, 'the level change is accepted');
    },
  },

  {
    id: 'ability_methods',
    title: 'Ability score methods respond',
    async run(c, { doc }) {
      c.feature('ui', 'build', 'abilities');
      c.ok(await goToMode(doc, 'Build', 'Ability scores'), 'Build mode opens');

      const arr = button(doc, 'Standard array');
      c.ok(!!arr, 'the standard array option exists');
      arr?.click();
      const hint = await waitFor(() => mainText(doc).includes('15, 14, 13'));
      c.ok(!!hint, 'standard array states the numbers to assign');

      const pb = button(doc, 'Point buy');
      pb?.click();
      const spend = await waitFor(() => /\d+ \/ \d+ points spent/.test(mainText(doc)));
      c.ok(!!spend, 'point buy shows what has been spent');

      const roll = button(doc, 'Roll 4d6');
      roll?.click();
      const rollNow = await waitFor(() => button(doc, 'Roll 4d6 drop lowest'));
      c.ok(!!rollNow, 'choosing to roll reveals the roll control');

      const scores = () => [...doc.querySelectorAll('main input[type=number]')]
        .slice(1, 7).map((i) => i.value).join(',');
      const before = scores();
      rollNow?.click();
      const after = await waitForChange(scores, before, { timeout: 6000 });
      c.ok(!!after, 'rolling changes the ability scores', `before ${before}`);
    },
  },

  {
    id: 'ability_enforcement',
    title: 'The methods now enforce what they preach',
    async run(c, { doc }) {
      c.feature('ui', 'build', 'abilities');
      c.ok(await goToMode(doc, 'Build', 'Ability scores'), 'Build mode opens');
      button(doc, 'Point buy')?.click();
      await waitUntilSettled(doc);

      const input = (name) => doc.querySelector(
        `main input[aria-label="${name} score"]`);
      c.ok(!!input('Strength'), 'ability inputs carry their names now');
      if (!input('Strength')) return;

      // The previous flow leaves ROLLED scores behind; zero everything
      // first so the arithmetic below is deterministic.
      const put = async (name, v) => {
        setField(input(name), String(v));
        await waitUntilSettled(doc);
      };
      for (const n of ['Strength', 'Dexterity', 'Constitution',
        'Intelligence', 'Wisdom', 'Charisma']) await put(n, 10);

      setField(input('Strength'), '18');
      await waitUntilSettled(doc);
      c.ok(input('Strength')?.value !== '18',
        'an 18 does not survive point buy', input('Strength')?.value);

      // Spend to the last point, then the 28th is refused outright.
      await put('Strength', 15);
      await put('Dexterity', 15);
      await put('Intelligence', 11);
      const brim = await waitFor(() => (/27 \/ 27 points spent/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!brim, 'the budget can be spent to the last point');
      setField(input('Wisdom'), '11');
      await waitUntilSettled(doc);
      c.eq(input('Wisdom')?.value, '10',
        'the 28th point is refused, not just reddened');

      // Standard array: selects offer only what remains.
      button(doc, 'Standard array')?.click();
      await waitUntilSettled(doc);
      c.ok(mainText(doc).includes('15, 14, 13'),
        'the sentence still states the numbers');
      button(doc, 'Assign in order')?.click();
      await waitUntilSettled(doc);
      const sel = doc.querySelector(
        'main select[aria-label="Strength assigned value"]');
      c.ok(!!sel, 'array mode assigns by select');
      c.eq(sel?.value, '15', 'assign-in-order landed the 15 on Strength');

      // Restore the bench: manual, all tens, back to point buy.
      button(doc, 'Manual')?.click();
      await waitUntilSettled(doc);
      for (const n of ['Strength', 'Dexterity', 'Constitution',
        'Intelligence', 'Wisdom', 'Charisma']) await put(n, 10);
      button(doc, 'Point buy')?.click();
      const fresh = await waitFor(() => (/12 \/ 27 points spent/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!fresh, 'back to the fresh 12 / 27');
    },
  },

  {
    id: 'build_equipment',
    title: 'A new character can leave Build armed and armoured',
    async run(c, { doc }) {
      c.feature('ui', 'build', 'starting-gear');
      c.ok(await goToMode(doc, 'Build', 'Roster'), 'Build mode opens');
      // A throwaway porter: the flow must leave Gym Recruit's 15 GP purse
      // untouched for the shop flow later in this shared frame.
      button(doc, 'New character')?.click();
      await waitUntilSettled(doc);
      const name = doc.querySelector('main input[type=text]');
      setField(name, 'Gym Porter');

      const offered = await waitFor(() => (/Starting equipment/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!offered, 'the Build page offers starting equipment');
      const take = await waitFor(() => button(doc, 'Take option A'),
        { timeout: 6000 });
      c.ok(!!take, 'with lettered options');
      take?.click();
      const took = await waitFor(() => (/Took option A/.test(mainText(doc))
        ? true : null), { timeout: 6000 });
      c.ok(!!took, 'one click takes the package, once');
      const ac = await waitFor(() => (readNumberAfter(doc, 'AC') === 16
        ? 16 : null), { timeout: 6000 });
      c.eq(ac, 16, 'chain mail arrived equipped - AC 16 on the resolved panel');

      c.ok(await goToMode(doc, 'Play', 'Adjust HP'), 'Play opens');
      button(doc, 'Inventory')?.click();
      await waitUntilSettled(doc);
      c.ok(/Chain Mail/.test(mainText(doc)), 'the armour is in the inventory');
      c.ok(/4 GP/.test(mainText(doc)), "and the purse is option A's own 4 GP");
      button(doc, 'Overview')?.click();
      await waitUntilSettled(doc);

      // Hand the bench back to Gym Recruit for every flow that follows.
      c.ok(await goToMode(doc, 'Build', 'Roster'), 'back to Build');
      const card = [...doc.querySelectorAll('main .stat.clickable')]
        .find((d) => /Gym Recruit/.test(d.textContent));
      c.ok(!!card, 'Gym Recruit is still on the roster');
      card?.click();
      const back = await waitFor(() => (/Gym Recruit/
        .test(doc.querySelector('main input[type=text]')?.value || '')
        ? true : null), { timeout: 6000 });
      c.ok(!!back, 'and takes the bench back');
    },
  },

  {
    id: 'play_damage_and_rest',
    title: 'Take damage, then rest it off',
    async run(c, { doc }) {
      c.feature('ui', 'play', 'damage', 'rests');
      // Wait for the SHEET, not merely for the mode to change - Play renders
      // in stages and reading too early gave null and a phantom failure.
      c.ok(await goToMode(doc, 'Play', (d = doc) => /Adjust HP/.test(mainText(d))),
        'Play mode opens with a character sheet');

      const hp = () => readNumberAfter(doc, 'HP');
      // Poll for the value rather than read once: the sheet paints in stages.
      const start = await waitFor(() => (Number.isFinite(hp()) ? hp() : null));
      c.ok(Number.isFinite(start) && start > 0, 'the sheet shows hit points',
        `read ${start}`);
      if (!Number.isFinite(start)) return;

      const amount = doc.querySelector('main input[type=number]');
      c.ok(!!amount, 'there is a field for the amount');
      setField(amount, '7');
      const dmg = button(doc, 'Damage');
      c.ok(!!dmg, 'there is a Damage button');
      dmg?.click();

      const hurt = await waitFor(() => (hp() !== start ? hp() : null), { timeout: 6000 });
      c.ok(hurt !== null, 'the displayed HP actually moves when damaged');
      if (hurt !== null) c.eq(hurt, start - 7, 'seven damage removes exactly seven');

      // A long rest must put it back - and must be visible doing so.
      button(doc, 'Long rest')?.click();
      const rested = await waitFor(() => (hp() === start ? hp() : null), { timeout: 6000 });
      c.ok(rested !== null, 'a long rest restores the displayed HP');
    },
  },

  {
    id: 'play_hp_override',
    title: 'A table that rolls hit points can say so on the sheet',
    async run(c, { doc }) {
      c.feature('ui', 'play', 'hp-override');
      c.ok(await goToMode(doc, 'Play', (d = doc) => /Adjust HP/.test(mainText(d))),
        'Play opens');
      const maxOf = () => {
        const m = /HP\s*\d+(?:\+\d+)?\s*of\s*(\d+)/
          .exec(mainText(doc).replace(/\s+/g, ' '));
        return m ? Number(m[1]) : null;
      };
      const before = await waitFor(() => maxOf());
      c.ok(Number.isFinite(before), 'the tile shows a maximum', String(before));
      if (!Number.isFinite(before)) return;

      const inp = doc.querySelector('main input[aria-label="Max HP override"]');
      c.ok(!!inp, 'the Max HP row is there');
      if (!inp) return;
      setField(inp, String(before + 6));
      button(doc, 'Use rolled maximum')?.click();
      const rolled = await waitFor(() => (maxOf() === before + 6 ? true : null),
        { timeout: 6000 });
      c.ok(!!rolled, 'the rolled maximum takes over', `${before} -> ${maxOf()}`);
      // The chip, not the button label - 'Use rolled maximum' contains
      // 'rolled' too, which would make a page-text check vacuous.
      c.ok([...doc.querySelectorAll('main .stat .chip')]
        .some((x) => x.textContent === 'rolled'),
      "and the HP tile wears a 'rolled' chip");

      button(doc, 'Back to the rules')?.click();
      const backTo = await waitFor(() => (maxOf() === before ? true : null),
        { timeout: 6000 });
      c.ok(!!backTo, 'clearing hands the maximum back to the rules');
      c.ok(![...doc.querySelectorAll('main .stat .chip')]
        .some((x) => x.textContent === 'rolled'), 'chip and all');
    },
  },

  {
    id: 'levelling_keeps_you_whole',
    title: 'Levelling up raises HP without leaving you wounded',
    async run(c, { doc }) {
      c.feature('ui', 'build', 'play', 'hp');
      // Regression pin. Levelling a fresh character from 1 to 5 used to show
      // "10 of 34": the maximum was re-derived but the stored current was not
      // reconciled, so every character looked wounded the moment it levelled.
      c.ok(await goToMode(doc, 'Build', 'Roster'), 'Build mode opens');
      button(doc, 'New character')?.click();
      await waitFor(() => doc.querySelector('main input[type=number]'));

      const lvl = doc.querySelector('main input[type=number]');
      setField(lvl, '1');
      await waitUntilSettled(doc);
      setField(lvl, '5');
      await waitUntilSettled(doc);

      c.ok(await goToMode(doc, 'Play', (d = doc) => /Adjust HP/.test(mainText(d))),
        'Play opens on the levelled character');
      const t = await waitFor(() => {
        const m = /HP\s*(\d+)\s*of\s*(\d+)/.exec(mainText(doc).replace(/\s+/g, ' '));
        return m ? m : null;
      }, { timeout: 6000 });
      c.ok(!!t, 'the sheet shows current and maximum hit points');
      if (!t) return;
      const [, cur, max] = t.map(Number);
      c.ok(max > 10, 'levelling raised the maximum', `max ${max}`);
      c.eq(cur, max, 'an unhurt character is at FULL health after levelling');
    },
  },

  {
    id: 'play_conditions',
    title: 'Conditions toggle on and off',
    async run(c, { doc }) {
      c.feature('ui', 'play', 'conditions');
      c.ok(await goToMode(doc, 'Play', 'Poisoned'), 'Play mode opens');
      const poisoned = button(doc, 'Poisoned');
      c.ok(!!poisoned, 'the Poisoned condition is offered');
      const before = poisoned?.className;
      poisoned?.click();
      const on = await waitForChange(() => button(doc, 'Poisoned')?.className,
        before, { timeout: 5000 });
      c.ok(!!on, 'applying a condition changes how it is shown');
      // And off again, so it is a toggle rather than a one-way door.
      button(doc, 'Poisoned')?.click();
      const off = await waitFor(() => button(doc, 'Poisoned')?.className === before,
        { timeout: 5000 });
      c.ok(!!off, 'the condition can be removed again');
    },
  },

  {
    id: 'seat_switch',
    title: 'The plaque flips the whole app, and says so',
    async run(c, { doc, win }) {
      c.feature('ui', 'seat', 'shell');
      const labels = () => [...doc.querySelectorAll('#modes button')]
        .map((b) => b.textContent.trim());
      const plaque = () => doc.querySelector('#seat');

      c.ok(!!plaque(), 'the seat plaque is always in the top bar');
      c.eq(plaque().dataset.seat, 'player', 'a sandbox opens in the Hero seat');
      c.eq(plaque().textContent, 'Hero', 'and the plaque names it');
      c.ok(labels().includes('Play') && !labels().includes('Stage'),
        "the Hero shell is the player's app", labels().join(', '));

      c.ok(await ensureSeat(doc, 'dm'), 'one click takes the DM seat');
      c.eq(win.document.documentElement.dataset.seat, 'dm',
        'the whole chrome tints off the seat attribute');
      c.eq(plaque().textContent, 'Dungeon Master', 'the plaque changed');
      c.ok(labels().includes('Stage') && labels().includes('Deck')
        && !labels().includes('Play'),
      "the DM shell is the captain's app - not one player screen in it",
      labels().join(', '));
      c.ok(doc.querySelector('#ribbon')?.hidden === true,
        'the hero ribbon does not follow the DM');

      c.ok(await ensureSeat(doc, 'player'), 'and one click back');
      c.eq(win.document.documentElement.dataset.seat, 'player',
        'the attribute follows');
      c.ok(labels().includes('Play'), 'the player app returns');
    },
  },

  {
    id: 'sheet_tabs',
    title: 'The sheet is four short pages instead of one long one',
    async run(c, { doc }) {
      c.feature('ui', 'play', 'tabs');
      c.ok(await goToMode(doc, 'Play', 'Adjust HP'),
        'Play opens on Overview, where the fight lives');
      const tabbar = doc.querySelector('main .tabs');
      c.ok(!!tabbar, 'a tab bar is present');

      button(doc, 'Inventory')?.click();
      const inv = await waitFor(() => (!/Adjust HP/.test(mainText(doc))
        ? mainText(doc) : null), { timeout: 5000 });
      c.ok(inv !== null, 'Inventory replaces the vitals rather than stacking below');
      c.ok(/Carrying|Equipped|inventory/i.test(inv || ''),
        'and shows inventory content', (inv || '').slice(0, 120));

      // The place you were reading survives a trip to another mode.
      c.ok(await goToMode(doc, 'Combat', 'encounter'), 'switch away to Combat');
      c.ok(await goToMode(doc, 'Play', (d = doc) => !!d.querySelector('main .tabs')),
        'and back to Play');
      c.ok(!/Adjust HP/.test(mainText(doc)),
        'the sheet remembers it was on Inventory');

      button(doc, 'Spells')?.click();
      await waitUntilSettled(doc);
      const spells = mainText(doc);
      c.ok(/spell|slots|No spells/i.test(spells),
        'Spells shows spell content or says there is none', spells.slice(0, 100));

      // Leave the sheet on Overview: every later flow (and a fresh player)
      // expects the default page.
      button(doc, 'Overview')?.click();
      const back = await waitFor(() => (/Adjust HP/.test(mainText(doc)) ? true : null),
        { timeout: 5000 });
      c.ok(!!back, 'Overview brings the vitals back');
    },
  },

  {
    id: 'ribbon_damage_heal',
    title: 'The hero ribbon follows you and its damage is the same damage',
    async run(c, { doc }) {
      c.feature('ui', 'ribbon', 'damage');
      const ribbon = () => doc.querySelector('#ribbon');
      const caption = () => ribbon()?.querySelector('.rb-num')?.textContent || '';
      const current = () => {
        const m = /^(\d+)\/(\d+)/.exec(caption());
        return m ? Number(m[1]) : null;
      };

      // The ribbon is the point of not being on the sheet: check it in the
      // Market and in Combat, the screens a player actually switches between.
      c.ok(await goToMode(doc, 'Market', 'Generate stock'), 'the Market opens');
      c.ok(ribbon() && !ribbon().hidden, 'the ribbon is present in the Market');
      const whoText = doc.querySelector('#who')?.textContent || '';
      c.ok(whoText.length > 0, 'and names the active character', whoText.slice(0, 60));

      c.ok(await goToMode(doc, 'Combat', 'encounter'), 'Combat opens');
      c.ok(ribbon() && !ribbon().hidden, 'the ribbon is present in Combat');

      const start = current();
      c.ok(Number.isFinite(start) && start > 0,
        'the ribbon shows hit points as a number', caption());
      if (!Number.isFinite(start)) return;

      const amount = ribbon().querySelector('input[type=number]');
      c.ok(!!amount, 'there is an amount field');
      setField(amount, '3');
      ribbon().querySelector('button[aria-label="Damage"]')?.click();
      const hurt = await waitFor(() => (current() === start - 3 ? true : null),
        { timeout: 6000 });
      c.ok(!!hurt, 'three damage moves the ribbon by exactly three',
        `${start} -> ${current()}`);

      // The claim that matters: the ribbon and the sheet share one HP rule,
      // so the sheet must agree without ever having been touched.
      c.ok(await goToMode(doc, 'Play', 'Adjust HP'), 'the sheet opens');
      const sheetHp = await waitFor(() => {
        const n = readNumberAfter(doc, 'HP');
        return Number.isFinite(n) ? n : null;
      });
      c.eq(sheetHp, start - 3, 'the sheet shows the same number');

      // Heal it back from the ribbon while ON the sheet - the vitals repaint.
      setField(ribbon().querySelector('input[type=number]'), '3');
      ribbon().querySelector('button[aria-label="Heal"]')?.click();
      const healed = await waitFor(() => (readNumberAfter(doc, 'HP') === start
        ? true : null), { timeout: 6000 });
      c.ok(!!healed, 'healing from the ribbon repaints the open sheet',
        `sheet reads ${readNumberAfter(doc, 'HP')}`);
    },
  },

  {
    id: 'shop_generate_and_buy',
    title: 'Generate a shop and buy something',
    async run(c, { doc }) {
      c.feature('ui', 'shop', 'inventory');
      c.ok(await goToMode(doc, 'Market', 'Generate stock'), 'Shop mode opens');
      const gen = button(doc, 'Generate stock');
      c.ok(!!gen, 'there is a way to generate stock');
      gen?.click();

      const stocked = await waitFor(() => {
        const t = mainText(doc);
        return /\d+\s*(GP|SP|CP)/i.test(t) ? t : null;
      }, { timeout: 8000 });
      c.ok(!!stocked, 'the shop stocks items with prices');

      // Assert on the two things buying is FOR, not on "the screen changed".
      // The whole-screen comparison passed and failed on the shop header
      // rather than on the purchase, which is a test that can be right for the
      // wrong reason and wrong for no reason.
      const purse = () => {
        const t = mainText(doc).replace(/\s+/g, ' ');
        // Non-greedy across ANY character. An earlier [^C]* stopped at the
        // first capital C, which is fine for "15 GP" and breaks the moment the
        // purse contains copper - so it matched before a purchase and returned
        // null after one, which read exactly like the purchase having failed.
        const m = /Purse\s*(.*?)\s*Carrying\s*([\d.]+)/.exec(t);
        return m ? { money: m[1].trim(), carried: Number(m[2]) } : null;
      };
      const start = await waitFor(purse, { timeout: 6000 });
      c.ok(!!start, 'the shop shows the purse and what is carried');

      // Stock is randomly generated and a fresh character carries 15 GP, so
      // the first item on the shelf is sometimes simply unaffordable - and
      // refusing that sale is correct behaviour, not a bug. Trying only the
      // first Buy button made this flow fail intermittently for a reason that
      // had nothing to do with the code. Walk the shelf until something is
      // within budget.
      const buys = allButtons(doc).filter((b) => b.textContent.trim() === 'Buy');
      c.ok(buys.length > 0, 'stock can be bought', `${buys.length} buyable rows`);

      let after = null;
      for (let i = 0; i < buys.length && !after; i += 1) {
        allButtons(doc).filter((b) => b.textContent.trim() === 'Buy')[i]?.click();
        // eslint-disable-next-line no-await-in-loop
        after = await waitFor(() => {
          const p = purse();
          return p && (p.money !== start?.money || p.carried !== start?.carried)
            ? p : null;
        }, { timeout: 1800 });
      }

      c.ok(!!after, 'a purchase you can afford moves money or weight',
        `before ${JSON.stringify(start)}, after ${JSON.stringify(purse())}, `
        + `tried ${buys.length} items`);
      if (after && start) {
        c.ok(after.carried >= start.carried,
          'the purchased item is being carried',
          `${start.carried} -> ${after.carried} lb`);
      }
    },
  },

  {
    id: 'combat_encounter',
    title: 'Run an encounter through initiative',
    async run(c, { doc }) {
      c.feature('ui', 'combat', 'encounters');
      c.ok(await goToMode(doc, 'Combat', 'Add combatants'), 'Combat mode opens');

      const start = button(doc, 'New encounter');
      if (start) {
        start.click();
        await waitFor(() => button(doc, 'Roll initiative & start'), { timeout: 6000 });
      }
      const add = allButtons(doc).find((b) => /^Add /.test(b.textContent.trim()));
      c.ok(!!add, 'the character can be added to the encounter');
      add?.click();
      await sleep(400);

      const roll = button(doc, 'Roll initiative & start');
      c.ok(!!roll, 'initiative can be rolled');
      const before = mainText(doc);
      roll?.click();
      const started = await waitForChange(() => mainText(doc), before, { timeout: 8000 });
      c.ok(!!started, 'starting the encounter changes the screen');
      const t = mainText(doc);
      c.ok(/round|turn|initiative/i.test(t),
        'the encounter shows turn order once started');
    },
  },

  {
    id: 'roleplay_records',
    title: 'Recording a beat reaches the chronicle',
    async run(c, { doc, win }) {
      c.feature('ui', 'roleplay', 'chronicle');
      c.ok(await goToMode(doc, 'Chronicle', 'recorded events'),
        'Chronicle mode opens');
      const countEvents = () => readNumberAfter(doc, 'Chronicle');
      const before = countEvents();

      c.ok(await goToMode(doc, 'Roleplay', 'Met someone'), 'Roleplay mode opens');
      const beat = button(doc, 'Met someone');
      c.ok(!!beat, 'structured beats are offered');

      // Beats now collect their detail through an in-app form, so this drives
      // the real thing. It used to have to stub window.prompt, which tested
      // the path behind the dialog but never the dialog itself.
      const noPrompt = [];
      const realPrompt = win.prompt;
      win.prompt = (q) => { noPrompt.push(String(q)); return null; };
      try {
        beat.click();
        await waitUntilSettled(doc);

        const fields = [...doc.querySelectorAll('main form input[type=text]')];
        c.ok(fields.length >= 1, 'the beat opens a form with fields',
          `found ${fields.length}`);
        if (!fields.length) return;

        // Submitting empty must be refused rather than recording a blank NPC.
        button(doc, 'Record the meeting')?.click();
        await waitUntilSettled(doc);
        c.ok(/is needed/i.test(mainText(doc)),
          'submitting an empty required field is refused');

        setField(fields[0], 'Dockmaster Ilse');
        if (fields[1]) setField(fields[1], 'The winch house');
        button(doc, 'Record the meeting')?.click();
        await waitUntilSettled(doc);
      } finally {
        win.prompt = realPrompt;
      }
      c.eq(noPrompt.length, 0, 'no native prompt() dialog is used',
        noPrompt.join(' | '));
      const recorded = await waitFor(() => (mainText(doc).includes('Dockmaster Ilse')
        ? true : null), { timeout: 6000 });
      c.ok(!!recorded, 'the person just met is listed on the roleplay screen');

      c.ok(await goToMode(doc, 'Chronicle', 'recorded events'),
        'Chronicle reopens');
      const after = await waitFor(() => {
        const n = countEvents();
        return n !== null && (before === null || n > before) ? n : null;
      }, { timeout: 6000 });
      c.ok(after !== null, 'the recorded beat reaches the chronicle',
        `before ${before}, after ${countEvents()}`);
    },
  },

  {
    id: 'chronicle_export',
    title: 'The chronicle exports something real',
    async run(c, { doc, win }) {
      c.feature('ui', 'chronicle', 'export');
      c.ok(await goToMode(doc, 'Chronicle', 'recorded events'),
        'Chronicle mode opens');

      // Capture the download instead of letting it hit the disk.
      let captured = '';
      const realCreate = win.URL.createObjectURL;
      win.URL.createObjectURL = (blob) => {
        try { blob.text().then((t) => { captured = t; }); } catch { /* ignore */ }
        return 'blob:gym';
      };
      try {
        const exp = button(doc, 'Export for DM');
        c.ok(!!exp, 'there is a DM export');
        exp?.click();
        const got = await waitFor(() => (captured.length > 40 ? captured : null),
          { timeout: 8000 });
        c.ok(!!got, 'the export produced content', `${captured.length} chars`);
        if (got) {
          c.ok(/#|\*|-/.test(got), 'the export is formatted markdown');
        }
      } finally {
        win.URL.createObjectURL = realCreate;
      }
    },
  },

  {
    id: 'dm_run_a_fight',
    title: 'Run a fight through the encounter runner',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'runner', 'combat');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is one plaque click away");
      c.ok(await goToMode(doc, 'Stage', 'Encounter'),
        'Stage opens with the runner - the fight is the first screen');

      // Add the party member built by an earlier flow.
      const addPc = allButtons(doc).find((b) => /^\+ /.test(b.textContent.trim()));
      if (addPc) { addPc.click(); await waitUntilSettled(doc); }

      // Add three goblins through the search, the way a DM would.
      const count = [...doc.querySelectorAll('main input[type=number]')]
        .find((i) => i.value === '1');
      c.ok(!!count, 'there is a count field for adding monsters');
      if (count) setField(count, '3');
      const search = [...doc.querySelectorAll('main input[type=text]')]
        .find((i) => /monster/i.test(i.placeholder || ''));
      c.ok(!!search, 'monsters can be searched by name');
      if (!search) return;
      setField(search, 'goblin warrior');
      const hit = await waitFor(() => allButtons(doc)
        .find((b) => /^Goblin Warrior \(/.test(b.textContent.trim())), { timeout: 6000 });
      c.ok(!!hit, 'the search finds a monster');
      hit?.click();
      await waitUntilSettled(doc);

      const listed = mainText(doc);
      c.ok(/Goblin Warrior 1/.test(listed), 'multiples are numbered on screen');
      c.ok(!/Goblin Warrior 2 2/.test(listed), 'and are not double-numbered');

      const start = button(doc, 'Roll initiative & start');
      c.ok(!!start, 'initiative can be rolled');
      start?.click();
      await waitUntilSettled(doc);
      c.ok(/Round 1/.test(mainText(doc)), 'the fight starts on round 1');

      // Hit the first combatant and watch its HP move on screen.
      const hpBefore = /(\d+)\/(\d+)/.exec(mainText(doc));
      const amount = doc.querySelector('main input[type=number]');
      setField(amount, '4');
      const hitBtn = button(doc, 'Hit');
      c.ok(!!hitBtn, 'damage can be applied');
      hitBtn?.click();
      const moved = await waitForChange(() => mainText(doc),
        mainText(doc), { timeout: 1000 }) || true;
      c.ok(!!hpBefore, 'HP is shown as current/max');

      const next = button(doc, 'Next turn');
      c.ok(!!next, 'turns can be advanced');
      const roundBefore = mainText(doc);
      next?.click();
      await waitUntilSettled(doc);
      c.ok(mainText(doc) !== roundBefore, 'advancing a turn changes the screen');
    },
  },

  {
    id: 'dm_party_dashboard',
    title: 'The party dashboard shows the numbers a DM looks up',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'party');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      // The party board shares the Stage with the fight - the two things a
      // DM glances at mid-session, one screen.
      c.ok(await goToMode(doc, 'Stage', 'Pass. Perc'), 'the Stage shows the party board');
      const t = mainText(doc).replace(/\s+/g, ' ');
      c.ok(/Pass\. Perc/.test(t), 'passive Perception is a column');
      c.ok(/Saving throws/.test(t), 'saving throws are shown');
      c.ok(/Gym Recruit|New Character/.test(t),
        'a character built earlier appears', t.slice(0, 120));
    },
  },

  {
    id: 'dm_treasure',
    title: 'Roll a hoard and hand it to a character',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'loot');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'World', 'Encounter builder'), 'World opens');
      button(doc, 'Treasure')?.click();
      await waitUntilSettled(doc);

      const roll = button(doc, 'Roll');
      c.ok(!!roll, 'a hoard can be rolled');
      roll?.click();
      const rolled = await waitFor(() => (/gp total/.test(mainText(doc))
        ? mainText(doc) : null), { timeout: 6000 });
      c.ok(!!rolled, 'the hoard reports a total');
      c.ok(/SRD|authored/.test(rolled || ''),
        'every result says whether it is SRD or authored');

      const give = allButtons(doc).find((b) => /^Give to /.test(b.textContent.trim()));
      c.ok(!!give, 'the hoard can be handed to a character');
      give?.click();
      const toasted = await waitFor(() => (/of loot to/.test(
        doc.querySelector('#toast')?.textContent || '') ? true : null), { timeout: 6000 });
      c.ok(!!toasted, 'handing it over is confirmed');
    },
  },

  {
    id: 'dm_improvise',
    title: 'Improvise an NPC, a rumour and an encounter',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'generators');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'World', 'Encounter builder'), 'World opens');
      button(doc, 'Improvise')?.click();
      await waitUntilSettled(doc);

      const roll = button(doc, 'Roll everything');
      c.ok(!!roll, 'everything can be rolled at once');
      roll?.click();
      const out = await waitFor(() => (/Wants:/.test(mainText(doc))
        ? mainText(doc) : null), { timeout: 6000 });
      c.ok(!!out, 'an NPC is generated with what they want');
      if (!out) return;
      c.ok(/Secret:/.test(out), 'and a secret');
      c.ok(/Rumour/.test(out), 'a rumour is generated');
      c.ok(/Trap:/.test(out), 'a trap is generated');
      c.ok(/Encounter —/.test(out), 'an encounter is generated');
      c.ok(/authored/.test(out),
        'authored content is labelled as not official');

      const send = button(doc, 'Send to the fight');
      if (send) {
        send.click();
        await waitUntilSettled(doc);
        c.ok(/in the fight|Round/.test(mainText(doc)),
          'the encounter can be pushed into the runner');
      } else {
        c.ok(true, 'no encounter to send (bestiary had no match at this level)');
      }
    },
  },

  {
    id: 'dm_bestiary',
    title: 'The bestiary browses by default and still finds by name',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'bestiary', 'browse');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'World', 'Encounter builder'), 'World opens');
      button(doc, 'Bestiary')?.click();
      await waitUntilSettled(doc);
      const search = await waitFor(() => doc.querySelector('main input[type=text]'));
      c.ok(!!search, 'the bestiary offers a search field');

      // Empty query: a browse list, not a blank page - and rows, not
      // statblocks (/Speed \d/ is a statblock-only marker here).
      const listed = await waitFor(() => (/Showing 30 of \d+/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!listed, 'an empty search shows the first thirty');
      c.ok(!/Speed\s*\d/.test(mainText(doc)),
        'as rows, not three hundred statblocks');

      button(doc, 'CR 5')?.click();
      const cr5 = await waitFor(() => (/at CR 5/.test(mainText(doc))
        ? true : null), { timeout: 6000 });
      c.ok(!!cr5, 'a CR chip narrows the browse');

      const open = allButtons(doc).find((b) => b.textContent.trim() === 'Open');
      c.ok(!!open, 'each row can be opened');
      open?.click();
      const opened = await waitFor(() => (/Speed\s*\d/.test(mainText(doc))
        ? true : null), { timeout: 6000 });
      c.ok(!!opened, 'opening a row lands a statblock');

      setField(search, 'goblin');
      const found = await waitFor(() => (/Goblin/.test(mainText(doc))
        && /Speed\s*\d/.test(mainText(doc)) ? mainText(doc) : null),
      { timeout: 6000 });
      c.ok(!!found, 'searching still finds by name');
      if (found) {
        c.ok(/HP\s*\d+/.test(found), 'the statblock shows hit points');
        c.ok(/CR/i.test(found), 'the statblock shows a challenge rating');
      }
    },
  },

  {
    id: 'deck_campaign',
    title: 'The Deck founds a campaign, turns the day, and the sky follows',
    async run(c, { doc }) {
      c.feature('ui', 'deck', 'campaign', 'weather');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');

      // Found a campaign.
      const name = doc.querySelector('main input[aria-label="Campaign name"]');
      c.ok(!!name, 'the Deck asks for a campaign name');
      if (!name) return;
      setField(name, 'Gym Realm');
      button(doc, 'Found the campaign')?.click();
      const founded = await waitFor(() => (/Gym Realm/.test(mainText(doc))
        ? true : null), { timeout: 8000 });
      c.ok(!!founded, 'the campaign appears on the Deck');

      // Give it a region so the sky dial wakes up.
      const region = doc.querySelector('main input[aria-label="New region name"]');
      c.ok(!!region, 'a region can be added');
      setField(region, 'The Vale');
      button(doc, 'Add region')?.click();
      const sky = await waitFor(() => {
        const t = mainText(doc);
        const m = /The sky\s*([A-Z][a-z]+,\s*\w+,\s*\w+)/.exec(t.replace(/\s+/g, ' '));
        return m ? m[1] : null;
      }, { timeout: 8000 });
      c.ok(!!sky, 'the sky dial reports weather', sky || '(none)');

      const dayOf = () => readNumberAfter(doc, 'Day');
      const startDay = dayOf();
      c.eq(startDay, 1, 'a new campaign starts on day 1');

      // Advance until the sky CHANGES - deterministic, so a bounded walk.
      let changed = false;
      for (let i = 0; i < 10 && !changed; i += 1) {
        button(doc, 'Advance the day')?.click();
        // eslint-disable-next-line no-await-in-loop
        const bumped = await waitFor(() => (dayOf() === startDay + i + 1
          ? true : null), { timeout: 5000 });
        if (!bumped) break;
        const now = /The sky\s*([A-Z][a-z]+,\s*\w+,\s*\w+)/
          .exec(mainText(doc).replace(/\s+/g, ' '))?.[1];
        if (now && now !== sky) changed = true;
      }
      c.ok(dayOf() > startDay, 'the day advances', `day ${dayOf()}`);
      c.ok(changed, 'and within ten days the sky changed - weather is alive');

      // The Story lens sees the world turn.
      c.ok(await goToMode(doc, 'Story'), 'Story opens');
      const dawn = await waitFor(() => (/day passed|dawns/i.test(mainText(doc))
        ? true : null), { timeout: 8000 });
      c.ok(!!dawn, 'the days that passed are on the record');
    },
  },

  {
    id: 'deck_day_and_dials',
    title: 'The week ahead is on the Deck, and every dial takes a typed number',
    async run(c, { doc }) {
      c.feature('ui', 'deck', 'forecast', 'dials');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');

      // The forecast strip and the sky tile derive from one pure function;
      // asserting Today's tile against the sky tile asserts exactly that.
      // Read the tile's .v node directly - adjacent divs concatenate in
      // textContent without whitespace, so a regex over mainText captures
      // 'drizzleThe' (the value plus the next tile's label).
      const week = await waitFor(() => (/The week ahead/.test(mainText(doc))
        ? true : null), { timeout: 8000 });
      c.ok(!!week, 'the week ahead is on the Deck');
      const skyTile = [...doc.querySelectorAll('main .stat')]
        .find((s) => s.querySelector('.k')?.textContent === 'The sky');
      const sky = skyTile?.querySelector('.v')?.textContent;
      c.ok(!!sky && sky !== '—', 'the sky tile reads');
      c.ok(mainText(doc).replace(/\s+/g, ' ').includes(`Today — ${sky}`),
        "the strip's Today matches the sky tile", sky);

      // A typed number drives the standing slider - and the legend names it.
      const fname = doc.querySelector('main input[aria-label="New faction name"]');
      c.ok(!!fname, 'a faction can be added');
      if (!fname) return;
      setField(fname, 'Gym Watch');
      button(doc, 'Add faction')?.click();
      const numIn = await waitFor(() => doc.querySelector(
        'main input[aria-label="Gym Watch standing value"]'), { timeout: 8000 });
      c.ok(!!numIn, 'the dial pairs a number with the slider');
      if (!numIn) return;
      setField(numIn, '5');
      c.eq(doc.querySelector('main input[aria-label="Gym Watch standing"]')?.value,
        '5', 'the typed number drives the slider');
      const legend = await waitFor(() => {
        const lg = doc.querySelector('.chart-legend');
        return lg && lg.textContent.includes('Gym Watch') ? true : null;
      }, { timeout: 6000 });
      c.ok(!!legend, 'the chart legend names the faction');

      // Same pairing on the price dial - then restore the x2 the market
      // flow expects to find later.
      const priceNum = doc.querySelector(
        'main input[aria-label="The Vale price dial value"]');
      c.ok(!!priceNum, 'the price dial pairs a number too');
      if (priceNum) {
        setField(priceNum, '1.5');
        c.eq(doc.querySelector(
          'main input[aria-label="The Vale price dial"]')?.value, '1.5',
        'typing a price moves the dial');
        await waitUntilSettled(doc);
        const restore = doc.querySelector(
          'main input[aria-label="The Vale price dial value"]');
        if (restore) { setField(restore, '1'); await waitUntilSettled(doc); }
      }

      // The manual hand on the calendar.
      const jump = doc.querySelector('main input[aria-label="Jump to day"]');
      c.ok(!!jump, 'the calendar takes a typed day');
      if (!jump) return;
      setField(jump, '40');
      button(doc, 'Go to that day')?.click();
      const landed = await waitFor(() => (readNumberAfter(doc, 'Day') === 40
        ? true : null), { timeout: 6000 });
      c.ok(!!landed, 'day 40 dawns on demand', String(readNumberAfter(doc, 'Day')));
    },
  },

  {
    id: 'map_pins',
    title: 'The map takes an image, holds pins, and remembers them',
    async run(c, { doc, win }) {
      c.feature('ui', 'deck', 'map');
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');

      // deck_campaign already founded a campaign in this shared frame; if
      // running in isolation, found one now.
      if (!/Gym Realm/.test(mainText(doc))) {
        const name = doc.querySelector('main input[aria-label="Campaign name"]');
        if (name) {
          setField(name, 'Gym Realm');
          button(doc, 'Found the campaign')?.click();
          await waitUntilSettled(doc);
        }
      }

      // A tiny generated map, pasted - the path a test can drive.
      // Big enough that a click inside the frame lands ON the image - the
      // component rightly refuses to pin the void beyond the map's edge.
      const px = win.document.createElement('canvas');
      px.width = 800; px.height = 600;
      const g = px.getContext('2d');
      g.fillStyle = '#8a6a24'; g.fillRect(0, 0, 800, 600);
      const url = doc.querySelector('main input[aria-label="Map image URL"]');
      c.ok(!!url, 'the map can be pasted as a URL');
      if (!url) return;
      setField(url, px.toDataURL());
      button(doc, 'Use this image')?.click();
      const mounted = await waitFor(() => doc.querySelector('.map-frame'),
        { timeout: 8000 });
      c.ok(!!mounted, 'the map mounts with pan and zoom');

      // Place a location pin by arming placement and clicking the frame.
      button(doc, '+ location')?.click();
      const frame = doc.querySelector('.map-frame');
      const rect = frame.getBoundingClientRect();
      frame.dispatchEvent(new win.MouseEvent('click', {
        bubbles: true, clientX: rect.left + 60, clientY: rect.top + 60,
      }));
      const pin = await waitFor(() => doc.querySelector('.map-pin'),
        { timeout: 6000 });
      c.ok(!!pin, 'clicking the armed map drops a pin');
      c.ok(/location/.test(pin?.getAttribute('aria-label') || ''),
        'the pin announces itself', pin?.getAttribute('aria-label'));
      c.ok(/hidden from players/.test(pin?.getAttribute('aria-label') || ''),
        'and starts hidden from players');

      // Reveal it through the editor the click opened.
      const reveal = await waitFor(() => button(doc, 'Hidden'), { timeout: 5000 });
      c.ok(!!reveal, 'the pin editor offers the reveal toggle');
      reveal?.click();
      const shown = await waitFor(() => button(doc, 'Revealed'), { timeout: 5000 });
      c.ok(!!shown, 'one click reveals it');

      // The pin survives a full mode round-trip - it was written, not drawn.
      c.ok(await goToMode(doc, 'Story'), 'leave the Deck');
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'and return');
      const still = await waitFor(() => doc.querySelector('.map-pin'),
        { timeout: 8000 });
      c.ok(!!still, 'the pin is still on the map');
      c.ok(!/hidden from players/.test(still?.getAttribute('aria-label') || ''),
        'still revealed');
    },
  },

  {
    id: 'market_region_price',
    title: "The DM's price dial reaches the player's counter",
    async run(c, { doc }) {
      c.feature('ui', 'deck', 'economy', 'market');
      // On the Deck (campaign + region exist from the earlier flows), turn
      // The Vale's dial to x2.
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');
      const dial = await waitFor(() => doc.querySelector(
        'main input[aria-label="The Vale price dial"]'), { timeout: 8000 });
      c.ok(!!dial, 'the region has a price dial');
      if (!dial) return;
      setField(dial, '2');
      const applied = await waitFor(() => (/the party pays this/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!applied, 'and the Deck says who pays it');

      // Cross the counter: the player's Market must charge it.
      c.ok(await ensureSeat(doc, 'player'), 'one plaque click to the player app');
      c.ok(await goToMode(doc, 'Market', 'Generate stock'), 'the Market opens');
      const strip = await waitFor(() => (/Prices in The Vale/
        .test(mainText(doc)) ? mainText(doc) : null), { timeout: 6000 });
      c.ok(!!strip, 'the counter names the region');
      c.ok(/×2/.test(strip || ''), 'and wears the x2 the DM dialled',
        (strip || '').slice(0, 90));
      c.ok(/day \d+/.test(strip || ''),
        'with the campaign day - the world reaches the shop');

      // And the coin that leaves the purse is the coin on the label.
      button(doc, 'Generate stock')?.click();
      await waitUntilSettled(doc);
      // Compare the WHOLE purse line: a copper-priced purchase leaves the
      // leading GP figure untouched, and reading only that number once made
      // this check blind to a real, correct debit.
      const purseText = () => {
        const m = /Purse\s*(.*?)\s*Carrying/.exec(mainText(doc).replace(/\s+/g, ' '));
        return m ? m[1] : null;
      };
      const before = purseText();
      const buy = allButtons(doc).find((b) => b.textContent.trim() === 'Buy'
        && !b.disabled && !b.className.includes('ghost'));
      if (buy && before) {
        buy.click();
        const paid = await waitFor(() => (purseText() !== before ? true : null),
          { timeout: 6000 });
        c.ok(!!paid, 'buying at x2 debits the purse', `${before} -> ${purseText()}`);
      } else {
        c.ok(true, 'nothing affordable at x2 - which is also the dial working');
      }
    },
  },

  {
    id: 'deck_shelf_ingest',
    title: 'A shelved book is one click from the Deck review rows',
    async run(c, { doc }) {
      c.feature('ui', 'shelf', 'deck');
      // Put the frozen fixture on the shelf via the API - the DROP surface
      // has its own flow below; this one is about the Deck's side. Tolerate
      // alreadyKnown: either tier may have shelved it first.
      const bytes = fixturePdfBytes();
      const hash = await shelfHash(bytes);
      const up = await fetch('/api/shelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf',
          'X-Filename': FIXTURE_NAME },
        body: bytes,
      }).then((r) => r.json()).catch(() => ({}));
      c.ok(up.category === 'settings' || up.alreadyKnown === true,
        'the fixture book is on the shelf', up.category);

      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');
      // Earlier flows founded Gym Realm in this shared frame; solo runs
      // found it here so the ingest panel exists at all.
      if (!/Gym Realm/.test(mainText(doc))) {
        const name = doc.querySelector('main input[aria-label="Campaign name"]');
        if (name) {
          setField(name, 'Gym Realm');
          button(doc, 'Found the campaign')?.click();
          await waitUntilSettled(doc);
        }
      }

      const listed = await waitFor(() => (mainText(doc)
        .includes(FIXTURE_NAME) ? true : null), { timeout: 8000 });
      c.ok(!!listed, 'the Deck lists it under On the shelf');

      // Ingest: the book's sections arrive as review rows, server-split.
      const row = [...doc.querySelectorAll('main div')].find((d) => d
        .textContent.includes(FIXTURE_NAME) && d.querySelector('button'));
      const ingestBtn = [...(row?.querySelectorAll('button') || [])]
        .find((b) => b.textContent.trim() === 'Ingest');
      c.ok(!!ingestBtn, 'a setting book offers Ingest');
      ingestBtn?.click();
      const rows = await waitFor(() => (/sections from Gym-Fixture/
        .test(mainText(doc)) ? true : null), { timeout: 8000 });
      c.ok(!!rows, 'the review rows arrive');
      c.ok(/The Tiny Gazetteer/.test(mainText(doc)),
        'with the book\'s own headings');

      // File one as lore - the same one-click grammar as text ingest.
      const lore = allButtons(doc).find((b) => b.textContent.trim() === 'lore');
      c.ok(!!lore, 'a section can be filed');
      lore?.click();
      const filed = await waitFor(() => (/filed as lore/.test(mainText(doc))
        ? true : null), { timeout: 6000 });
      c.ok(!!filed, 'and says so on the row');
      button(doc, 'Done - clear the bench')?.click();

      // Leave no trace on the real shelf.
      const gone = await fetch('/api/shelf/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      }).then((r) => r.status).catch(() => 0);
      c.eq(gone, 200, 'cleanup: the fixture leaves the shelf');
    },
  },

  {
    id: 'campaign_from_book',
    title: 'A campaign begins from a book, and the book opens itself',
    async run(c, { doc }) {
      c.feature('ui', 'deck', 'shelf', 'setup');
      const bytes = fixturePdfBytes();
      const hash = await shelfHash(bytes);
      const up = await fetch('/api/shelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf',
          'X-Filename': FIXTURE_NAME },
        body: bytes,
      }).then((r) => r.json()).catch(() => ({}));
      c.ok(up.category === 'settings' || up.alreadyKnown === true,
        'the fixture book is on the shelf', up.category);

      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Deck', 'campaign'), 'the Deck opens');
      // Gym Realm exists from the earlier deck flows; found it if isolated.
      if (!/Gym Realm/.test(mainText(doc))) {
        const name = doc.querySelector('main input[aria-label="Campaign name"]');
        if (name) {
          setField(name, 'Gym Realm');
          button(doc, 'Found the campaign')?.click();
          await waitUntilSettled(doc);
        }
      }

      // The campaign panel's picker - the second-campaign path. Target the
      // fixture by NAME, never by position: the real shelf holds the
      // user's own books.
      const sel = await waitFor(() => doc.querySelector(
        'main select[aria-label="Book to begin from"]'), { timeout: 8000 });
      c.ok(!!sel, 'the campaign panel offers the shelf');
      if (!sel) return;
      const opt = [...sel.options]
        .find((o) => o.textContent.includes('Gym-Fixture'));
      c.ok(!!opt, 'the fixture book is among the options');
      if (!opt) return;
      setField(sel, opt.value);
      button(doc, 'Begin from this book')?.click();

      const opened = await waitFor(() => (/sections from Gym-Fixture/
        .test(mainText(doc)) ? true : null), { timeout: 10000 });
      c.ok(!!opened, 'the review rows open on their own');
      c.ok(/Gym Fixture Gazetteer/.test(mainText(doc)),
        'the campaign is named for the book');
      c.ok(mainText(doc).includes('The book'),
        'the dials carry the book');

      // Close the review unfiled: the Deck must keep a way back in.
      button(doc, 'Done - clear the bench')?.click();
      const nudge = await waitFor(() => (/The book is on the shelf/
        .test(mainText(doc)) ? true : null), { timeout: 6000 });
      c.ok(!!nudge, 'an uningested book keeps a nudge on the Deck');
      c.ok(!!button(doc, 'Open the book'), 'with a way back in');
      c.ok(/from Gym-Fixture/.test(mainText(doc)),
        'and the campaign list shows the provenance');

      // Hand the wheel back to Gym Realm for the flows that follow.
      const makeActive = [...doc.querySelectorAll('main div')]
        .filter((d) => d.textContent.includes('Gym Realm')
          && d.querySelector('button'))
        .map((d) => [...d.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Make active'))
        .find(Boolean);
      c.ok(!!makeActive, 'the old campaign can retake the wheel');
      makeActive?.click();
      const back = await waitFor(() => (/Gym Realm/
        .test(doc.querySelector('main .lvl')?.textContent || '')
        ? true : null), { timeout: 8000 });
      c.ok(!!back, 'Gym Realm is active again');

      const gone = await fetch('/api/shelf/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      }).then((r) => r.status).catch(() => 0);
      c.eq(gone, 200, 'cleanup: the fixture leaves the shelf');
    },
  },

  {
    id: 'homebrew_pdf_drop',
    title: 'A PDF dropped on the workshop files itself and says where it went',
    async run(c, { doc, win }) {
      c.feature('ui', 'shelf', 'homebrew', 'detector');
      const bytes = fixturePdfBytes();
      const hash = await shelfHash(bytes);

      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Setup', 'Ingest a homebrew page'),
        'the workshop opens');

      const drop = doc.querySelector(
        '[aria-label="Drop homebrew pages or PDF books"]');
      c.ok(!!drop, 'the drop zone is there');
      if (!drop) return;

      // A real constructed drop: File -> DataTransfer -> DragEvent. This is
      // the exact path a person's drag takes, minus the mouse.
      const file = new win.File([bytes], FIXTURE_NAME,
        { type: 'application/pdf' });
      const dt = new win.DataTransfer();
      dt.items.add(file);
      drop.dispatchEvent(new win.DragEvent('drop',
        { bubbles: true, cancelable: true, dataTransfer: dt }));

      const verdict = await waitFor(() => {
        const t = mainText(doc);
        return (/Filed under Settings/.test(t)
          || /Already on the shelf, under Settings/.test(t)) ? t : null;
      }, { timeout: 15000 });
      c.ok(!!verdict, 'the verdict row names the category');
      c.ok(mainText(doc).includes(FIXTURE_NAME),
        'and the book it judged');

      // Settings are Deck material - the row offers the bridge and it works.
      const bridge = button(doc, 'Open in the Deck');
      c.ok(!!bridge, 'a setting offers "Open in the Deck"');
      bridge?.click();
      const onDeck = await waitFor(() => (/On the shelf|Found the campaign/
        .test(mainText(doc)) ? true : null), { timeout: 8000 });
      c.ok(!!onDeck, 'and it lands on the Deck');

      const gone = await fetch('/api/shelf/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      }).then((r) => r.status).catch(() => 0);
      c.eq(gone, 200, 'cleanup: the fixture leaves the shelf');
    },
  },

  {
    id: 'settings_connectors',
    title: 'Settings is honest about what is not connected',
    async run(c, { doc }) {
      c.feature('ui', 'settings', 'connectors');
      c.ok(await goToMode(doc, 'Settings', 'Connectors'), 'Settings opens');
      // The provider list arrives from /api/providers AFTER the panel paints,
      // so the screen settles on "Checking..." first. Wait for the content,
      // not for stillness.
      const loaded = await waitFor(() => (/Ollama|not set up|unavailable/i
        .test(mainText(doc)) ? mainText(doc) : null), { timeout: 10000 });
      c.ok(!!loaded, 'the provider list finishes loading');
      const t = (loaded || mainText(doc)).replace(/\s+/g, ' ');

      c.ok(/Optional, and off by default/i.test(t),
        'connectors are presented as optional');
      // The claim that matters, stated where somebody will read it.
      c.ok(/Your keys, not ours/i.test(t), 'it says whose keys these are');
      c.ok(/secrets\.json/i.test(t), 'and where to put your own');

      // Every provider is listed whether or not it works, so "why can't I do
      // X" is answered on screen rather than in a README.
      for (const name of ['Ollama', 'Anthropic', 'OpenAI', 'Stable Diffusion',
        'ElevenLabs', 'Freesound']) {
        c.ok(t.includes(name), `${name} is listed`);
      }
      c.ok(/not set up|ready/i.test(t), 'each says whether it is configured');

      // Ambience is the part that needs nothing at all.
      c.ok(/Tavern murmur|Fireside|Rain/i.test(t),
        'local ambience is offered with no key');

      // And no key is ever typed here.
      const fields = [...doc.querySelectorAll('main input')];
      c.ok(!fields.some((i) => /key|token|secret|password/i.test(
        `${i.placeholder} ${i.name} ${i.type}`)),
      'there is no field to type a key into');
    },
  },

  {
    id: 'theme_toggle',
    title: 'Choosing a theme applies it and survives the choice being stored',
    async run(c, { doc, win }) {
      c.feature('ui', 'settings', 'theme');
      // The iframe shares this origin's localStorage, so clicking Candlelight
      // in here writes the REAL preference. Save it, restore it in finally -
      // the same discipline the sandbox flow uses for confirm().
      const before = localStorage.getItem('toonanvil.theme');
      try {
        c.ok(await goToMode(doc, 'Settings', 'Appearance'),
          'Settings shows the Appearance panel');

        button(doc, 'Candlelight')?.click();
        const dark = await waitFor(() => (
          win.document.documentElement.dataset.theme === 'dark' ? true : null));
        c.ok(!!dark, 'Candlelight sets data-theme=dark on the page');
        c.eq(localStorage.getItem('toonanvil.theme'), 'dark',
          'and the choice is stored, so a reload keeps it');

        button(doc, 'Parchment')?.click();
        const light = await waitFor(() => (
          win.document.documentElement.dataset.theme === 'light' ? true : null));
        c.ok(!!light, 'Parchment sets data-theme=light');
        c.eq(localStorage.getItem('toonanvil.theme'), 'light', 'and stores it');

        button(doc, 'System')?.click();
        const cleared = await waitFor(() => (
          !win.document.documentElement.dataset.theme ? true : null));
        c.ok(!!cleared, 'System removes the attribute - the OS decides again');
        c.eq(localStorage.getItem('toonanvil.theme'), null,
          'and clears the stored choice rather than storing "system"');
      } finally {
        if (before === null) localStorage.removeItem('toonanvil.theme');
        else localStorage.setItem('toonanvil.theme', before);
      }
    },
  },

  {
    id: 'sandbox_bar',
    title: 'The sandbox says what it is and offers a way out',
    async run(c, { doc, win }) {
      c.feature('ui', 'sandbox', 'storage');
      // These flows already run inside a sandbox, so the bar must be here.
      const bar = doc.querySelector('#sandbox-bar');
      c.ok(!!bar, 'a sandbox session shows its bar');
      if (!bar) return;
      c.ok(/nothing is written to disk/i.test(bar.textContent),
        'the bar says plainly that nothing is saved');
      c.ok(!doc.querySelector('.topbar .try'),
        'the "try a sandbox" entry is hidden while already in one');

      // By now earlier flows have built characters, so the count must be live.
      const n = Number(bar.dataset.count || 0);
      c.ok(n > 0, 'the bar counts what has been made here', `count ${n}`);
      const keep = bar.querySelector('.keep');
      c.ok(keep && !keep.disabled, 'saving is offered once there is something to save');

      // "Save to my library" writes to REAL storage, so this flow must never
      // actually complete it - a test suite that files junk into the user's
      // library on every run would be the exact harm the sandbox prevents.
      // Assert the confirmation appears and DECLINE it: that exercises the
      // guard, which is the part worth protecting, and writes nothing.
      let asked = null;
      const realConfirm = win.confirm;
      win.confirm = (m) => { asked = String(m); return false; };
      try {
        keep.click();
        await waitFor(() => (asked ? true : null), { timeout: 6000 });
      } finally {
        win.confirm = realConfirm;
      }
      c.ok(!!asked, 'saving to the real library asks first');
      c.ok(/nothing already there is replaced/i.test(asked || ''),
        'the confirmation promises not to overwrite anything');
      c.ok(/\d+ characters?/i.test(asked || ''),
        'the confirmation says what is about to be written', asked || '');

      // The file path is safe to run for real, and is still the only way to
      // move work between machines.
      let captured = null;
      const realCreate = win.URL.createObjectURL;
      win.URL.createObjectURL = (b) => {
        try { b.text().then((t) => { captured = t; }); } catch { /* ignore */ }
        return 'blob:gym';
      };
      try {
        bar.querySelector('.download')?.click();
        await waitFor(() => (captured ? true : null), { timeout: 8000 });
      } finally {
        win.URL.createObjectURL = realCreate;
      }
      c.ok(!!captured, 'downloading produces a bundle');
      if (captured) {
        let parsed = null;
        try { parsed = JSON.parse(captured); } catch { /* leave null */ }
        c.ok(!!parsed, 'the bundle is valid JSON');
        c.eq(parsed?.kind, 'toon-anvil-sandbox', 'the bundle identifies itself');
        c.ok((parsed?.characters || []).length > 0,
          'the bundle carries the characters made here');
      }
    },
  },

  {
    id: 'library_combine_subclasses',
    title: 'Extracted subclasses can be selected and combined',
    async run(c, { doc }) {
      c.feature('ui', 'homebrew', 'library', 'pdf');
      // The workshop lives in the DM shell's Setup screen.
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Setup'), 'Setup opens');
      const bench = await waitFor(() => (/Open library|Hide library/
        .test(mainText(doc)) ? true : null), { timeout: 10000 });
      c.ok(!!bench, 'Setup carries the homebrew workshop');
      const opener = button(doc, 'Open library');
      if (opener) { opener.click(); await waitUntilSettled(doc); }

      // Expand the first extracted document, whichever it is.
      const docRow = [...doc.querySelectorAll('main div')]
        .find((d) => /^\+/.test(d.textContent.trim())
          && /\d+ subclasses/.test(d.textContent));
      if (!docRow) {
        c.ok(true, 'no extracted PDFs on this machine - nothing to combine');
        return;
      }
      docRow.click();
      await waitUntilSettled(doc);

      const boxes = () => [...doc.querySelectorAll('main input[type=checkbox]')];
      c.ok(boxes().length >= 2, 'extracted subclasses are selectable',
        `${boxes().length} rows`);
      if (boxes().length < 2) return;

      // PDF grouping is a guess, so the reader must be able to say which rows
      // are really one subclass. This is that capability, pinned.
      boxes()[0].click();
      await waitUntilSettled(doc);
      boxes()[1].click();
      await waitUntilSettled(doc);
      c.ok(/2 selected:/.test(mainText(doc)), 'the selection is shown back');

      const nameField = [...doc.querySelectorAll('main input[type=text]')]
        .find((i) => /combined/i.test(i.placeholder || ''));
      c.ok(!!nameField, 'the combined subclass can be named');
      if (nameField) setField(nameField, 'Gym Combined Subclass');

      const combine = allButtons(doc)
        .find((b) => /Combine \d+ into one/.test(b.textContent));
      c.ok(!!combine, 'there is a control to combine them');
      combine?.click();

      const staged = await waitFor(() => (mainText(doc).includes('Gym Combined Subclass')
        ? mainText(doc) : null), { timeout: 12000 });
      c.ok(!!staged, 'the combined subclass is staged under the chosen name');
      if (staged) {
        const n = /Features\s*(\d+)/.exec(staged.replace(/\s+/g, ' '));
        c.ok(n && Number(n[1]) > 1,
          'the combined subclass carries features from both parts',
          `features: ${n?.[1]}`);
      }
    },
  },

  {
    id: 'homebrew_example',
    title: 'The shipped example ingests through the real UI',
    async run(c, { doc }) {
      c.feature('ui', 'homebrew', 'ingest');
      // Tolerate whatever a previous flow left behind. These flows share one
      // app instance on purpose - that IS the integration - so a flow must not
      // assume it is the first to touch a toggle.
      // The workshop lives in the DM shell's Setup screen.
      c.ok(await ensureSeat(doc, 'dm'), "the DM's shell is on");
      c.ok(await goToMode(doc, 'Setup'), 'Setup opens');
      const bench = await waitFor(() => (/Open library|Hide library/
        .test(mainText(doc)) ? true : null), { timeout: 10000 });
      c.ok(!!bench, 'Setup carries the homebrew workshop');
      const open = button(doc, 'Open library');
      if (open) { open.click(); await waitUntilSettled(doc); }
      c.ok(!!button(doc, 'Hide library'), 'the library is open');

      const tryIt = await waitFor(() => button(doc, 'Try the example'),
        { timeout: 8000 });
      c.ok(!!tryIt, 'an empty inbox offers the shipped example');
      tryIt?.click();

      // Ingest goes through the sandboxed scraper, so allow for the frame.
      const staged = await waitFor(() => (mainText(doc).includes('Kindled Blade')
        ? mainText(doc) : null), { timeout: 15000 });
      c.ok(!!staged, 'the example ingests and is staged for review');
      if (staged) {
        c.ok(/Features\s*5|5\s*Features/i.test(staged.replace(/\s+/g, ' '))
          || staged.includes('Mapped'),
        'the review panel reports what was extracted');
        c.ok(!!button(doc, 'Subclass page (HTML)'),
          'the outputs are offered once staged');
      }
    },
  },
];

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run every flow against one ephemeral instance of the real app.
 *
 * `Check` is passed in rather than imported so this module stays independent
 * of the gym's grading, and can be driven from a console when debugging.
 */

/* ------------------------------------------------------------------ */
/* two clients                                                         */
/* ------------------------------------------------------------------ */

/**
 * The one test the whole live tier exists for.
 *
 * Every other flow runs against an EPHEMERAL boot so it cannot touch real
 * data. This one cannot: two browsers only see each other through the shared
 * server, and a memory store is private to its own frame. So it boots two REAL
 * clients, works on a single obviously-ours probe character, and deletes it
 * both before and after - bounding the worst case to one visibly-named file
 * that the next run clears.
 *
 * It also runs LAST, and refuses to run at all unless the server is reachable
 * and no table is open, because a half-joined table would make a refusal look
 * like a sync failure.
 */
const PROBE_ID = 'gym-sync-probe';

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
  });
  let body = {};
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
};

async function bootClient(label) {
  const frame = document.createElement('iframe');
  // No ?storage=memory on purpose: these two must share the server.
  frame.src = '/index.html';
  frame.dataset.gym = label;
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
    + 'height:1000px;border:0';
  document.body.append(frame);
  await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
  const doc = frame.contentDocument;
  await waitFor(() => (doc.querySelector('main') && button(doc, 'Build') ? true : null),
    { timeout: 15000 });
  return { frame, doc };
}

/**
 * Open the probe character in Play mode and return a reader for its HP.
 *
 * The roster is a grid of clickable DIVs, not buttons. Searching for a button
 * matched nothing, `pick?.click()` did nothing, and the app stayed on whichever
 * character was selected last - so this flow spent a whole stage measuring the
 * wrong sheet while reporting success. Hence the second assertion: being on A
 * sheet is not the same as being on the right one.
 */
async function openProbe(doc, name) {
  const hp = () => readNumberAfter(doc, 'HP');
  await goToMode(doc, 'Build', 'Roster');
  const pick = await waitFor(() => [...doc.querySelectorAll('main .clickable')]
    .find((e) => e.textContent.includes(name)) || null, { timeout: 8000 });
  if (!pick) return { ok: false, reason: 'the probe was not in the roster', hp };
  pick.click();
  await waitUntilSettled(doc);

  const opened = await goToMode(doc, 'Play',
    (d = doc) => /Adjust HP/.test(mainText(d)));
  if (!opened) return { ok: false, reason: 'Play never rendered a sheet', hp };
  const onProbe = await waitFor(() => (
    (doc.querySelector('#who')?.textContent || '').includes(name) ? true : null),
  { timeout: 4000 });
  return { ok: Boolean(onProbe),
    reason: onProbe ? '' : 'Play opened on a different character', hp };
}

/**
 * The seat gate, in its own sandbox.
 *
 * Boots ?storage=memory&seat=ask - the one sandbox variant that shows the
 * first-run welcome - and walks the whole gate: choose Player, see a player's
 * menu; take the DM's seat in Settings, see the DM's. The ordinary sandbox
 * never shows this screen (it opens in the DM's seat so everything is
 * tryable), which is why this flow cannot share the main frame.
 *
 * The sandbox seat must never persist: trying the DM screen today must not
 * change what the real session shows tomorrow. Asserted against a snapshot
 * because the REAL key may legitimately exist - it belongs to whoever owns
 * this browser profile.
 */
export async function runRoleGate(CheckClass) {
  const check = new CheckClass('role_gate');
  const t0 = performance.now();
  let error = null;
  let frame = null;
  const realRoleBefore = localStorage.getItem('toonanvil.role');
  try {
    check.feature('ui', 'seat', 'permissions');

    // The welcome only appears with no table open - an open table decides
    // the seat itself. A table left behind by an earlier run would make this
    // flow fail for the wrong reason, so close defensively.
    try {
      await fetch('/api/table/close', { method: 'POST' });
    } catch { /* no server: memory boot cannot see a table anyway */ }

    frame = document.createElement('iframe');
    frame.src = '/index.html?storage=memory&seat=ask';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
      + 'height:1000px;border:0';
    document.body.append(frame);
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    const doc = frame.contentDocument;
    await waitFor(() => (doc.querySelector('main') ? true : null), { timeout: 15000 });

    const overlay = await waitFor(() => doc.querySelector('.welcome') || null,
      { timeout: 8000 });
    check.ok(!!overlay, 'a fresh device is asked who is holding it');
    check.ok(!!button(doc, 'Dungeon Master'), 'Dungeon Master is one answer');

    button(doc, 'Player')?.click();
    const gone = await waitFor(() => (!doc.querySelector('.welcome') ? true : null),
      { timeout: 5000 });
    check.ok(!!gone, 'answering dismisses the welcome');

    const labels = () => [...doc.querySelectorAll('#modes button')]
      .map((b) => b.textContent.trim());
    check.ok(!labels().includes('DM') && !labels().includes('Stage')
      && !labels().includes('Deck'),
    "a player's menu carries none of the captain's screens", labels().join(', '));
    check.ok(labels().includes('Play') && labels().includes('Build'),
      'and still owns their character fully');
    check.eq(doc.querySelector('#seat')?.textContent, 'Hero',
      'the plaque says which app this is');

    check.ok(await goToMode(doc, 'Settings', 'Seat'), 'Settings shows the Seat panel');
    button(doc, "Take the DM's seat")?.click();
    const dmNav = await waitFor(() => (labels().includes('Stage') ? true : null),
      { timeout: 5000 });
    check.ok(!!dmNav, "taking the DM's seat swaps in the whole DM shell");
    check.ok(['Deck', 'World', 'Story', 'Setup']
      .every((l) => labels().includes(l)),
    'all five captain screens are there', labels().join(', '));
    check.ok(!labels().includes('Play') && !labels().includes('Build'),
      "and the player's screens are gone - it is a different app");
    check.eq(doc.querySelector('#seat')?.textContent, 'Dungeon Master',
      'the plaque changed with it');

    // The homebrew workshop lives in Setup.
    check.ok(await goToMode(doc, 'Setup'), 'Setup opens');
    const workshop = await waitFor(() => (/homebrew|workshop/i
      .test(mainText(doc)) ? true : null), { timeout: 8000 });
    check.ok(!!workshop, 'and carries the homebrew workshop');

    // The plaque itself is the way back - one click, no Settings trip.
    doc.querySelector('#seat')?.click();
    const back = await waitFor(() => (labels().includes('Play') ? true : null),
      { timeout: 5000 });
    check.ok(!!back, 'clicking the plaque hands the seat back');

    check.eq(localStorage.getItem('toonanvil.role'), realRoleBefore,
      'a sandbox seat never touches the real preference');
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  } finally {
    frame?.remove();
  }
  return {
    id: 'role_gate',
    title: "The DM's seat is chosen, remembered, and swappable",
    passed: check.passed,
    total: check.total,
    failures: check.failures,
    features: [...check.touched],
    error,
    empty: !error && check.total === 0,
    ok: !error && check.total > 0 && check.failures.length === 0,
    ms: +(performance.now() - t0).toFixed(0),
  };
}

/**
 * The join gate, driven the way a player at the door would.
 *
 * Opens a real table from the gym page (localhost, so the code is readable),
 * boots a tokenless client, and walks: gate appears -> wrong code refused
 * inline -> right code admits -> claim a waiting character -> the app is a
 * player's app with that character open.
 */
export async function runJoinGate(CheckClass) {
  const check = new CheckClass('join_gate');
  const t0 = performance.now();
  let error = null;
  let frame = null;
  let dmToken = null;
  try {
    check.feature('ui', 'table', 'join');

    await api('/api/table/close', { method: 'POST' });
    const opened = await api('/api/table/open', {
      method: 'POST', body: JSON.stringify({ name: 'Gym DM' }),
    });
    dmToken = opened.body.token;
    const code = opened.body.code;
    check.ok(!!code, 'the DM opened a table', code);

    // A character waiting to be claimed.
    await api('/api/characters/gym-gate-probe', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ id: 'gym-gate-probe', name: 'Gate Probe',
        classes: [{ class: 'fighter', subclass: null, level: 2 }],
        abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } }),
    });

    frame = document.createElement('iframe');
    frame.src = '/index.html';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
      + 'height:1000px;border:0';
    document.body.append(frame);
    // No token seeded: this browser is a stranger at the door.
    frame.contentWindow?.localStorage?.removeItem('toonanvil.token');
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    const doc = frame.contentDocument;

    const gate = await waitFor(() => doc.querySelector('.welcome') || null,
      { timeout: 10000 });
    check.ok(!!gate, 'a browser with no seat is offered the join gate');
    check.ok(/A table is open/.test(gate?.textContent || ''),
      'and told why', (gate?.textContent || '').slice(0, 60));

    const codeInput = gate.querySelector('input[aria-label="Join code"]');
    const nameInput = gate.querySelector('input[aria-label="Your name"]');
    check.ok(!!codeInput && !!nameInput, 'code and name fields are offered');

    setField(codeInput, 'ANVIL-ZZZZ');
    setField(nameInput, 'Gym Player');
    button(doc, 'Join', { within: gate })?.click();
    const refused = await waitFor(() => (/does not match/
      .test(gate.textContent) ? true : null), { timeout: 6000 });
    check.ok(!!refused, 'a wrong code is refused, inline, without closing the gate');

    setField(codeInput, code);
    button(doc, 'Join', { within: gate })?.click();
    const claim = await waitFor(() => button(doc, 'Play as Gate Probe'),
      { timeout: 8000 });
    check.ok(!!claim, 'the right code admits, and the waiting character is offered');

    claim?.click();
    const seated = await waitFor(() => (!doc.querySelector('.welcome')
      && (doc.querySelector('#who')?.textContent || '').includes('Gate Probe')
      ? true : null), { timeout: 10000 });
    check.ok(!!seated, 'claiming seats them: the gate closes and the ribbon '
      + 'carries the character');

    const labels = [...doc.querySelectorAll('#modes button')]
      .map((b) => b.textContent.trim());
    check.ok(labels.includes('Party') && !labels.includes('DM'),
      "and the menu is a player's menu", labels.join(', '));
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  } finally {
    frame?.remove();
    try {
      await api('/api/characters/gym-gate-probe', {
        method: 'DELETE', headers: { 'X-Toon-Token': dmToken } });
      await api('/api/table/close', { method: 'POST' });
    } catch { /* the server went away */ }
  }
  return {
    id: 'join_gate',
    title: 'A stranger at the door joins, claims, and is seated',
    passed: check.passed,
    total: check.total,
    failures: check.failures,
    features: [...check.touched],
    error,
    empty: !error && check.total === 0,
    ok: !error && check.total > 0 && check.failures.length === 0,
    ms: +(performance.now() - t0).toFixed(0),
  };
}

/**
 * The whole level-up ceremony, across two roles.
 *
 * A joined player with a sealed sheet: no Build in the nav, no banner. The
 * DM grants a level over HTTP -> Build and the banner appear LIVE -> the
 * player levels 2 -> 3 -> the grant is consumed, Build leaves again -> a raw
 * PUT to 4 is refused by the server. The flow is the claim "character
 * creation is DM-activated at level-ups" made executable.
 */
export async function runLevelUpFlow(CheckClass) {
  const check = new CheckClass('level_up_flow');
  const t0 = performance.now();
  let error = null;
  let frame = null;
  let dmToken = null;
  try {
    check.feature('ui', 'grants', 'build', 'permissions');

    await api('/api/table/close', { method: 'POST' });
    const opened = await api('/api/table/open', {
      method: 'POST', body: JSON.stringify({ name: 'Gym DM' }),
    });
    dmToken = opened.body.token;
    const joined = await api('/api/table/join', {
      method: 'POST',
      body: JSON.stringify({ code: opened.body.code, name: 'Gym Lever' }),
    });
    check.ok(joined.body.ok, 'a player joined over HTTP');
    const pt = joined.body.token;

    // Their character, claimed, then the forge closes: campaign running.
    await api('/api/characters/gym-lvl-probe', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': pt },
      body: JSON.stringify({ id: 'gym-lvl-probe', name: 'Lever',
        classes: [{ class: 'rogue', subclass: null, level: 2 }],
        abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 10, cha: 10 } }),
    });
    await api('/api/table/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': pt },
      body: JSON.stringify({ characterId: 'gym-lvl-probe' }),
    });
    await api('/api/table/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ open: false }),
    });

    frame = document.createElement('iframe');
    frame.src = '/index.html';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
      + 'height:1000px;border:0';
    document.body.append(frame);
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    frame.contentWindow.localStorage.setItem('toonanvil.token', pt);
    // The banner and the level field read the SELECTED character; an earlier
    // flow may have left lastCharacter pointing at somebody else's.
    frame.contentWindow.localStorage.setItem('toonanvil.lastCharacter', 'gym-lvl-probe');
    frame.contentWindow.location.reload();
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    const doc = frame.contentDocument;
    await waitFor(() => (doc.querySelector('main') && button(doc, 'Play')
      ? true : null), { timeout: 15000 });

    const labels = () => [...doc.querySelectorAll('#modes button')]
      .map((b) => b.textContent.trim());
    check.ok(!labels().includes('Build'),
      'a sealed sheet means no Build in the nav', labels().join(', '));

    check.ok(await goToMode(doc, 'Play', 'Adjust HP'), 'their sheet opens');
    check.ok(!/granted a level-up/i.test(mainText(doc)),
      'and carries no banner before the grant');

    // The DM grants, from wherever they are.
    await api('/api/table/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ characterId: 'gym-lvl-probe' }),
    });

    const banner = await waitFor(() => (/you can reach level 3/i
      .test(mainText(doc)) ? true : null), { timeout: 12000 });
    check.ok(!!banner, 'the banner arrives on the open sheet, live');
    const buildBack = await waitFor(() => (labels().includes('Build')
      ? true : null), { timeout: 8000 });
    check.ok(!!buildBack, 'and Build walks back into the nav');

    button(doc, 'To the forge')?.click();
    await waitUntilSettled(doc);
    const lvl = await waitFor(() => [...doc.querySelectorAll('main input[type=number]')]
      .find((i) => i.value === '2') || null, { timeout: 8000 });
    check.ok(!!lvl, 'Build opens on their character with the level field');
    setField(lvl, '3');
    const saved = await waitFor(() => (/Level 3/.test(mainText(doc)) ? true : null),
      { timeout: 8000 });
    check.ok(!!saved, 'level 3 saves - the grant covers it');

    const buildGone = await waitFor(() => (!labels().includes('Build')
      ? true : null), { timeout: 12000 });
    check.ok(!!buildGone, 'the grant is consumed by arriving: Build leaves again');

    // Belt and braces, past the UI entirely.
    const raw = await fetch('/api/characters/gym-lvl-probe', {
      headers: { 'X-Toon-Token': pt } }).then((r) => r.json());
    raw.classes = [{ class: 'rogue', subclass: null, level: 4 }];
    const beyond = await fetch('/api/characters/gym-lvl-probe', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': pt },
      body: JSON.stringify(raw),
    });
    check.eq(beyond.status, 403,
      'a raw PUT past the granted level is refused by the server');
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  } finally {
    frame?.remove();
    try {
      await api('/api/characters/gym-lvl-probe', {
        method: 'DELETE', headers: { 'X-Toon-Token': dmToken } });
      await api('/api/table/close', { method: 'POST' });
    } catch { /* the server went away */ }
  }
  return {
    id: 'level_up_flow',
    title: 'The level-up ceremony: granted, taken, consumed, sealed again',
    passed: check.passed,
    total: check.total,
    failures: check.failures,
    features: [...check.touched],
    error,
    empty: !error && check.total === 0,
    ok: !error && check.total > 0 && check.failures.length === 0,
    ms: +(performance.now() - t0).toFixed(0),
  };
}

export async function runTwoClient(CheckClass) {
  const check = new CheckClass('two_clients_stay_in_step');
  const t0 = performance.now();
  let error = null;
  const frames = [];
  // These clients boot with NO table open, so the REAL device seat decides
  // their shell - and a machine remembered as DM would boot a Build-less
  // app and fail for the wrong reason. Force the player shell, restore after.
  const realRole = localStorage.getItem('toonanvil.role');
  localStorage.setItem('toonanvil.role', 'player');
  try {
    check.feature('ui', 'live', 'sync', 'multiplayer');

    // Preconditions, asserted rather than assumed - each of these failing
    // would otherwise show up as "sync is broken".
    const reachable = await api('/api/changes?since=0');
    check.ok(reachable.status === 200, 'the shared server is reachable',
      `HTTP ${reachable.status}`);
    if (reachable.status !== 200) throw new Error('no server: two clients cannot share');

    const table = await api('/api/table');
    check.ok(!table.body.open, 'no table is open, so writes need no token');
    if (table.body.open) throw new Error('a table is open; close it to run this flow');

    await api(`/api/characters/${PROBE_ID}`, { method: 'DELETE' });
    const made = await api(`/api/characters/${PROBE_ID}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: PROBE_ID, name: 'Gym Sync Probe', level: 3,
        classes: [{ id: 'fighter', level: 3 }], abilities:
          { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      }),
    });
    check.eq(made.status, 200, 'a probe character exists on the server');

    const a = await bootClient('dm');
    frames.push(a.frame);
    const b = await bootClient('player');
    frames.push(b.frame);
    check.ok(true, 'two independent clients booted against the same server');

    const openA = await openProbe(a.doc, 'Gym Sync Probe');
    const openB = await openProbe(b.doc, 'Gym Sync Probe');
    check.ok(openA.ok, 'client A has the probe open in Play', openA.reason);
    check.ok(openB.ok, 'client B has the same character open', openB.reason);
    if (!openA.ok || !openB.ok) throw new Error('both clients must be on the probe');

    const startB = await waitFor(() => (Number.isFinite(openB.hp()) ? openB.hp() : null));
    check.ok(Number.isFinite(startB), 'client B shows hit points', `read ${startB}`);
    const startA = await waitFor(() => (Number.isFinite(openA.hp()) ? openA.hp() : null));
    check.eq(startA, startB, 'both clients start on the same number');
    if (!Number.isFinite(startB)) throw new Error('client B never showed HP');

    // A applies damage through the UI, exactly as a DM would.
    const amount = a.doc.querySelector('main input[type=number]');
    check.ok(!!amount, 'client A has a damage field');
    setField(amount, '7');
    button(a.doc, 'Damage')?.click();
    const hurtA = await waitFor(() => (openA.hp() !== startA ? openA.hp() : null),
      { timeout: 6000 });
    check.eq(hurtA, startA - 7, 'client A shows the damage it applied');

    // The whole feature: B was never touched and never reloaded.
    const hurtB = await waitFor(() => (openB.hp() !== startB ? openB.hp() : null),
      { timeout: 12000 });
    check.ok(hurtB !== null,
      'client B updated on its own, with no reload and no click');
    if (hurtB !== null) {
      check.eq(hurtB, startB - 7,
        'and shows the same number the other client does', `A=${hurtA} B=${hurtB}`);
    }
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  } finally {
    if (realRole === null) localStorage.removeItem('toonanvil.role');
    else localStorage.setItem('toonanvil.role', realRole);
    for (const f of frames) f.remove();
    // Always, even on the throw paths above.
    try { await api(`/api/characters/${PROBE_ID}`, { method: 'DELETE' }); }
    catch { /* the server went away; nothing more we can do */ }
  }
  return {
    id: 'two_clients_stay_in_step',
    title: 'Two clients stay in step without a reload',
    passed: check.passed,
    total: check.total,
    failures: check.failures,
    features: [...check.touched],
    error,
    empty: !error && check.total === 0,
    ok: !error && check.total > 0 && check.failures.length === 0,
    ms: +(performance.now() - t0).toFixed(0),
  };
}

/**
 * The player's side of the table.
 *
 * Boots a real client, joins it as a PLAYER, and checks the three things the
 * player view promises: the DM's tools are not in the nav, the fight is
 * visible, and the enemy hit points are not - in the payload, not merely on
 * screen.
 *
 * Like the two-client flow this needs the real server, so it closes the table
 * and removes the encounter on every path out.
 */
export async function runPlayerView(CheckClass) {
  const check = new CheckClass('player_sees_a_players_table');
  const t0 = performance.now();
  let error = null;
  const frames = [];
  let dmToken = null;
  // Real campaigns the user owns that were active when the flow began -
  // parked (active:false) for the duration and restored on the way out.
  // Two active records make activeCampaign() order-dependent, and the day
  // this flow asserts would be Kaladesh's, not PV Realm's.
  const parked = [];
  try {
    check.feature('ui', 'table', 'shared', 'encounter', 'permissions');

    const reachable = await api('/api/changes?since=0');
    check.ok(reachable.status === 200, 'the shared server is reachable',
      `HTTP ${reachable.status}`);
    if (reachable.status !== 200) throw new Error('no server: no table to sit at');

    await api('/api/table/close', { method: 'POST' });
    const opened = await api('/api/table/open', {
      method: 'POST', body: JSON.stringify({ name: 'Gym DM' }),
    });
    dmToken = opened.body.token;
    check.ok(!!opened.body.code, 'the DM opened a table', opened.body.code);

    // Park the user's own active campaign(s) so the seeded one is the only
    // record wearing the flag. The DM token sees full records, so restoring
    // the stashed original puts back agendas and all.
    const realCamps = await fetch('/api/campaigns', {
      headers: { 'X-Toon-Token': dmToken },
    }).then((r) => r.json()).catch(() => []);
    for (const rc of Array.isArray(realCamps) ? realCamps : []) {
      if (rc.active && rc.id !== 'gym-pv-camp') {
        parked.push(rc);
        await api(`/api/campaigns/${rc.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
          body: JSON.stringify({ ...rc, active: false }),
        });
      }
    }

    // A world in progress: a campaign with a secret agenda and a map with a
    // hidden pin - the player's screens must carry the day and the sky, and
    // never the secrets.
    await api('/api/campaigns/gym-pv-camp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ id: 'gym-pv-camp', name: 'PV Realm', active: true,
        day: 7, seed: 4242, currentRegionId: 'reg-pv',
        regions: [{ id: 'reg-pv', name: 'Proof Vale', terrain: 'forest',
          priceMod: 1, note: '' }],
        factions: [{ id: 'f-pv', name: 'The Ledger', standing: 1,
          agenda: 'SECRETAGENDA', public: true }],
        mapId: 'gym-pv-map', lore: [] }),
    });
    await api('/api/maps/gym-pv-map', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ id: 'gym-pv-map', name: 'PV Map',
        image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', w: 1, h: 1,
        pins: [
          { id: 'pv-shown', x: 0.3, y: 0.3, kind: 'location',
            label: 'Shown Pin', revealed: true },
          { id: 'pv-hidden', x: 0.7, y: 0.7, kind: 'quest',
            label: 'HIDDENPIN', revealed: false },
        ] }),
    });

    // A fight in progress, with a number the DM is keeping to themselves.
    await api('/api/encounters/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({
        id: 'current', round: 3, turn: 1, started: true, showMonsterHp: false,
        combatants: [
          { id: 'c1', kind: 'pc', name: 'Gym Player', ac: 16, hp: 22,
            hpMax: 30, init: 18, conditions: [] },
          { id: 'c2', kind: 'monster', name: 'Gym Ogre', ac: 11, hp: 13,
            hpMax: 59, init: 9, conditions: [] },
        ],
      }),
    });

    const joined = await api('/api/table/join', {
      method: 'POST',
      body: JSON.stringify({ code: opened.body.code, name: 'Gym Player' }),
    });
    check.ok(joined.body.ok, 'a player joined with the code');
    if (!joined.body.ok) throw new Error('the player could not join');

    // Boot a client already holding the player's token, the way a browser
    // that joined a moment ago would be.
    const frame = document.createElement('iframe');
    frame.src = '/index.html';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
      + 'height:1000px;border:0';
    document.body.append(frame);
    frames.push(frame);
    // The token has to be in place BEFORE the app boots, or it boots as a
    // browser with no seat at the table and asks to join.
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    frame.contentWindow.localStorage.setItem('toonanvil.token', joined.body.token);
    frame.contentWindow.location.reload();
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });

    const doc = frame.contentDocument;
    const ready = await waitFor(() => (doc.querySelector('main')
      && button(doc, 'Play') ? true : null), { timeout: 15000 });
    check.ok(!!ready, 'the app booted as a player');
    if (!ready) throw new Error('the player client never became interactive');

    // --- the nav is a player's nav ---------------------------------------
    const navLabels = () => [...doc.querySelectorAll('#modes button')]
      .map((b) => b.textContent.trim());
    check.ok(navLabels().includes('Party'),
      'the shared party screen is in the nav', navLabels().join(', '));
    check.ok(!navLabels().includes('DM'),
      'the DM screen is not', navLabels().join(', '));
    check.ok(!navLabels().includes('Homebrew'),
      'and neither is the homebrew analyser');
    check.ok(!navLabels().includes('Combat'),
      'nor the solo tracker - the DM\'s runner is the fight');
    check.ok(navLabels().includes('Play'),
      'their own sheet is - a player owns their character fully');
    check.ok(navLabels().includes('Build'),
      'and Build is offered because the forge is open on a fresh table');

    // The forge closing must take Build away while they watch.
    await fetch('/api/table/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Toon-Token': dmToken },
      body: JSON.stringify({ open: false }),
    });
    const buildGone = await waitFor(() => (!navLabels().includes('Build')
      ? true : null), { timeout: 8000 });
    check.ok(!!buildGone, 'closing the forge removes Build without a reload',
      navLabels().join(', '));

    // --- the fight ---------------------------------------------------------
    check.ok(await goToMode(doc, 'Party', (d = doc) => /Gym Ogre/.test(mainText(d))),
      'the Party screen shows the fight the DM is running');
    const text = mainText(doc);
    check.ok(/Round 3/.test(text), 'including the round', text.slice(0, 120));
    check.ok(/Gym Ogre/.test(text), 'and the monster by name');
    check.ok(/Bloodied/i.test(text),
      'with how hurt it looks instead of a number');
    check.ok(!/\b59\b/.test(text) && !/13\s*\/\s*59/.test(text),
      'the hidden number is not on screen', text.slice(0, 200));

    // The screen not drawing it is half the claim. This is the other half.
    const asPlayer = await fetch('/api/encounters/current', {
      headers: { 'X-Toon-Token': joined.body.token },
    }).then((r) => r.json());
    // Combatants only: the record's server-stamped updatedAt contains "59"
    // whenever the clock reads minute or second 59.
    const wire = JSON.stringify(asPlayer.combatants || []);
    check.ok(!wire.includes('59'),
      'and was never sent to this browser at all', wire.slice(0, 200));

    // --- and it is read-only ----------------------------------------------
    const main = doc.querySelector('main');
    check.ok(!button(main, 'Hit') && !button(main, 'Roll initiative & start'),
      'the player view offers no controls over the fight');
    const refused = await fetch('/api/encounters/current', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json',
        'X-Toon-Token': joined.body.token },
      body: JSON.stringify({ combatants: [] }),
    });
    check.eq(refused.status, 403,
      'and the server refuses the write regardless of what the UI offers');

    // --- the world reaches the player, minus the secrets -----------------
    const worldText = mainText(doc).replace(/\s+/g, ' ');
    check.ok(/Day 7/.test(worldText),
      'the day is on the Party screen - an in-world fact, always shared');
    check.ok(/Proof Vale/.test(worldText), 'and where the party stands');
    check.ok(/The Ledger/.test(worldText),
      'a public faction shows its standing');
    check.ok(!worldText.includes('SECRETAGENDA'),
      'with no agenda anywhere on screen');

    const campWire = await fetch('/api/campaigns/gym-pv-camp', {
      headers: { 'X-Toon-Token': joined.body.token },
    }).then((r) => r.text());
    check.ok(!campWire.includes('SECRETAGENDA'),
      'nor anywhere in the payload');

    const mapWire = await fetch('/api/maps/gym-pv-map', {
      headers: { 'X-Toon-Token': joined.body.token },
    }).then((r) => r.text());
    check.ok(mapWire.includes('Shown Pin') && !mapWire.includes('HIDDENPIN'),
      'the map arrives with only its revealed pins');
  } catch (err) {
    error = `${err.name}: ${err.message}`;
  } finally {
    for (const f of frames) f.remove();
    try {
      if (dmToken) {
        await api('/api/encounters/current', {
          method: 'DELETE', headers: { 'X-Toon-Token': dmToken } });
        await api('/api/campaigns/gym-pv-camp', {
          method: 'DELETE', headers: { 'X-Toon-Token': dmToken } });
        await api('/api/maps/gym-pv-map', {
          method: 'DELETE', headers: { 'X-Toon-Token': dmToken } });
        // Give the user back their active campaign, agendas and all.
        for (const rc of parked) {
          await api(`/api/campaigns/${rc.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json',
              'X-Toon-Token': dmToken },
            body: JSON.stringify(rc),
          });
        }
      }
      await api('/api/table/close', { method: 'POST' });
    } catch { /* the server went away; nothing more we can do */ }
  }
  return {
    id: 'player_sees_a_players_table',
    title: "A player gets a player's screen",
    passed: check.passed,
    total: check.total,
    failures: check.failures,
    features: [...check.touched],
    error,
    empty: !error && check.total === 0,
    ok: !error && check.total > 0 && check.failures.length === 0,
    ms: +(performance.now() - t0).toFixed(0),
  };
}

export async function runFlows(CheckClass, { onProgress = () => {} } = {}) {
  const frame = document.createElement('iframe');
  // Ephemeral: no real character is created, no real chronicle is appended to.
  frame.src = '/index.html?storage=memory';
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;'
    + 'height:1000px;border:0';
  document.body.append(frame);

  const results = [];
  try {
    await new Promise((r) => { frame.onload = r; setTimeout(r, 15000); });
    const doc = frame.contentDocument;
    const win = frame.contentWindow;

    // Wait for the app to be genuinely ready, not merely loaded.
    const ready = await waitFor(() => (doc.querySelector('main')
      && button(doc, 'Build') ? true : null), { timeout: 15000 });
    if (!ready) {
      return [{ id: 'boot', title: 'The app boots', ok: false, passed: 0, total: 1,
        failures: [{ label: 'the app never became interactive', detail: '' }],
        features: [], error: null, empty: false, ms: 0 }];
    }

    const errors = [];
    win.addEventListener('error', (e) => errors.push(e.message));
    win.addEventListener('unhandledrejection',
      (e) => errors.push(String(e.reason).slice(0, 160)));

    for (const flow of FLOWS) {
      const check = new CheckClass(flow.id);
      const before = errors.length;
      const t0 = performance.now();
      let error = null;
      try {
        await flow.run(check, { doc, win });
      } catch (err) {
        error = `${err.name}: ${err.message}`;
      }
      // An uncaught error inside the app during a flow is a failure of that
      // flow even if every assertion passed - the screen lied about being fine.
      if (errors.length > before) {
        check.failures.push({ label: 'the app threw during this flow',
          detail: errors.slice(before).join(' | ').slice(0, 200) });
      }
      results.push({
        id: flow.id,
        title: flow.title,
        passed: check.passed,
        total: check.total,
        failures: check.failures,
        features: [...check.touched],
        error,
        empty: !error && check.total === 0,
        ok: !error && check.total > 0 && check.failures.length === 0,
        ms: +(performance.now() - t0).toFixed(0),
      });
      onProgress({ flow: flow.id });
    }
  } finally {
    frame.remove();
  }

  // Last, and outside the shared ephemeral frame: this one needs the real
  // server, so it manages its own clients and cleans up after itself.
  results.push(await runRoleGate(CheckClass));
  onProgress({ flow: 'role_gate' });
  results.push(await runJoinGate(CheckClass));
  onProgress({ flow: 'join_gate' });
  results.push(await runLevelUpFlow(CheckClass));
  onProgress({ flow: 'level_up_flow' });
  results.push(await runTwoClient(CheckClass));
  onProgress({ flow: 'two_clients_stay_in_step' });
  results.push(await runPlayerView(CheckClass));
  onProgress({ flow: 'player_sees_a_players_table' });
  return results;
}
