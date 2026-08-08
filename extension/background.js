/**
 * Extension service worker.
 *
 * Clicking the toolbar icon opens Toon Anvil in Chrome's side panel, so the sheet
 * sits beside Roll20 / Foundry / a map rather than in a competing tab.
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[toon-anvil] side panel behaviour', err));
});
