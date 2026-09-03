import type { ApiError } from '../generated/ipc.js';

export function normalizeApiError(error: unknown, fallbackCode = 'ipc.legacy'): ApiError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as Partial<ApiError>;
    return {
      code: String(candidate.code),
      message: String(candidate.message),
      recoverable: Boolean(candidate.recoverable),
      details: candidate.details ?? null,
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error ?? '알 수 없는 오류'),
    recoverable: false,
    details: null,
  };
}

export class IpcError extends Error {
  readonly contract: ApiError;

  constructor(error: unknown, fallbackCode?: string) {
    const contract = normalizeApiError(error, fallbackCode);
    super(contract.message);
    this.name = 'IpcError';
    this.contract = contract;
  }
}

