import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG,
  LEGACY_MODEL_POLICIES,
  findLegacyModelPolicy,
} from '../src/js/model-catalog.js';

describe('commercial model catalog policy', () => {
  it('does not redistribute optional noncommercial models through the catalog', () => {
    expect(MODEL_CATALOG).toEqual([]);
  });

  it('pins every downloadable candidate and records its usage policy', () => {
    for (const model of MODEL_CATALOG) {
      expect(model.url).toContain(model.sourceRevision);
      expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(['allowed', 'restricted', 'unverified']).toContain(model.commercialUse);
      expect(['allowed', 'restricted', 'unverified']).toContain(model.redistribution);
    }
  });

  it('does not recommend a candidate before runtime verification', () => {
    const pending = MODEL_CATALOG.filter((model) => model.verification !== 'verified');
    expect(pending.every((model) => model.recommended === false)).toBe(true);
  });

  it('recognizes previously installed Deux models without deleting them', () => {
    const legacy = LEGACY_MODEL_POLICIES[0];
    expect(findLegacyModelPolicy({ name: 'Mel-Band RoFormer Deux', url: null })).toEqual(legacy);
    expect(findLegacyModelPolicy({ name: 'custom', url: legacy.matchUrls[0] })).toEqual(legacy);
    expect(legacy.commercialUse).toBe('restricted');
  });
});
