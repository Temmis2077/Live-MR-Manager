import { invoke as tauriInvoke } from '@tauri-apps/api/core';

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

/** Temporary escape hatch used only inside domain services during migration. */
export async function invokeLegacy<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(`Browser mock missing for legacy command: ${command}`);
  }
  return tauriInvoke<T>(command, args);
}

