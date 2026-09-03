import { describe, it, expect } from 'vitest';
import {
  ADD_PATHS, BASICS, hasSeenGuide, markGuideSeen, shouldShowWelcome,
} from '../src/js/onboarding.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

/** getItem/setItem이 던지는 저장소(사생활 보호 모드 등). */
function brokenStorage() {
  return {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
}

describe('곡 넣는 세 갈래', () => {
  it('세 경로가 모두 있고 CSV가 포함된다', () => {
    expect(ADD_PATHS).toHaveLength(3);
    expect(ADD_PATHS.map((p) => p.id)).toEqual(['local', 'youtube', 'csv']);
  });

  it('모든 경로가 제목·설명·동작·버튼 이름을 갖춘다', () => {
    for (const p of ADD_PATHS) {
      expect(p.title, p.id).toBeTruthy();
      expect(p.desc, p.id).toBeTruthy();
      expect(p.action, p.id).toBeTruthy();
      expect(p.cta, p.id).toBeTruthy();
    }
  });

  it('CSV 경로는 양식 받기와 가져오기 둘 다 제공한다', () => {
    // 목록만 있고 양식을 모르는 사람이 대부분이라 두 단계가 한자리에 있어야 한다.
    const csv = ADD_PATHS.find((p) => p.id === 'csv');
    expect(csv.action).toBe('csv-template');
    expect(csv.secondaryAction).toBe('csv-import');
  });

  it('동작 이름이 서로 겹치지 않는다', () => {
    const actions = ADD_PATHS.flatMap((p) => [p.action, p.secondaryAction].filter(Boolean));
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe('알아두면 좋은 것', () => {
  it('항목마다 제목과 본문이 있다', () => {
    expect(BASICS.length).toBeGreaterThan(0);
    for (const b of BASICS) {
      expect(b.title).toBeTruthy();
      expect(b.body).toBeTruthy();
    }
  });
});

describe('첫 실행 환영 화면', () => {
  it('처음 보는 사용자에게는 뜬다', () => {
    const storage = fakeStorage();
    expect(shouldShowWelcome({ songCount: 0, storage })).toBe(true);
  });

  it('한 번 본 뒤에는 뜨지 않는다', () => {
    const storage = fakeStorage();
    markGuideSeen(storage);
    expect(hasSeenGuide(storage)).toBe(true);
    expect(shouldShowWelcome({ songCount: 0, storage })).toBe(false);
  });

  it('곡이 이미 있으면 뜨지 않는다', () => {
    // 이전 버전에서 데이터를 가져온 사람은 첫 실행이어도 방해하지 않는다.
    const storage = fakeStorage();
    expect(shouldShowWelcome({ songCount: 42, storage })).toBe(false);
  });

  it('저장소를 못 쓰면 매번 뜨지 않게 막는다', () => {
    const storage = brokenStorage();
    expect(hasSeenGuide(storage)).toBe(true);
    expect(shouldShowWelcome({ songCount: 0, storage })).toBe(false);
    // 기록이 실패해도 예외를 밖으로 내보내지 않는다(초기화가 멈추면 안 된다).
    expect(() => markGuideSeen(storage)).not.toThrow();
  });

  it('인자 없이 불러도 터지지 않는다', () => {
    expect(() => shouldShowWelcome({ songCount: 0, storage: fakeStorage() })).not.toThrow();
  });
});
