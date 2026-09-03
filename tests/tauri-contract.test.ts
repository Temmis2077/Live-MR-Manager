import { describe, expect, it } from 'vitest';
import { normalizeApiError } from '../src/ipc/errors.js';
import { normalizeAppMode, PRODUCT_DOMAINS } from '../src/domains/app-mode.js';

describe('generated IPC error compatibility', () => {
  it('preserves a structured Rust error', () => {
    expect(normalizeApiError({ code: 'audio.device', message: 'offline', recoverable: true }))
      .toEqual({ code: 'audio.device', message: 'offline', recoverable: true, details: null });
  });

  it('normalizes legacy string errors during migration', () => {
    expect(normalizeApiError('legacy failure').message).toBe('legacy failure');
  });
});

describe('product domain migration', () => {
  it('maps the legacy recording value to practice without losing preferences', () => {
    expect(normalizeAppMode('recording')).toBe('practice');
    expect(PRODUCT_DOMAINS.practice.capabilities).toContain('ab-loop');
  });
});
