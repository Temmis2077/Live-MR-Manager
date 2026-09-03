import { describe, expect, it } from 'vitest';
import { collectReleaseReadinessFailures } from '../scripts/check-release-readiness.mjs';

describe('beta release readiness contract', () => {
  it('keeps versions, release flags, window size, and hidden features consistent', async () => {
    const result = await collectReleaseReadinessFailures();
    expect(result.expectedVersion).toBe('1.0.0-beta.1');
    expect(result.failures).toEqual([]);
  });
});
