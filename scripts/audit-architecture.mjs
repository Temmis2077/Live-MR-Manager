#!/usr/bin/env node
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoots = ['src', 'src-tauri/src'];
const sourceExts = new Set(['.js', '.ts', '.html', '.rs']);

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (sourceExts.has(extname(entry.name))) result.push(path);
  }
  return result;
}

function matches(text, regex, group = 1) {
  return [...text.matchAll(regex)].map((match) => match[group]);
}

const files = (await Promise.all(sourceRoots.map((dir) => walk(join(root, dir))))).flat();
const inventory = { generatedAt: new Date().toISOString(), totals: {}, files: [], commands: [], invokes: [], emits: [], listens: [] };

for (const file of files) {
  const text = await readFile(file, 'utf8');
  const rel = relative(root, file).replaceAll('\\', '/');
  const lines = text.split(/\r?\n/).length;
  const bytes = (await stat(file)).size;
  inventory.files.push({ path: rel, lines, bytes });

  if (file.endsWith('.rs')) {
    inventory.commands.push(...matches(text, /#\[tauri::command\][\s\S]{0,240}?pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g).map((name) => ({ name, path: rel })));
    inventory.emits.push(...matches(text, /\.emit\(\s*["']([^"']+)["']/g).map((name) => ({ name, path: rel })));
  } else {
    inventory.invokes.push(...matches(text, /\binvoke\(\s*["']([^"']+)["']/g).map((name) => ({ name, path: rel })));
    inventory.listens.push(...matches(text, /\blisten\(\s*["']([^"']+)["']/g).map((name) => ({ name, path: rel })));
  }
}

inventory.files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
for (const key of ['commands', 'invokes', 'emits', 'listens']) inventory[key].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
inventory.totals = {
  files: inventory.files.length,
  lines: inventory.files.reduce((sum, file) => sum + file.lines, 0),
  commands: inventory.commands.length,
  invokes: inventory.invokes.length,
  emittedEvents: inventory.emits.length,
  listenedEvents: inventory.listens.length,
  directTauriInvokes: inventory.invokes.filter((call) => call.path !== 'src/js/tauri-bridge.js').length,
};

const json = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv.includes('--write')) {
  const outputDir = join(root, 'test-output');
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, 'architecture-inventory.json');
  await writeFile(output, json);
  console.log(relative(root, output));
} else {
  process.stdout.write(json);
}
