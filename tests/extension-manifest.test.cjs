'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('extension manifest runs in the MAIN world without inline script', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 2);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.deepEqual(manifest.content_scripts[0].js, ['loader.js', 'bridgezone-main.js']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[1].world, 'ISOLATED');
  assert.deepEqual(manifest.content_scripts[1].js, ['dev-revision.js', 'dev-reload.js']);
  assert.equal(manifest.background.service_worker, 'dev-background.js');
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:43187/*']);
});

test('extension loader contains no page-level inline script', () => {
  const loader = fs.readFileSync(path.join(root, 'extension', 'loader.js'), 'utf8');
  assert.equal(loader.includes('createElement("script")'), false);
  assert.equal(loader.includes('textContent'), false);
});

test('generated main-world script matches the userscript', () => {
  const userscript = fs.readFileSync(path.join(root, 'bridgezone-tools.user.js'), 'utf8');
  const generated = fs.readFileSync(path.join(root, 'extension', 'bridgezone-main.js'), 'utf8');
  assert.equal(userscript, generated);
});

test('extension popup reload control calls the extension runtime', async () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
  const html = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  assert.match(html, /id="reload"/);
  assert.match(html, /src="popup.js"/);
  const script = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  let onClick;
  let reloaded = 0;
  const version = { textContent: '' };
  const connection = { textContent: '' };
  const context = {
    document: { getElementById: id => id === 'version' ? version : id === 'connection' ? connection :
      { addEventListener: (_, handler) => { onClick = handler; } } },
    chrome: { runtime: { getManifest: () => ({ version: manifest.version }), reload: () => { reloaded++; },
      sendMessage: async () => ({ project: 'XOX', revision: 'a'.repeat(64), error: null }) } }
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(version.textContent, manifest.version);
  assert.equal(connection.textContent, 'Auto updates connected');
  assert.equal(reloaded, 0);
  onClick();
  assert.equal(reloaded, 1);
});

test('dev watcher requests a reload only when the built revision changes', async () => {
  const revisionScript = fs.readFileSync(path.join(root, 'extension', 'dev-revision.js'), 'utf8');
  const loadedRevision = revisionScript.match(/'([a-f0-9]{64})'/)?.[1];
  assert.ok(loadedRevision);
  const script = fs.readFileSync(path.join(root, 'extension', 'dev-reload.js'), 'utf8');
  const messages = [], events = [], timers = [];
  let currentRevision = loadedRevision;
  const context = { globalThis: { __xoxBuildRevision: loadedRevision },
    window: { dispatchEvent: event => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: callback => { timers.push(callback); },
    chrome: { runtime: { sendMessage: async message => {
      messages.push(message);
      return message.type === 'xox:dev-status'
        ? { project: 'XOX', revision: currentRevision, error: null } : { reloading: true };
    } } }
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 0);
  assert.equal(timers.length, 1);
  currentRevision = 'b'.repeat(64);
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['xox:dev-reload-page']);
  assert.equal(messages.at(-1).type, 'xox:dev-reload');
  assert.equal(timers.length, 0);
});

test('background reads loopback status and reloads this extension once', async () => {
  const script = fs.readFileSync(path.join(root, 'extension', 'dev-background.js'), 'utf8');
  let listener, reloads = 0;
  const timers = [];
  const context = {
    chrome: { runtime: { id: 'xox-test', reload: () => { reloads++; },
      onMessage: { addListener: handler => { listener = handler; } } } },
    fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:43187/status');
      return { ok: true, json: async () => ({ project: 'XOX', revision: 'b'.repeat(64), error: null }) };
    },
    setTimeout: callback => { timers.push(callback); }
  };
  vm.runInNewContext(script, context);
  let status;
  assert.equal(listener({ type: 'xox:dev-status' }, { id: 'xox-test' }, response => { status = response; }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.revision, 'b'.repeat(64));
  assert.equal(listener({ type: 'xox:dev-reload', revision: 'b'.repeat(64) },
    { id: 'other-extension' }, () => {}), false);
  assert.equal(timers.length, 0);
  listener({ type: 'xox:dev-reload', revision: 'b'.repeat(64) },
    { id: 'xox-test' }, () => {});
  listener({ type: 'xox:dev-reload', revision: 'b'.repeat(64) },
    { id: 'xox-test' }, () => {});
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(reloads, 1);
});

test('page-world loader schedules a Zone refresh after extension reload starts', () => {
  const script = fs.readFileSync(path.join(root, 'extension', 'loader.js'), 'utf8');
  let reloadHandler, refresh;
  const context = { window: { addEventListener: (_, handler) => { reloadHandler = handler; },
    location: { reload: () => { refresh = true; } } },
    setTimeout: callback => { callback(); }
  };
  vm.runInNewContext(script, context);
  assert.equal(context.window.__bridgeZoneToolsExtensionLoaded, true);
  reloadHandler();
  assert.equal(refresh, true);
});
