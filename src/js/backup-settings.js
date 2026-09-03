/**
 * backup-settings.js — 백업에 담을 앱 설정 추리기
 *
 * 앱 설정은 DB가 아니라 localStorage에 있다(테마·볼륨·오버레이 디자인 등).
 * 그래서 백업을 들고 새 PC로 옮겨도 이 값들은 따라가지
 * 않았고, 오버레이 디자인을 처음부터 다시 맞춰야 했다.
 *
 * 설계 — 담을 키를 나열하지 않고 **뺄 키만 나열한다**. 허용 목록으로 만들면
 * 새 설정을 추가한 사람이 목록에 넣는 걸 잊었을 때 조용히 백업에서 빠진다.
 * 지금 고치는 버그가 정확히 그 모양이라 같은 함정을 다시 팔 이유가 없다.
 */

/**
 * 백업에 담지 않을 키.
 *
 * 여기 있는 것들의 공통점 — "그 PC에서만 의미 있는 값"이다. 다른 PC로
 * 옮기면 틀린 값이 되거나 해를 끼친다.
 */
export const EXCLUDED_KEYS = new Set([
  // 마이그레이션 이력. 새 PC에서 '이미 했음'으로 복원되면 필요한 재매핑을
  // 건너뛰어 장르·카테고리가 옛 값으로 남는다.
  'taxonomyMigratedV1',
  'taxonomyMigratedV2',
  // 이 PC에서 '나중에'를 누른 업데이트 버전. 새 PC까지 따라갈 이유가 없다.
  'dismissedAppUpdateVersion',
  // 진행 중이던 작업 스냅샷. 절대 경로를 참조해서 다른 PC에선 전부 깨진다.
  'separationQueueV1',
  'alignmentQueueV1',
  // 공연 한 번 동안만 쓰는 임시 순서. 옛 버전 백업에 있어도 복원하지 않는다.
  'liveQueue',
]);

/**
 * 백업에 담을 설정을 모은다.
 * @param {Storage} storage 기본값 localStorage (테스트에서 주입 가능)
 * @returns {Record<string, string>}
 */
export function collectBackupSettings(storage = localStorage) {
  const out = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || EXCLUDED_KEYS.has(key)) continue;
    const value = storage.getItem(key);
    // 값이 없는 키는 담아도 복원할 게 없다.
    if (typeof value === 'string') out[key] = key === 'themeMode' ? 'dark' : value;
  }
  return out;
}

/**
 * 백업에서 읽은 설정을 되돌린다.
 *
 * 백업 파일은 사용자가 손댈 수 있는 JSON이라 그대로 믿지 않는다 — 문자열이
 * 아닌 값과 제외 대상 키는 버린다. 복원하지 않은 키가 있으면 조용히 넘어가지
 * 않고 개수를 돌려줘서 호출부가 사용자에게 알릴 수 있게 한다.
 *
 * @returns {{restored: number, skipped: number}}
 */
export function restoreBackupSettings(settings, storage = localStorage) {
  let restored = 0;
  let skipped = 0;
  if (!settings || typeof settings !== 'object') return { restored, skipped };

  for (const [key, value] of Object.entries(settings)) {
    if (!key || EXCLUDED_KEYS.has(key) || typeof value !== 'string') {
      skipped += 1;
      continue;
    }
    try {
      // Old backups may contain light/pink/sky. Keep the key compatible while
      // mapping every previous theme to the single Red Orbit theme.
      storage.setItem(key, key === 'themeMode' ? 'dark' : value);
      restored += 1;
    } catch (err) {
      // 용량 초과 등 — 한 키가 실패해도 나머지는 계속 복원한다.
      console.error(`[Backup] 설정 복원 실패 (${key}):`, err);
      skipped += 1;
    }
  }
  return { restored, skipped };
}
