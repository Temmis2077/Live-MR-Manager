#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Migration budget: counts may only go down. New files start at zero.
const legacyCeilings = {
  'src/js/alignment-queue.js': 17, 'src/js/alignment-viewer.js': 27,
  'src/js/audio.js': 14, 'src/js/dereverb.js': 3, 'src/js/events/backend.js': 10,
  'src/js/events/controls/custom-models.js': 2, 'src/js/events/controls/library.js': 0,
  'src/js/events/controls/playback.js': 2, 'src/js/events/controls/settings.js': 3,
  'src/js/events/meloming.js': 8, 'src/js/events/modals.js': 4,
  'src/js/gpu-pack.js': 3, 'src/js/live-screen.js': 6, 'src/js/lyric-drawer.js': 4,
  'src/js/lyrics.js': 4, 'src/js/model-api.js': 12, 'src/js/overlay/shared.js': 2,
  'src/js/overlay-api.js': 3, 'src/js/player.js': 5, 'src/js/separation-mode-modal.js': 4,
  'src/js/settings-api.js': 12, 'src/js/state.js': 0, 'src/js/tauri-bridge.js': 13,
  'src/js/track-mixer.js': 0, 'src/js/ui/add-song-modal.js': 9,
  'src/js/ui/app-bar.js': 1, 'src/js/ui/components.js': 31, 'src/js/ui/core.js': 1,
  'src/js/ui/library-panels.js': 3, 'src/js/ui/library.js': 2,
  'src/js/ui/onboarding-ui.js': 1, 'src/js/update-check.js': 1, 'src/js/utils.js': 3,
  'src/lyrics-view.html': 2, 'src/main.js': 6,
};

async function walk(dir, extensions = ['.js', '.ts', '.html']) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path, extensions));
    else if (extensions.includes(extname(path))) output.push(path);
  }
  return output;
}

function legacyCount(text) {
  return (text.match(/\binvoke\s*\(/g) ?? []).length
    + (text.match(/\blisten\s*\(/g) ?? []).length
    + (text.match(/window\.__TAURI__/g) ?? []).length;
}

const violations = [];
for (const path of await walk(join(root, 'src'))) {
  const rel = relative(root, path).replaceAll('\\', '/');
  if (rel.startsWith('src/generated/') || rel.startsWith('src/ipc/')) continue;
  const text = await readFile(path, 'utf8');
  const count = legacyCount(text);
  const ceiling = legacyCeilings[rel] ?? 0;
  if (count > ceiling) violations.push(`${rel}: direct IPC count ${count} exceeds migration ceiling ${ceiling}`);
  if (/from\s+['"][^'"]*generated\/ipc/.test(text)) {
    violations.push(`${rel}: UI may not import generated bindings directly`);
  }
  if (/from\s+['"]@tauri-apps\/api\/(core|event)/.test(text)) {
    violations.push(`${rel}: UI may not import Tauri IPC APIs directly`);
  }
}

const generated = await readFile(join(root, 'src/generated/ipc.ts'), 'utf8');
const handler = await readFile(join(root, 'src-tauri/src/ipc/mod.rs'), 'utf8');
for (const command of [...generated.matchAll(/__TAURI_INVOKE(?:<[^>]+>)?\("([^"]+)"/g)].map((match) => match[1])) {
  if (!handler.includes(`::${command}`)) violations.push(`generated command is not registered in Tauri handler: ${command}`);
}

const rustCommands = [];
for (const path of await walk(join(root, 'src-tauri/src'), ['.rs'])) {
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/#\[tauri::command[^\]]*\][\s\S]{0,180}?pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)) {
    rustCommands.push(match[1]);
  }
}
for (const command of rustCommands) {
  if (!handler.includes(`::${command}`)) violations.push(`Rust command is missing from the IPC registry: ${command}`);
}
for (const command of new Set(rustCommands)) {
  const count = rustCommands.filter((candidate) => candidate === command).length;
  if (count > 1) violations.push(`duplicate Rust command name: ${command} (${count})`);
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}

const remaining = Object.entries(legacyCeilings).reduce((sum, [, count]) => sum + count, 0);
console.log(`IPC boundary OK. Rust commands: ${rustCommands.length}; legacy ceiling: ${remaining}; new direct paths: blocked.`);
