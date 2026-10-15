'use strict';

(() => {
  const loadedRevision = globalThis.__xoxBuildRevision;
  if (!/^[a-f0-9]{64}$/.test(loadedRevision || '')) return;
  let stopped = false;

  async function poll() {
    let nextDelay = 10000;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'xox:dev-status' });
      if (status?.project === 'XOX' && !status.error) {
        nextDelay = 1500;
        if (status.revision !== loadedRevision && /^[a-f0-9]{64}$/.test(status.revision || '')) {
          const reply = await chrome.runtime.sendMessage({ type: 'xox:dev-reload', revision: status.revision });
          if (reply?.reloading) {
            window.dispatchEvent(new Event('xox:dev-reload-page'));
            stopped = true;
          }
        }
      }
    } catch { /* The local dev server or extension may be reloading. */ }
    if (!stopped) setTimeout(poll, nextDelay);
  }

  poll();
})();
