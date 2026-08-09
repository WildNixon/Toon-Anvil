/**
 * Story as a top-level mode - the party's record, live.
 *
 * Redraws when events land or characters change (the name column reads the
 * roster). Read-only by design; the lens module says why.
 */

import * as live from '../../core/live.js';
import * as story from './story.js';

export const title = 'Story';

let container = null;
let unsubscribe = null;

export async function render(root) {
  container = root;
  await story.render(root);

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['events', 'characters'], async () => {
    // #view is always connected; the guard is whether Story still owns it.
    if (container.dataset.rendered !== 'dm-story') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    await story.render(container);
  });
}
