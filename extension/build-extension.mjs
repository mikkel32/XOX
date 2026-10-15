#!/usr/bin/env node
import { readFile, writeFile, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(directory, '..', 'bridgezone-tools.user.js');
const outputPath = join(directory, 'bridgezone-main.js');
const manifestPath = join(directory, 'manifest.json');
const mode = process.argv[2] || 'build';

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
  let generated;
  try { generated = await readFile(outputPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (generated === source) {
    console.log('Extension build is up to date.');
    return;
  }
  if (checkOnly) throw new Error('Extension build is stale. Run node extension/build-extension.mjs.');
  await writeFile(outputPath, source, 'utf8');
  if (await readFile(outputPath, 'utf8') !== source) throw new Error('Generated file differs from source.');
  console.log('Built extension/bridgezone-main.js from bridgezone-tools.user.js.');
}

if (mode !== '--watch') {
  try { await build(mode === '--check'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  await build();
  console.log('Watching bridgezone-tools.user.js. Use the extension popup to reload after a build.');
  let timer;
  const watcher = watch(join(directory, '..'));
  for await (const event of watcher) {
    if (event.filename !== 'bridgezone-tools.user.js') continue;
    clearTimeout(timer);
    timer = setTimeout(() => { build().catch(error => console.error(error.message)); }, 100);
  }
}
