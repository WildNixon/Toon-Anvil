/**
 * Project identity, in one place.
 *
 * The name appears in the page title, the app chrome, the PWA manifest, the
 * browser extension and the footer of every document the app emits. Having it
 * in one module means renaming is a one-line change rather than a hunt through
 * nine files.
 */

export const BRAND = {
  name: 'Toon Anvil',
  // Rendered as two-tone in the header: <strong>Toon</strong><em>Anvil</em>
  nameParts: ['Toon', 'Anvil'],
  tagline: 'Drop in homebrew. Get back a balanced subclass, a sheet, and a plan.',
  short: 'Toon Anvil',
  version: '1.0.0',   // see README 'Status: v1.0'
  repo: 'https://github.com/WildNixon/Toon-Anvil',
};

/** Suffix for emitted documents, e.g. "Path of the Dragon — Toon Anvil". */
export const docTitle = (subject) => `${subject} — ${BRAND.name}`;

export default BRAND;
