#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(directory, '..', 'bridgezone-tools.user.js');
const outputPath = join(directory, 'bridgezone-main.js');
const revisionPath = join(directory, 'dev-revision.js');
const manifestPath = join(directory, 'manifest.json');
const mode = process.argv[2] || 'build';
const devPort = 43187;
const runtimeFiles = ['manifest.json', 'loader.js', 'popup.html', 'popup.css', 'popup.js',
  'dev-background.js', 'dev-reload.js'];

if (!['build', '--check', '--watch'].includes(mode) || process.argv.length > 3) {
  console.error('Usage: node extension/build-extension.mjs [--check|--watch]');
  process.exit(2);
}

async function build(checkOnly = false) {
  const [source, manifestText] = await Promise.all([
    readFile(sourcePath, 'utf8'), readFile(manifestPath, 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  const metadataVersion = source.match(/^\/\/ @version\s+(\S+)\s*$/m)?.[1];
  const runtimeVersion = source.match(/^\s*const VERSION = '([^']+)';/m)?.[1];
  if (!metadataVersion || metadataVersion !== runtimeVersion || metadataVersion !== manifest.version) {
    throw new Error(`Version mismatch: userscript=${metadataVersion || 'missing'}, runtime=${runtimeVersion || 'missing'}, manifest=${manifest.version}`);
  }
  const canonical = value => value.replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(canonical(source));
  for (const filename of runtimeFiles) {
    hash.update(filename).update(canonical(await readFile(join(directory, filename), 'utf8')));
  }
  const revision = hash.digest('hex');
  const revisionScript = `'use strict';\nglobalThis.__xoxBuildRevision = '${revision}';\n`;
  const readExisting = async path => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const [generated, oldRevision] = await Promise.all([readExisting(outputPath), readExisting(revisionPath)]);
  if (generated === source && oldRevision && canonical(oldRevision) === revisionScript) {
    console.log('Extension build is up to date.');
    return revision;
  }
  if (checkOnly) throw new Error('Extension build is stale. Run node extension/build-extension.mjs.');
  if (generated !== source) await writeFile(outputPath, source, 'utf8');
  await writeFile(revisionPath, revisionScript, 'utf8');
  if (await readFile(outputPath, 'utf8') !== source || await readFile(revisionPath, 'utf8') !== revisionScript) {
    throw new Error('Generated extension files differ from their inputs.');
  }
  console.log('Built extension/bridgezone-main.js and dev-revision.js.');
  return revision;
}

if (mode !== '--watch') {
  try { await build(mode === '--check'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  let status = { project: 'XOX', revision: await build(), error: null };
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/status') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store' });
    response.end(JSON.stringify(status));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(devPort, '127.0.0.1', resolve);
  });
  console.log(`Auto build and reload active at http://127.0.0.1:${devPort}/status`);
  let timer;
  let busy = false, queued = false;
  async function rebuild() {
    if (busy) { queued = true; return; }
    busy = true;
    do {
      queued = false;
      try { status = { project: 'XOX', revision: await build(), error: null }; }
      catch (error) {
        status = { ...status, error: error.message };
        console.error('Build failed:', error.message);
      }
    } while (queued);
    busy = false;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  }
  const watchDirectory = async (path, relevant) => {
    for await (const event of watch(path)) if (relevant.has(event.filename)) schedule();
  };
  await Promise.all([
    watchDirectory(join(directory, '..'), new Set(['bridgezone-tools.user.js'])),
    watchDirectory(directory, new Set([...runtimeFiles, 'bridgezone-main.js', 'dev-revision.js']))
  ]);
}
