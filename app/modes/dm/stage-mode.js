/**
 * Stage as a top-level mode - the live now.
 *
 * Owns the reload-mid-fight recovery (pull/adopt): the runner's state is
 * module-scratch, and a DM who reloads during round three deserves round
 * three back. Redraws on table/character changes; the fight itself is this
 * browser's local truth published outward, so no encounters subscription -
 * re-adopting remote state would fight the DM's own in-flight edits.
 *
 * Also carries the active campaign down to the strip: Stage is the landing
 * screen, and "there is no campaign yet" is the one piece of Deck state a
 * DM must not have to go looking for.
 */

import { el } from '../../core/store.js';
import * as live from '../../core/live.js';
import { activeCampaign } from '../../core/campaign.js';
import { pull, adopt } from './runner.js';
import * as stage from './stage.js';
import { dmData, makeCtx } from './shared.js';

export const title = 'Stage';

let container = null;
let unsubscribe = null;
let campaign = null;

export async function render(root) {
  container = root;
  await dmData();
  const shared = await pull();
  if (shared) adopt(shared);
  campaign = await activeCampaign();
  draw();

  if (unsubscribe) unsubscribe();
  unsubscribe = live.subscribe(['table', 'characters', 'campaigns', 'events'],
    async () => {
    // The container IS #view, which is always connected - the real question
    // is whether Stage is still the mode on it. Painting into a view another
    // mode owns is how a player's sheet grew grant buttons once.
    if (container.dataset.rendered !== 'dm-stage') {
      unsubscribe?.(); unsubscribe = null; return;
    }
    campaign = await activeCampaign();
    draw();
  });
}

function draw() {
  container.innerHTML = '';
  const box = el('div', {});
  container.append(box);
  stage.render(box, makeCtx({ redraw: draw }), campaign);
}
