/**
 * Theme: parchment by day, candlelight by night.
 *
 * Three states, stored under one key:
 *   null      follow the operating system (the default - no key stored)
 *   'light'   parchment, always
 *   'dark'    candlelight, always
 *
 * The choice is applied as data-theme on <html>. design.css keys off it, and
 * an explicit choice beats the OS preference in both directions - the media
 * query in the stylesheet is scoped to :root:not([data-theme]) precisely so
 * that choosing Parchment on a dark-mode machine actually gets parchment.
 *
 * index.html carries a tiny inline copy of apply() that runs before the
 * stylesheet loads, so a candlelight user never sees a parchment flash.
 */

const KEY = 'toonanvil.theme';

export function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

/**
 * What theme actually shows for a given choice and OS state.
 * Pure on purpose: the gym tests this without a DOM.
 */
export function resolve(choice, systemPrefersDark) {
  if (choice === 'light' || choice === 'dark') return choice;
  return systemPrefersDark ? 'dark' : 'light';
}

/** The theme currently showing. */
export function applied() {
  const sys = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return resolve(stored(), sys);
}

function apply(choice) {
  const root = document.documentElement;
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
}

/** Choose a theme. 'system' (or null) clears the choice and follows the OS. */
export function setTheme(choice) {
  const value = choice === 'light' || choice === 'dark' ? choice : null;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch { /* private mode: applies for this tab, forgets on close */ }
  apply(value);
  return applied();
}

/** Apply the stored choice and keep following the OS while unset. */
export function init() {
  apply(stored());
  try {
    window.matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => {
        // Only relevant while following the system; an explicit choice pins
        // the attribute and the stylesheet ignores the media query anyway.
        if (!stored()) apply(null);
      });
  } catch { /* older engines: the initial apply stands */ }
}
