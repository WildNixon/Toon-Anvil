/**
 * What an API key would unlock, and roughly what it would cost - read before
 * you put a credential anywhere.
 *
 * This screen exists because of a gap that was hard to see from inside: the
 * connector transport has been finished, tested and security-reviewed for a
 * long time, and has almost nothing plugged into it. So a user was being
 * asked to put a credential in a file in exchange for an unnamed, unpriced
 * and mostly nonexistent set of benefits. The old panel said one sentence
 * about "a writing assistant, portraits and sound", and the word cost did not
 * appear anywhere on it.
 *
 * Three rules this panel keeps:
 *
 *   1. EVERY ROW SAYS WHETHER IT EXISTS. Most are `not built yet`. Hiding
 *      that would make this advertising; showing it makes it a menu.
 *   2. EVERY ROW SAYS WHAT ALREADY WORKS FREE. This app ships good seeded
 *      generators and a measured simulator. A capability that duplicates one
 *      of those is not worth anybody's money and should say so on its face.
 *   3. A PRICE SHOWS ITS WORKING, and never pretends to be current. The
 *      figures are list prices on a date that is printed beside them; what
 *      you actually spent is measured separately and shown underneath.
 *
 * Split out of settings.js because it is a screen, not a setting.
 */

import { el } from '../../core/store.js';

const KIND_LABEL = { llm: 'Writing', image: 'Pictures', sfx: 'Sound' };
const SEAT_LABEL = { dm: 'For the DM', player: 'For a player' };

/**
 * Money, at the size it actually is.
 *
 * A tenth of a penny printed as "$0.00" reads as free, and free is a claim
 * only a local provider gets to make. So the precision follows the number,
 * and "we cannot say" stays unsayable as a price - null renders as nothing
 * rather than as zero.
 */
export function money(cents) {
  if (cents === null || cents === undefined) return null;
  if (cents === 0) return 'free';
  const d = cents / 100;
  if (d < 0.01) return `$${d.toFixed(4)}`;
  if (d < 1) return `$${d.toFixed(3)}`;
  return `$${d.toFixed(2)}`;
}

/** "~120 in + 180 out tokens" - the arithmetic behind the price. */
export function working(cap) {
  const e = cap.est || {};
  if (cap.kind === 'llm' && (e.inTokens || e.outTokens)) {
    return `~${e.inTokens || 0} in + ${e.outTokens || 0} out tokens`;
  }
  if (cap.kind === 'image') return `${e.images || 1} image`;
  if (cap.kind === 'sfx' && e.seconds) return `${e.seconds}s of audio`;
  return null;
}

function capabilityRow(cap) {
  const row = el('div', {
    style: 'padding:10px 0;border-bottom:1px solid var(--etch)',
  });
  const top = el('div', {
    style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap',
  });
  const built = cap.status === 'built';
  top.append(el('span', {
    class: 'chip',
    title: built ? 'Wired up and usable now'
      : 'Not built yet - listed so you can choose what to build next',
  }, built ? 'built' : 'not built yet'));
  top.append(el('strong', { style: 'flex:1;min-width:170px' }, cap.title));
  if (cap.readyProviders?.length) {
    top.append(el('span', {
      class: 'chip ok', title: 'You already have a provider for this',
    }, 'ready'));
  }
  row.append(top);

  row.append(el('p', { class: 'muted', style: 'font-size:13px;margin:4px 0 0' },
    cap.what));

  if (cap.insteadOf) {
    row.append(el('p', {
      style: 'font-size:13px;margin:4px 0 0;color:var(--accent-2)',
    }, `Today: ${cap.insteadOf}`));
  }

  const bits = [];
  for (const pid of cap.providers || []) {
    const m = money(cap.estCents?.[pid]);
    if (m) bits.push(`${pid} ${m}`);
  }
  if (bits.length) {
    const w = working(cap);
    row.append(el('div', {
      class: 'mono', style: 'font-size:12px;margin-top:6px;color:var(--muted)',
    }, `${w ? `${w} - ` : ''}${bits.join(' · ')} each`));
  }

  if (cap.contentClass === 'user') {
    row.append(el('p', {
      style: 'font-size:12px;margin:4px 0 0;color:var(--accent-text)',
    }, 'Sends your own writing, so it runs on a local model only - the server '
     + 'refuses to send it anywhere else.'));
  }
  if (cap.blockedBy) {
    row.append(el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0' },
      `Blocked: ${cap.blockedBy}`));
  }
  return row;
}

/** The catalogue half: what a key buys, before anybody commits one. */
export function catalogueSection(caps) {
  const out = [];
  const cat = caps.capabilities || [];
  if (!cat.length) return out;

  out.push(el('div', { class: 'rule' }));
  out.push(el('h3', { style: 'margin-top:14px' }, 'What a key unlocks'));
  out.push(el('p', { class: 'muted', style: 'font-size:13px;margin:2px 0 8px' },
    'Read this before you put a credential anywhere. Every line says what it '
    + 'adds, what already works without it, and roughly what one use costs.'));

  // `internal` rows are real capabilities that really spend - they are in the
  // catalogue so the ledger can name them and so this file stays the single
  // list of everything that can cost money. They are not on the menu because
  // nobody buys a key in order to test a key.
  for (const seat of ['dm', 'player']) {
    const mine = cat.filter((c) => c.forSeat === seat && !c.internal);
    if (!mine.length) continue;
    out.push(el('div', { class: 'eyebrow', style: 'margin-top:12px' },
      SEAT_LABEL[seat] || seat));
    for (const cap of mine) out.push(capabilityRow(cap));
  }

  if (caps.pricesAsOf) {
    out.push(el('p', { class: 'muted', style: 'font-size:12px;margin-top:10px' },
      `Prices are list prices as of ${caps.pricesAsOf}, and this file does not `
      + 'move when they do. Treat every figure as roughly, and check your '
      + 'provider. What you actually spend is measured separately, below.'));
  }

  const no = caps.notOffered;
  if (no) {
    const box = el('details', { style: 'margin-top:10px' });
    box.append(el('summary', { style: 'cursor:pointer;font-size:13px' },
      'What is deliberately not offered'));
    // Every key except the intro, rather than a hardcoded list: a refusal
    // added to the data and rendered nowhere is a refusal nobody made.
    if (no.why) {
      box.append(el('p', { class: 'muted', style: 'font-size:13px' }, no.why));
    }
    for (const [k, text] of Object.entries(no)) {
      if (k === 'why' || typeof text !== 'string') continue;
      box.append(el('p', { class: 'muted', style: 'font-size:13px' }, text));
    }
    out.push(box);
  }
  return out;
}

/** One provider row: status, what it unlocks, and how to set it up. */
export function providerSection(caps, { testing, onTest }) {
  const out = [el('div', { class: 'rule' }),
    el('h3', { style: 'margin-top:14px' }, 'Providers')];

  const byKind = {};
  for (const [id, p] of Object.entries(caps.providers || {})) {
    (byKind[p.kind] ||= []).push([id, p]);
  }

  for (const [kind, list] of Object.entries(byKind)) {
    out.push(el('div', { class: 'eyebrow', style: 'margin-top:12px' },
      KIND_LABEL[kind] || kind));
    for (const [id, p] of list) {
      const row = el('div', {
        style: 'padding:8px 0;border-bottom:1px solid var(--etch)',
      });
      const top = el('div', {
        style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap',
      });
      top.append(el('span', {
        class: 'chip',
        style: p.configured ? 'background:rgba(47,107,98,.3)'
          : 'background:rgba(58,66,71,.2)',
      }, p.configured ? 'ready' : 'not set up'));
      top.append(el('strong', { style: 'flex:1;min-width:150px' }, p.label));
      if (p.free) top.append(el('span', { class: 'chip ok' }, 'no cost'));
      if (p.configured && kind === 'llm') {
        top.append(el('button', {
          class: 'act small', onClick: () => onTest(id, p),
        }, testing === id ? 'Asking...' : 'Test'));
      }
      row.append(top);
      row.append(el('p', {
        class: 'muted', style: 'font-size:13px;margin:4px 0 0',
      }, p.note));
      // Counted from the catalogue rather than asserted in prose, so adding
      // a capability updates the sales pitch on its own.
      if (p.unlocks?.length) {
        row.append(el('p', { class: 'muted', style: 'font-size:12px;margin:3px 0 0' },
          `Unlocks ${p.unlocks.length} `
          + `${p.unlocks.length === 1 ? 'capability' : 'capabilities'}`
          + `${p.unlocksBuilt?.length
            ? `, ${p.unlocksBuilt.length} built today` : ' - none built yet'}.`));
      }
      out.push(row);
    }
  }
  return out;
}

/**
 * What it has really cost - the counterweight to the estimates above.
 *
 * Kept apart from the catalogue on purpose. That quotes a guess before you
 * spend; this reports what the providers said afterwards, and letting the
 * two share a number is how a price table stays wrong for a year.
 */
export function spendSection(spendInfo) {
  if (!spendInfo || !spendInfo.calls) return [];
  const out = [el('div', { class: 'rule' }),
    el('h3', { style: 'margin-top:14px' }, 'What you have spent')];
  const total = money(spendInfo.cents) || 'free';
  out.push(el('p', { style: 'font-size:14px;margin:2px 0' },
    spendInfo.budgetCents
      ? `${total} of your ${money(spendInfo.budgetCents)} cap, over `
        + `${spendInfo.calls} calls.`
      : `${total} over ${spendInfo.calls} calls. No cap set.`));
  if (spendInfo.estimatedShare > 0) {
    out.push(el('p', { class: 'muted', style: 'font-size:12px;margin:0' },
      `${Math.round(spendInfo.estimatedShare * 100)}% of that is estimated `
      + 'rather than measured - some providers report what a call used and '
      + 'some do not.'));
  }
  if (spendInfo.overBudget) {
    out.push(el('p', { style: 'font-size:13px;color:var(--accent-text)' },
      'You are at your cap, so connector calls are being refused. Raise '
      + 'TOON_ANVIL_BUDGET_CENTS to carry on.'));
  }
  return out;
}
