'use strict';

document.getElementById('version').textContent = chrome.runtime.getManifest().version;
document.getElementById('reload').addEventListener('click', () => chrome.runtime.reload());
