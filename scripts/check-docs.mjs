import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function walk(directory, extensions) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', 'docs-private', '.git'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, extensions));
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function report(file, message) {
  failures.push(`${relative(root, file)}: ${message}`);
}

function githubSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function headingSlugs(markdown) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const base = githubSlug(match[2].replace(/\s+#+$/, ''));
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

const markdownFiles = [
  ...['README.md', 'RELEASE_NOTES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ToDo.md']
    .map((file) => resolve(root, file))
    .filter(existsSync),
  ...walk(resolve(root, 'docs'), new Set(['.md'])),
  ...walk(resolve(root, 'web', 'companion'), new Set(['.md'])),
];

const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(markdownLink)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|app:)/i.test(target)) continue;
    const hashIndex = target.indexOf('#');
    const hash = hashIndex >= 0 ? decodeURIComponent(target.slice(hashIndex + 1)) : '';
    target = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const targetFile = target ? resolve(dirname(file), decodeURIComponent(target)) : file;
    if (!existsSync(targetFile)) {
      report(file, `없는 링크 대상: ${match[1]}`);
      continue;
    }
    if (hash && statSync(targetFile).isFile() && extname(targetFile).toLowerCase() === '.md') {
      const slugs = headingSlugs(readFileSync(targetFile, 'utf8'));
      if (!slugs.has(hash.toLowerCase())) report(file, `없는 Markdown 앵커: ${match[1]}`);
    }
  }
}

const publicTextFiles = [
  ...markdownFiles,
  ...walk(resolve(root, 'web', 'companion'), new Set(['.ts', '.tsx'])),
  resolve(root, 'src', 'js', 'companion-links.js'),
  resolve(root, 'src-tauri', 'src', 'meloming', 'oauth.rs'),
].filter(existsSync);

for (const file of publicTextFiles) {
  const content = readFileSync(file, 'utf8');
  if (content.includes('lmrm.vercel.app')) report(file, '옛 Companion 주소가 남아 있음');
  if (/\b(?:436|488)\s*(?:개|passed)/i.test(content)) report(file, '오래된 자동 테스트 개수가 남아 있음');
  if (content.includes('docs/DEVELOPMENT_STATUS.md')) report(file, '비공개 개발 상태 문서를 링크함');
  if (content.includes('COMMERCIAL_MODEL_AND_RIGHTS_REPORT.md')) report(file, '비공개 권리 조사 원본을 링크함');
  if (content.includes('MELOMING_SONGBOOK_INTEGRATION.md')) report(file, '비공개 멜로밍 기획을 링크함');
  if (content.includes('DISCORD_SETUP.md')) report(file, '존재하지 않는 Discord 문서를 링크함');
}

const requiredClaims = [
  ['README.md', 'GitHub Releases](https://github.com/Temmis2077/OSW/releases/tag/v1.0.0-beta.1)'],
  ['RELEASE_NOTES.md', '상대 자산 경로를 수정하고 재설치해 UI 표시를 확인함'],
  ['web/companion/app/download/page.tsx', 'Windows 베타 다운로드'],
  ['web/companion/lib/faq-data.ts', '현재 앱에서는 준비 중이라 UI에 표시되지 않습니다'],
];
for (const [name, text] of requiredClaims) {
  const file = resolve(root, name);
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes(text)) report(file, `필수 상태 문구 누락: ${text}`);
}

const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
if (!/^docs-private\/$/m.test(gitignore)) failures.push('docs-private/: .gitignore 규칙이 적용되지 않음');

try {
  const tracked = execFileSync('git', ['ls-files', '--', 'docs-private'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (tracked) failures.push(`docs-private/: Git 추적 파일이 있음\n${tracked}`);
} catch (error) {
  if (error.code === 'EPERM') {
    console.warn('경고: 현재 제한된 Windows 환경에서는 Git 추적 여부를 실행하지 못했습니다. CI에서는 동일 검사를 실행합니다.');
  } else {
    failures.push(`docs-private Git 추적 검사 실패: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`문서 검사 실패 (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`문서 검사 통과: Markdown ${markdownFiles.length}개, 공개 상태·비공개 경계 확인`);
