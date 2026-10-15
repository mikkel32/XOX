'use strict';

const statusUrl = 'http://127.0.0.1:43187/status';
let reloading = false;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'xox:dev-status') {
    fetch(statusUrl, { cache: 'no-store' })
      .then(response => {
        if (!response.ok) throw new Error(`Dev server returned ${response.status}`);
        return response.json();
      })
      .then(status => respond(status?.project === 'XOX' ? status : { error: 'Unexpected dev server' }))
      .catch(() => respond({ offline: true }));
    return true;
  }
  if (message?.type === 'xox:dev-reload' && /^[a-f0-9]{64}$/.test(message.revision)) {
    respond({ reloading: true });
    if (!reloading) {
      reloading = true;
      setTimeout(() => chrome.runtime.reload(), 200);
    }
  }
  return false;
});
