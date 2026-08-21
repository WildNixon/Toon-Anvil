/**
 * The app's version, mirrored from /VERSION at the repo root.
 *
 * The root file is the truth; this module exists so the browser can state
 * the number without a round-trip. The service worker's cache name in sw.js
 * mirrors it too, which is what makes a version bump bust the offline cache.
 * `python run.py --check` and the gym's `release` suite refuse to run with
 * these out of step - a mirror that drifts is how an update ships under last
 * month's number.
 */
export const VERSION = '2.0.0';
