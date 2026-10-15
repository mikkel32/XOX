'use strict';

document.getElementById('version').textContent = chrome.runtime.getManifest().version;
document.getElementById('reload').addEventListener('click', () => chrome.runtime.reload());
chrome.runtime.sendMessage({ type: 'xox:dev-status' }).then(status => {
  document.getElementById('connection').textContent = status?.project === 'XOX' && !status.error
    ? 'Auto updates connected' : status?.error || 'Local builder is offline';
}).catch(() => {
  document.getElementById('connection').textContent = 'Local builder is offline';
});
