/**
 * World as a top-level mode - the prep bench.
 *
 * Deliberately NO live subscription: a half-typed monster search surviving a
 * player's die roll matters more than freshness here. The lens module keeps
 * its own scratch (searches, encounter picks, loot seeds) at module level,
 * so leaving and returning loses nothing.
 */

import { el } from '../../core/store.js';
import * as world from './world.js';
import { dmData, makeCtx } from './shared.js';

export const title = 'World';

export async function render(root) {
  await dmData();
  const box = el('div', {});
  root.append(box);
  const draw = () => world.render(box, makeCtx({ redraw: draw }));
  draw();
}
