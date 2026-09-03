import { describe, it, expect, beforeEach } from 'vitest';
import { collectBackupSettings, restoreBackupSettings, EXCLUDED_KEYS } from '../src/js/backup-settings.js';

/** localStorage 흉내 — 실제 Storage와 같은 length/key(i) 인터페이스만 갖춘다. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

describe('collectBackupSettings', () => {
  it('사용자 설정을 담는다', () => {
    const storage = fakeStorage({
      themeMode: 'dark',
      masterVolume: '85',
      'overlay-settings': '{"scale":1.2}',
    });
    expect(collectBackupSettings(storage)).toEqual({
      themeMode: 'dark',
      masterVolume: '85',
      'overlay-settings': '{"scale":1.2}',
    });
  });

  it('그 PC에서만 의미 있는 키는 뺀다', () => {
    const storage = fakeStorage({
      themeMode: 'dark',
      taxonomyMigratedV2: 'true',
      dismissedAppUpdateVersion: '1.0.0-beta.1',
      liveQueue: '["/a.mp3"]',
      alignmentQueueV1: '[{"path":"C:/only/here.mp3"}]',
      separationQueueV1: '[]',
    });
    expect(collectBackupSettings(storage)).toEqual({ themeMode: 'dark' });
  });

  it('새로 추가된 설정도 목록 수정 없이 자동으로 담긴다', () => {
    // 허용 목록이 아니라 제외 목록으로 만든 이유가 이것이다 —
    // 설정을 추가한 사람이 무언가를 잊어도 백업에서 조용히 빠지지 않는다.
    const storage = fakeStorage({ someBrandNewSetting: 'on' });
    expect(collectBackupSettings(storage)).toEqual({ someBrandNewSetting: 'on' });
  });

  it('빈 저장소는 빈 객체', () => {
    expect(collectBackupSettings(fakeStorage())).toEqual({});
  });
});

describe('restoreBackupSettings', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('설정을 되돌리고 개수를 알려준다', () => {
    const result = restoreBackupSettings({ themeMode: 'sky', masterVolume: '70' }, storage);
    expect(result).toEqual({ restored: 2, skipped: 0 });
    expect(storage.getItem('themeMode')).toBe('dark');
    expect(storage.getItem('masterVolume')).toBe('70');
  });

  it('백업 파일에 제외 대상이 들어 있어도 쓰지 않는다', () => {
    // 백업은 사용자가 열어서 고칠 수 있는 JSON이라 그대로 믿지 않는다.
    const result = restoreBackupSettings({ themeMode: 'dark', taxonomyMigratedV2: 'true' }, storage);
    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect(storage.getItem('taxonomyMigratedV2')).toBe(null);
  });

  it('문자열이 아닌 값은 건너뛴다', () => {
    const result = restoreBackupSettings({ a: 1, b: null, c: { x: 1 }, d: 'ok' }, storage);
    expect(result).toEqual({ restored: 1, skipped: 3 });
    expect(storage.getItem('d')).toBe('ok');
  });

  it('설정이 없는 옛 백업(v1)이어도 터지지 않는다', () => {
    expect(restoreBackupSettings(undefined, storage)).toEqual({ restored: 0, skipped: 0 });
    expect(restoreBackupSettings(null, storage)).toEqual({ restored: 0, skipped: 0 });
    expect(restoreBackupSettings({}, storage)).toEqual({ restored: 0, skipped: 0 });
  });

  it('한 키가 실패해도 나머지는 복원한다', () => {
    const failing = fakeStorage();
    const realSet = failing.setItem;
    failing.setItem = (k, v) => {
      if (k === 'bad') throw new Error('QuotaExceeded');
      realSet(k, v);
    };
    const result = restoreBackupSettings({ good1: '1', bad: 'x', good2: '2' }, failing);
    expect(result).toEqual({ restored: 2, skipped: 1 });
    expect(failing.getItem('good2')).toBe('2');
  });
});

describe('내보내기 ↔ 되돌리기 왕복', () => {
  it('담은 것이 그대로 돌아온다', () => {
    const source = fakeStorage({
      themeMode: 'dark',
      liveQueue: '["/a.mp3","/b.mp3"]',
      taxonomyMigratedV2: 'true', // 빠져야 하는 것
    });
    const target = fakeStorage();
    restoreBackupSettings(collectBackupSettings(source), target);

    expect(collectBackupSettings(target)).toEqual({
      themeMode: 'dark',
    });
    expect(target.getItem('liveQueue')).toBe(null);
    expect(target.getItem('taxonomyMigratedV2')).toBe(null);
  });

  it('제외 목록은 수집과 복원 양쪽에 같이 적용된다', () => {
    for (const key of EXCLUDED_KEYS) {
      expect(collectBackupSettings(fakeStorage({ [key]: 'v' }))).toEqual({});
      const t = fakeStorage();
      restoreBackupSettings({ [key]: 'v' }, t);
      expect(t.getItem(key)).toBe(null);
    }
  });
});
