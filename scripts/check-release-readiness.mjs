import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

async function text(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function cargoVersion(source) {
  const packageBlock = source.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] || '';
  return packageBlock.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || '';
}

export async function collectReleaseReadinessFailures() {
  const [packageSource, tauriSource, cargoSource, workflow, releaseNotes, viteConfig, mainStyles, meloming, appMode, appLib, onnxEngine] = await Promise.all([
    text('package.json'),
    text('src-tauri/tauri.conf.json'),
    text('src-tauri/Cargo.toml'),
    text('.github/workflows/release.yml'),
    text('RELEASE_NOTES.md'),
    text('vite.config.js'),
    text('src/style.css'),
    text('src/js/events/meloming.js'),
    text('src/js/events/app-mode-ui.js'),
    text('src-tauri/src/lib.rs'),
    text('src-tauri/src/onnx_engine.rs'),
  ]);

  const packageJson = JSON.parse(packageSource);
  const tauriJson = JSON.parse(tauriSource);
  const versions = {
    'package.json': packageJson.version,
    'src-tauri/tauri.conf.json': tauriJson.version,
    'src-tauri/Cargo.toml': cargoVersion(cargoSource),
  };
  const expectedVersion = packageJson.version;
  const failures = [];

  for (const [file, version] of Object.entries(versions)) {
    if (version !== expectedVersion) failures.push(`${file} version ${version || '(missing)'} != ${expectedVersion}`);
  }
  if (!releaseNotes.includes(expectedVersion)) failures.push(`RELEASE_NOTES.md does not mention ${expectedVersion}`);
  if (!/base:\s*['"]\.\/['"]/.test(viteConfig)) failures.push("Vite base must remain './' for installed Tauri assets");
  if (/^@import\s+["'][^"']+\?v=/m.test(mainStyles)) failures.push('Main CSS imports must not use cache-busting queries that bypass Vite bundling');
  if (tauriJson.build?.beforeBuildCommand !== 'npm run prepare:runtime && npm run build') {
    failures.push('Tauri build must stage ONNX Runtime before the frontend build');
  }
  if (tauriJson.bundle?.resources?.['runtime/onnxruntime.dll'] !== 'onnxruntime.dll') {
    failures.push('NSIS bundle must install the pinned ONNX Runtime next to the executable');
  }
  for (const provider of ['shared', 'cuda', 'tensorrt']) {
    const name = `onnxruntime_providers_${provider}.dll`;
    if (tauriJson.bundle?.resources?.[`runtime/${name}`] !== name) {
      failures.push(`NSIS bundle must install ${name} next to the executable`);
    }
  }
  if (!/features\s*=\s*\[[^\]]*"load-dynamic"/.test(cargoSource)) failures.push('ort must use load-dynamic for the pinned bundled runtime');
  if (!/initialize_bundled_runtime\(\)/.test(appLib) || !/ort::init_from\(&runtime\)/.test(onnxEngine)) {
    failures.push('app startup must select the bundled ONNX Runtime by absolute path');
  }
  if (/maybe_migrate_legacy_data|mod\s+migration\s*;/.test(appLib)) failures.push('legacy user-data migration must remain disabled');
  if (!/releaseDraft:\s*true/.test(workflow)) failures.push('release workflow must create a draft release');
  if (!/prerelease:\s*true/.test(workflow)) failures.push('release workflow must mark beta builds as prereleases');
  if (!/MELOMING_UI_ENABLED\s*=\s*false/.test(meloming)) failures.push('Meloming UI must remain disabled for this beta');
  if (!/APP_MODE_UI_ENABLED\s*=\s*false/.test(appMode)) failures.push('unfinished app-mode UI must remain disabled for this beta');
  if (tauriJson.app?.windows?.[0]?.minWidth !== 1024 || tauriJson.app?.windows?.[0]?.minHeight !== 600) {
    failures.push('Tauri minimum window contract must remain 1024x600');
  }

  return { expectedVersion, versions, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = await collectReleaseReadinessFailures();
  if (result.failures.length) {
    console.error('Release readiness FAILED:');
    result.failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`Release readiness OK (${result.expectedVersion}).`);
    console.log('Versions, beta workflow flags, minimum window size, and hidden feature gates are consistent.');
  }
}
