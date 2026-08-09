/**
 * Setup as a top-level mode - the table, the forge, the workshop.
 *
 * Redraws on table changes (players joining, the forge flipping); the
 * homebrew workshop inside owns its own state and survives the redraws.
 */

import { el } from '../../core/store.js';
import * as live from '../../core/live.js';
import * as setup from './setup.js';
import { dmData, makeCtx } from './shared.js';

export const title = 'Setup';

let container = null;
let unsubscribe = null;

export async function render(root) {
  container = root;
  await dmData();
  await draw();

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['table'], async () => {
    // #view is always connected; the guard is whether Setup still owns it.
    if (container.dataset.rendered !== 'dm-setup') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    await draw();
  });
}

async function draw() {
  container.innerHTML = '';
  const box = el('div', {});
  container.append(box);
  await setup.render(box, makeCtx({ redraw: draw }));
}
