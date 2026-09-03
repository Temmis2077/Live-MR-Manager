#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function walk(dir, extension) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path, extension));
    else if (extname(path) === extension) output.push(path);
  }
  return output;
}

const addOwner = (map, name, owner) => {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(owner);
};

const commandRows = [];
const eventEmitters = new Map();
for (const path of await walk(join(root, 'src-tauri/src'), '.rs')) {
  const text = await readFile(path, 'utf8');
  const rel = relative(root, path).replaceAll('\\', '/');
  for (const match of text.matchAll(/#\[tauri::command[^\]]*\][\s\S]{0,180}?pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g)) commandRows.push({ name: match[1], rust: rel });
  for (const match of text.matchAll(/\.emit\(\s*["']([^"']+)["']/g)) addOwner(eventEmitters, match[1], rel);
}

const callers = new Map();
const eventCallers = new Map();
for (const path of await walk(join(root, 'src'), '.js')) {
  const text = await readFile(path, 'utf8');
  const rel = relative(root, path).replaceAll('\\', '/');
  for (const match of text.matchAll(/\binvoke\(\s*['"]([^'"]+)['"]/g)) addOwner(callers, match[1], rel);
  for (const match of text.matchAll(/\blisten\(\s*['"]([^'"]+)['"]/g)) addOwner(eventCallers, match[1], rel);
}

const camelToSnake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
for (const path of await walk(join(root, 'src/ipc/services'), '.ts')) {
  const text = await readFile(path, 'utf8');
  const rel = relative(root, path).replaceAll('\\', '/');
  for (const match of text.matchAll(/\bcommands\.([A-Za-z0-9_]+)\s*\(/g)) addOwner(callers, camelToSnake(match[1]), rel);
}

const generated = await readFile(join(root, 'src/generated/ipc.ts'), 'utf8');
const typed = new Set([...generated.matchAll(/__TAURI_INVOKE(?:<[^>]+>)?\("([^"]+)"/g)].map((match) => match[1]));
const generatedEvents = [...generated.matchAll(/([A-Za-z0-9_]+): makeEvent<([^>]+)>\("([^"]+)"\)/g)]
  .map((match) => ({ property: match[1], payload: match[2], name: match[3] }));

for (const path of await walk(join(root, 'src/ipc/services'), '.ts')) {
  const text = await readFile(path, 'utf8');
  const rel = relative(root, path).replaceAll('\\', '/');
  for (const event of generatedEvents) if (text.includes(`events.${event.property}`)) addOwner(eventCallers, event.name, rel);
}

const domain = (path) => ['audio', 'library', 'alignment', 'model', 'system', 'overlay', 'meloming']
  .find((name) => path.includes(name)) ?? 'integrations';

commandRows.sort((a, b) => a.name.localeCompare(b.name));
const rows = commandRows.map((row) => {
  const callList = [...(callers.get(row.name) ?? [])];
  return `| \`${row.name}\` | ${domain(row.rust)} | ${typed.has(row.name) ? 'typed' : 'legacy'} | ${callList.length ? callList.map((path) => `\`${path}\``).join('<br>') : '—'} | \`${row.rust}\` |`;
});

const eventNames = new Set([...eventEmitters.keys(), ...eventCallers.keys(), ...generatedEvents.map((event) => event.name)]);
const eventRows = [...eventNames].sort().map((name) => {
  const typedEvent = generatedEvents.find((event) => event.name === name);
  const emitters = [...(eventEmitters.get(name) ?? [])];
  const listeners = [...(eventCallers.get(name) ?? [])];
  return `| \`${name}\` | ${typedEvent ? `\`${typedEvent.payload}\`` : 'unknown'} | ${typedEvent ? 'typed' : 'legacy'} | ${emitters.length ? emitters.map((path) => `\`${path}\``).join('<br>') : '—'} | ${listeners.length ? listeners.map((path) => `\`${path}\``).join('<br>') : '—'} |`;
});

const markdown = `# OSW IPC 카탈로그

> 자동 생성 파일. \`npm run generate:ipc\`로 갱신합니다.

- Rust command: ${commandRows.length}
- 생성 TypeScript command: ${typed.size}
- 직접 호출이 확인된 command: ${callers.size}
- 확인된 event: ${eventNames.size}
- 생성 TypeScript event: ${generatedEvents.length}

| Command | Domain | Migration | Frontend callers | Rust owner |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

## Events

| Event | Payload | Migration | Rust emitters | Frontend listeners |
| --- | --- | --- | --- | --- |
${eventRows.join('\n')}
`;
await writeFile(join(root, 'docs/IPC_CATALOG.md'), markdown);
console.log('docs/IPC_CATALOG.md');
