'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('extension manifest runs in the MAIN world without inline script', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.deepEqual(manifest.content_scripts[0].js, ['loader.js', 'bridgezone-main.js']);
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.content_scripts[0].all_frames, false);
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
