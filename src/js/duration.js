/**
 * duration.js — 곡 길이 문자열을 초로 바꾼다 (순수 함수).
 *
 * 라이브러리는 길이를 "3:47" 같은 표시용 문자열로 들고 있는데, LRCLIB 조회는
 * 초 단위 숫자를 받는다. 이 변환이 틀리면 같은 제목의 다른 길이 버전(TV
 * 사이즈·확장판)이 매칭되어 통째로 밀린 가사가 붙으므로, 애매하면 값을
 * 지어내지 않고 null을 준다(백엔드는 길이를 모르면 대조를 건너뛴다).
 */

/**
 * @param {string|number|null|undefined} value "3:47" · "1:02:03" · 227 · null
 * @returns {number|null} 초. 해석할 수 없으면 null.
 */
export function durationToSeconds(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  // "3:47" / "1:02:03" 만 받는다. "약 3분" 같은 건 해석하지 않는다.
  if (!/^\d+(:\d{1,2})*$/.test(text)) return null;

  const parts = text.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;

  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  return secs > 0 ? secs : null;
}
