/**
 * Probe primitives - what a human could actually do to a screen.
 *
 * This module exists to make ONE number honest: how many taps it costs to
 * get an answer out of this app. A tap counter is trivially cheatable, and
 * every cheat makes the app look better without being better:
 *
 *   - jumping straight to a mode with location.hash is zero taps and no
 *     human can do it;
 *   - clicking an element that is off-screen, disabled, or underneath a
 *     modal backdrop is zero taps and no human can do it either;
 *   - and a screen that answers everything in one tap because it dumps
 *     four hundred numbers onto one page is one tap and unusable.
 *
 * So this file deliberately exports NO navigation function. Reaching a
 * screen has to be done by tapping something visible, the same way a person
 * would. Anything that wants a shortcut has to add it here, in public, where
 * it can be argued about.
 *
 * Nothing here imports the app. It is DOM arithmetic and nothing else, which
 * is also what lets it run against a frame whose modules it cannot see.
 */

/** Minimum comfortable touch target. Shared with uiflows.js's phone flow. */
export const TAP_MIN_PX = 44;
/** Below this, text on a phone is a picture of text. */
export const TEXT_MIN_PX = 13;
/** iOS zooms the page when a focused input is under 16px. */
export const INPUT_MIN_PX = 16;

/** Thrown rather than counted, so a broken path can never read as a cheap one. */
export class NotTappable extends Error {
  constructor(why, el) {
    super(`not tappable: ${why}`);
    this.name = 'NotTappable';
    this.why = why;
    this.el = el;
  }
}

const ownerWin = (el) => el?.ownerDocument?.defaultView || null;

/**
 * Is this element inside the frame's own viewport right now?
 *
 * Deliberately NOT IntersectionObserver: these frames are parked at
 * left:-10000px, so intersection against the PARENT viewport is empty for
 * everything and would report the whole app invisible. getBoundingClientRect
 * is frame-local, which is the coordinate space that matters here.
 */
export function inViewport(el, win = ownerWin(el)) {
  if (!el || !win) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return r.top >= 0 && r.left >= 0
    && r.bottom <= win.innerHeight && r.right <= win.innerWidth;
}

/**
 * Is any of this element on screen?
 *
 * Containment is the right question for a TAP TARGET - a button half off the
 * bottom is a button you have to scroll to. It is the wrong question for
 * CONTENT: a panel taller than a 390x844 phone is never wholly inside the
 * viewport, so asking "is .cockpit-main contained" answers no for a screen
 * that is plainly showing the fight. Measured: it marked every DM answer
 * unreachable, including the control that is supposed to cost zero taps.
 */
export function intersectsViewport(el, win = ownerWin(el)) {
  if (!el || !win) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return r.bottom > 0 && r.right > 0
    && r.top < win.innerHeight && r.left < win.innerWidth;
}

/**
 * Could a person tap this, right now, without scrolling?
 *
 * Returns {ok, why} rather than a boolean because WHY a path failed is the
 * finding. "reachable in 3 taps" and "unreachable because the button is
 * under a backdrop" are different facts about the app.
 */
export function tappable(el, win = ownerWin(el)) {
  if (!el) return { ok: false, why: 'no element' };
  if (!win) return { ok: false, why: 'no window' };
  if (!el.isConnected) return { ok: false, why: 'detached from the document' };
  if (el.disabled) return { ok: false, why: 'disabled' };
  if (el.getAttribute?.('aria-disabled') === 'true') {
    return { ok: false, why: 'aria-disabled' };
  }
  if (el.closest?.('[inert]')) return { ok: false, why: 'inside an inert subtree' };

  const rects = el.getClientRects?.() || [];
  if (!rects.length) return { ok: false, why: 'no layout box' };
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return { ok: false, why: 'zero size' };

  // checkVisibility covers display:none, visibility:hidden, content-visibility
  // and (with the flag) an opacity:0 ancestor in one call. Older engines get
  // the manual walk, because a silently-skipped check is worse than a slow one.
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return { ok: false, why: 'not visible' };
    }
  } else {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none') return { ok: false, why: 'display:none' };
      if (cs.visibility === 'hidden') return { ok: false, why: 'visibility:hidden' };
      if (Number(cs.opacity) === 0) return { ok: false, why: 'opacity:0' };
    }
  }

  if (!inViewport(el, win)) {
    // Not a failure of the app - a failure of THIS attempt. The caller
    // records it as scrollsBefore and may scroll and retry; it must never
    // silently become a free tap.
    return { ok: false, why: 'outside the viewport', scrollable: true };
  }

  // The one that catches a backdrop. kit.js's actionSheet and sheetPrompt
  // both mount a .sheet-backdrop over the page; every control underneath is
  // still visible, still sized, still enabled - and completely untappable.
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const hit = el.ownerDocument.elementFromPoint(cx, cy);
  if (!hit) return { ok: false, why: 'nothing at its centre point' };
  if (hit !== el && !el.contains(hit)) {
    const blocker = hit.closest?.('[class]')?.className || hit.tagName;
    return { ok: false, why: `covered by ${String(blocker).slice(0, 40)}` };
  }
  return { ok: true, why: '' };
}

/**
 * Tap it, or refuse to count it.
 *
 * Throwing is the point. If this returned false the caller could carry on
 * and report a tap count for a journey that never happened.
 */
export function tap(el, win = ownerWin(el)) {
  const v = tappable(el, win);
  if (!v.ok) throw new NotTappable(v.why, el);
  el.click();
  return true;
}

/** Is this element big enough for a thumb? */
export function bigEnough(el) {
  const r = el?.getBoundingClientRect?.();
  return Boolean(r) && r.width >= TAP_MIN_PX && r.height >= TAP_MIN_PX;
}

/** Visible text of a document's main region, whitespace-collapsed. */
export function visibleText(doc) {
  const root = doc?.querySelector('main') || doc?.body;
  return (root?.textContent || '').replace(/\s+/g, ' ').trim();
}

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, '
  + '[role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';

/**
 * How much is being asked of the reader on this screen.
 *
 * The veto this feeds exists because of a degenerate winner: an app that
 * printed every number it knows onto one page would answer every question
 * in one tap and score perfectly, while being unusable. Density is what
 * stops that from being a win.
 *
 * `numbers` counts DISTINCT numeric tokens rather than digits, because "44"
 * appearing three times is one fact repeated, not three facts.
 */
export function screenful(doc, win = doc?.defaultView) {
  const out = { choices: 0, numbers: 0, minFontPx: null, tiny: [] };
  if (!doc || !win) return out;

  const controls = [...doc.querySelectorAll(INTERACTIVE)]
    .filter((el) => inViewport(el, win));
  out.choices = controls.length;

  const seen = new Set();
  for (const m of visibleText(doc).matchAll(/-?\d+(?:\.\d+)?/g)) seen.add(m[0]);
  out.numbers = seen.size;

  // The smallest type a reader is actually being asked to read. Elements
  // with no text of their own are skipped - an empty span's font size is
  // not a legibility fact about anything.
  let min = Infinity;
  for (const el of doc.querySelectorAll('main *')) {
    if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
    if (!el.textContent.trim()) continue;
    if (!inViewport(el, win)) continue;
    const px = parseFloat(win.getComputedStyle(el).fontSize);
    if (!Number.isFinite(px)) continue;
    const floor = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
      ? INPUT_MIN_PX : TEXT_MIN_PX;
    if (px < floor) out.tiny.push({ tag: el.tagName, px });
    if (px < min) min = px;
  }
  out.minFontPx = Number.isFinite(min) ? min : null;
  return out;
}

/**
 * Silence the dialogs, but never pretend they were free.
 *
 * runner.js:526 calls window.confirm. An unstubbed confirm inside a driven
 * frame blocks forever and takes the whole night with it. Stubbing is
 * frame-local - it patches this frame's globals, never the app's code - and
 * every call is RECORDED, because a journey that needed a modal is not the
 * same journey as one that did not.
 */
export function stubDialogs(win) {
  const calls = [];
  const record = (kind, answer) => (message) => {
    calls.push({ kind, message: String(message ?? '').slice(0, 120) });
    return answer;
  };
  win.confirm = record('confirm', true);
  win.alert = record('alert', undefined);
  win.prompt = record('prompt', '');
  return calls;
}

/**
 * A marker that a redraw destroys.
 *
 * Used to answer "did the screen survive a player's die roll" WITHOUT
 * waiting on a clock. live.js backs its poll off from 2s to 15s after 150
 * silent ticks, so a probe that waits three seconds and finds the panel
 * intact has learned nothing except that the redraw had not arrived yet.
 * Waiting for this node to disappear is evidence; waiting for a timeout is
 * a guess wearing evidence's clothes.
 */
export function sentinel(box, doc = box?.ownerDocument) {
  if (!box || !doc) return null;
  const mark = doc.createElement('span');
  mark.dataset.probeSentinel = '1';
  mark.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  box.append(mark);
  return {
    node: mark,
    /** Has the host redrawn? True once our marker is gone. */
    gone: () => !mark.isConnected,
    /** Resolves true on evidence of a redraw, false on timeout. Never guesses. */
    async waitGone(timeout = 20000, every = 60) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!mark.isConnected) return true;
        await new Promise((r) => setTimeout(r, every));
      }
      return false;
    },
  };
}

/** Every iframe left behind by a previous cycle. A leak, counted not ignored. */
export function sweepFrames(doc, keep = new Set()) {
  const stale = [...doc.querySelectorAll('iframe')].filter((f) => !keep.has(f));
  for (const f of stale) f.remove();
  return stale.length;
}
