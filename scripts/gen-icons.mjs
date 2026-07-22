// OSW 아이콘 생성: 마크 SVG → 1024 PNG(sharp) → `tauri icon`으로 전 사이즈.
// 실행: node scripts/gen-icons.mjs  (그 뒤 자동으로 tauri icon 호출)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// sharp는 컴패니언(Next.js)에 설치돼 있어 그쪽 것을 직접 쓴다.
const sharp = (await import(pathToFileURL(join(root, 'web', 'companion', 'node_modules', 'sharp', 'lib', 'index.js')).href)).default;

// 아이콘용 마크 — 여백을 둔 256 뷰박스(태스크바·타일에서 잘리지 않게). 배경 투명.
const ICON_SVG = `<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-18 128 128)">
    <path d="M 26 128 A 102 31 0 0 1 230 128" fill="none" stroke="#8b5cf6" stroke-width="17" stroke-linecap="round"/>
    <circle cx="128" cy="128" r="58" fill="#7c3aed"/>
    <path d="M 26 128 A 102 31 0 0 0 230 128" fill="none" stroke="#a78bfa" stroke-width="17" stroke-linecap="round"/>
  </g>
</svg>`;

const srcPng = join(root, 'src-tauri', 'icons', 'icon-source.png');

async function main() {
  // 1) 1024 PNG로 래스터화(투명 배경).
  await sharp(Buffer.from(ICON_SVG), { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(srcPng);
  console.log('[icons] source PNG:', srcPng);

  // 2) Tauri 아이콘 전 사이즈 생성(32/128/@2x/.ico/타일 등).
  execSync(`npx tauri icon "${srcPng}"`, { cwd: root, stdio: 'inherit' });

  // 3) 인앱·컴패니언에서 쓰는 app-icon.png(256) + 파비콘도 갱신.
  const targets = [
    join(root, 'src', 'assets', 'images', 'app-icon.png'),
    join(root, 'web', 'companion', 'public', 'images', 'app-icon.png'),
    join(root, 'web', 'companion', 'public', 'images', 'logo.png'),
  ];
  for (const t of targets) {
    try {
      await sharp(Buffer.from(ICON_SVG), { density: 384 })
        .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(t);
      console.log('[icons] wrote', t);
    } catch (e) {
      console.warn('[icons] skip', t, e.message);
    }
  }
  // 파비콘(.ico) — companion public 루트.
  try {
    const favPng = join(root, 'web', 'companion', 'public', 'favicon.png');
    await sharp(Buffer.from(ICON_SVG), { density: 384 })
      .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(favPng);
    console.log('[icons] favicon.png written');
  } catch (e) {
    console.warn('[icons] favicon skip:', e.message);
  }
  console.log('[icons] done');
}

main().catch((e) => { console.error(e); process.exit(1); });
