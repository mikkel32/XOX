(() => {
  'use strict';

  if (window.__bridgeZoneToolsExtensionLoaded) return;
  window.__bridgeZoneToolsExtensionLoaded = true;
  // bridgezone-main.js follows in the same MAIN-world content-script list.
  window.addEventListener('xox:dev-reload-page', () => {
    // This page-world timer survives the extension's own runtime reload.
    setTimeout(() => window.location.reload(), 1800);
  }, { once: true });
})();
