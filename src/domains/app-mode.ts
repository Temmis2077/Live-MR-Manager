import type { AppMode } from '../contracts/tauri.js';

export interface ProductDomain {
  id: AppMode;
  label: string;
  purpose: string;
  capabilities: readonly string[];
}

export const PRODUCT_DOMAINS: Record<AppMode, ProductDomain> = {
  live: {
    id: 'live',
    label: '라이브',
    purpose: '방송과 공연 중 끊기지 않는 스템 재생과 가사·OBS 운영',
    capabilities: ['session-queue', 'lyrics', 'overlay', 'dual-output'],
  },
  practice: {
    id: 'practice',
    label: '악기 연습',
    purpose: '악기 스템을 느리게 듣고 구간을 반복하며 입력과 연주를 비교',
    capabilities: ['instrument-stems', 'ab-loop', 'tempo-pitch', 'metronome', 'input'],
  },
};

/** Existing persisted value retained during the migration window. */
export function normalizeAppMode(value: string | null | undefined): AppMode | null {
  if (value === 'live') return 'live';
  if (value === 'practice' || value === 'recording') return 'practice';
  return null;
}

