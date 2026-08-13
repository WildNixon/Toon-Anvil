/**
 * FOUNDING - where a campaign is born, shared between the rooms that do it.
 *
 * Lifted from the Deck so the Lobby could stop sending people elsewhere:
 * hosting a session now leads with the campaign, and the two screens must
 * offer the SAME founding - same book rows, same blank start, same record
 * shape - or they drift into two subtly different campaigns.
 *
 * The module owns no fetch state and no campaign state. Callers pass the
 * shelf listing and the campaign list in and get told when something was
 * founded; that is what lets the Deck and the Lobby share this without
 * sharing their redraw machinery.
 *
 * The blank-start row - the 'Campaign name' input and 'Found the campaign'
 * button - renders SYNCHRONOUSLY and unconditionally: the gym's fallbacks
 * (and a DM with no books) depend on it existing even while the shelf is
 * still being fetched.
 */

import { el, toast } from '../../core/store.js';
import { saveCampaign, setActive, newCampaign } from '../../core/campaign.js';
import { log } from '../../core/events.js';

/** 'Plane-Shift_Kaladesh.pdf' -> 'Plane Shift Kaladesh'. */
export function cleanTitle(name) {
  return String(name || '').replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The Deck-material books: what a campaign can begin from. */
export function deckBooks(shelfListing) {
  const cats = shelfListing?.categories || {};
  return ['settings', 'adventures'].flatMap((c) => cats[c] || []);
}

/**
 * Create the record, make it active, log it, say so. Returns the campaign.
 *
 * The one non-UI truth of founding, so the Deck and the Lobby cannot end up
 * stamping different fields. What happens NEXT differs by room - the Deck
 * goes straight into filing the book's sections, the Lobby stays put and
 * lets the Deck's book nudge pick that up later - and that belongs to the
 * caller's onFound, not here.
 */
export async function foundCampaign({ name = '', book = null, existingCount = 0 } = {}) {
  const c = newCampaign(name || cleanTitle(book?.name || ''));
  if (book) {
    c.sourceSlug = book.slug;
    c.sourceName = book.name;
  }
  c.active = existingCount === 0;
  await saveCampaign(c);
  await setActive(c.id);
  await log('campaign_founded',
    book ? { name: c.name, source: book.name } : { name: c.name },
    { campaignId: c.id });
  toast(book ? `${c.name} begins - the book is open` : `${c.name} begins`, 'ok');
  return c;
}

/**
 * The founding block: book rows (hero) or a book picker (compact), and the
 * unconditional blank-start row.
 *
 *   hero          full rows per book vs a compact <select>
 *   books         shelf entries a campaign can begin from (caller filters
 *                 to extractedOk)
 *   shelfPending  true while the caller's shelf fetch is in flight
 *   all           the caller's campaign list (first campaign auto-activates)
 *   emptyHint     what to say when the shelf has no books - the right words
 *                 depend on where the drop zone is from where you stand
 *   highlightSlug outline this book's row and scroll it into view once
 *   onHighlight   called when the highlight was actually consumed
 *   onNeedShelf   called when the block drew while shelfPending - the
 *                 caller's cue to start its fetch
 *   onFound       async (campaign, { book }) - redraw, file sections,
 *                 whatever the room does after a founding
 */
export function campaignStartBlock({
  hero = false, books = [], shelfPending = false, all = [],
  emptyHint = 'No settings or adventures on the shelf yet. Drop a .pdf book '
    + 'in Setup and it files itself; then it appears here.',
  highlightSlug = null, onHighlight = null, onNeedShelf = null, onFound,
} = {}) {
  const box = el('div', {});
  const name = el('input', {
    type: 'text', placeholder: 'Campaign name...',
    'aria-label': 'Campaign name', style: 'max-width:240px',
  });

  const found = async (book) => {
    const c = await foundCampaign({
      name: name.value.trim(), book, existingCount: all.length,
    });
    await onFound?.(c, { book });
  };

  if (hero) {
    box.append(el('span', { class: 'eyebrow' }, 'From a book on your shelf'));
    if (shelfPending) {
      onNeedShelf?.();
      box.append(el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' },
        'Looking at the shelf...'));
    } else if (!books.length) {
      box.append(el('p', { class: 'muted', style: 'font-size:13px;margin:4px 0 8px' },
        emptyHint));
    } else {
      let toHighlight = null;
      for (const b of books) {
        const row = el('div', {
          style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
            + 'padding:7px 0;border-bottom:1px solid var(--etch)'
            + (b.slug === highlightSlug ? ';outline:2px solid var(--accent);'
              + 'outline-offset:3px' : ''),
        });
        row.append(el('strong', { style: 'flex:1;min-width:170px' },
          cleanTitle(b.name)));
        row.append(el('span', { class: 'mono muted', style: 'font-size:11px' },
          `${b.pages || '?'} pages · ${Object.values(b.written || {})
            .reduce((n, x) => n + x, 0)} sections`));
        row.append(el('button', {
          class: 'act small',
          title: 'Found a campaign named for this book (or type a name first) '
            + 'and open its sections for filing',
          onClick: () => found(b),
        }, 'Begin this campaign'));
        if (b.slug === highlightSlug) toHighlight = row;
        box.append(row);
      }
      if (toHighlight) {
        setTimeout(() => toHighlight.scrollIntoView({ block: 'center' }), 60);
        onHighlight?.();
      }
    }
    box.append(el('span', {
      class: 'eyebrow', style: 'display:block;margin-top:12px',
    }, 'Or start blank'));
  }

  const row = el('div', { class: 'btnrow', style: 'margin-top:8px' });
  row.append(name);
  row.append(el('button', {
    class: 'act',
    onClick: async () => {
      if (!name.value.trim()) return toast('Name it first', 'warn');
      await found(null);
      return null;
    },
  }, 'Found the campaign'));
  box.append(row);

  // The compact path to a second book campaign, next to the blank row.
  if (!hero) {
    if (shelfPending) onNeedShelf?.();
    if (books.length) {
      const prow = el('div', { class: 'btnrow', style: 'margin-top:8px' });
      const sel = el('select', {
        'aria-label': 'Book to begin from', style: 'width:auto',
      });
      for (const b of books) sel.append(el('option', { value: b.slug }, b.name));
      prow.append(sel);
      prow.append(el('button', {
        class: 'act ghost',
        onClick: () => {
          const b = books.find((x) => x.slug === sel.value);
          if (b) found(b);
        },
      }, 'Begin from this book'));
      box.append(prow);
    }
  }
  return box;
}
