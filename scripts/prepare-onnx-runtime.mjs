import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const sourceDir = process.env.ORT_LIB_LOCATION;
if (!sourceDir) {
  throw new Error('ORT_LIB_LOCATION is required to build the Windows installer.');
}

const names = [
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'onnxruntime_providers_cuda.dll',
  'onnxruntime_providers_tensorrt.dll',
];
const targetDir = path.resolve('src-tauri/runtime');
await mkdir(targetDir, { recursive: true });

for (const name of names) {
  const source = path.join(sourceDir, name);
  const info = await stat(source);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Invalid ONNX Runtime file: ${source}`);
  }
  await copyFile(source, path.join(targetDir, name));
  console.log(`Staged ${name} (${info.size} bytes)`);
}
