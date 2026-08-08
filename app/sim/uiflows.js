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

/* ------------------------------------------------------------------ */
/* interaction helpers                                                 */
/* ------------------------------------------------------------------ */

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
    id: 'shop_generate_and_buy',
    title: 'Generate a shop and buy something',
    async run(c, { doc }) {
      c.feature('ui', 'shop', 'inventory');
      c.ok(await goToMode(doc, 'Shop', 'Generate stock'), 'Shop mode opens');
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
    id: 'dm_bestiary',
    title: 'The bestiary finds a monster',
    async run(c, { doc }) {
      c.feature('ui', 'dm', 'bestiary');
      c.ok(await goToMode(doc, 'DM', 'Bestiary'), 'DM mode opens');
      button(doc, 'Bestiary')?.click();
      await waitUntilSettled(doc);
      const search = await waitFor(() => doc.querySelector('main input[type=text]'));
      c.ok(!!search, 'the bestiary offers a search field');
      setField(search, 'goblin');
      const found = await waitFor(() => (/AC\s*\d+/.test(mainText(doc))
        ? mainText(doc) : null), { timeout: 6000 });
      c.ok(!!found, 'searching returns a statblock');
      if (found) {
        c.ok(/HP\s*\d+/.test(found), 'the statblock shows hit points');
        c.ok(/CR/i.test(found), 'the statblock shows a challenge rating');
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
      c.ok(keep && !keep.disabled, 'keeping is offered once there is something to keep');

      // The export has to be a real, importable bundle - a sandbox you can
      // only lose things in would be worse than no sandbox.
      let captured = null;
      const realCreate = win.URL.createObjectURL;
      win.URL.createObjectURL = (b) => {
        try { b.text().then((t) => { captured = t; }); } catch { /* ignore */ }
        return 'blob:gym';
      };
      try {
        keep.click();
        await waitFor(() => (captured ? true : null), { timeout: 8000 });
      } finally {
        win.URL.createObjectURL = realCreate;
      }
      c.ok(!!captured, 'keeping produces a downloadable bundle');
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
      c.ok(await goToMode(doc, 'Homebrew',
        () => /Open library|Hide library/.test(mainText(doc))),
      'Homebrew mode opens');
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
      c.ok(await goToMode(doc, 'Homebrew',
        () => /Open library|Hide library/.test(mainText(doc))),
      'Homebrew mode opens');
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
  return results;
}
