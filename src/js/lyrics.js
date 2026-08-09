/**
 * src/js/lyrics.js - LRC Lyric Loading Utility
 */

import { invoke } from './tauri-bridge.js';
export { parseLrc } from './lrc-parser.js';
import { parseLrc, parseMarkers, getIntroSkipTargetSec } from './lrc-parser.js';

export async function loadLyricsForTrack(audioPath, duration = 0) {
  return (await loadLyricsAndMarkers(audioPath, duration)).segments;
}

/**
 * 가사 세그먼트와 구간 마커를 한 번의 파일 읽기로 함께 가져온다.
 *
 * 마커(보컬 시작·간주)가 필요한 이유: 전주나 간주에 들어가면 오버레이 가사를
 * 비워야 하는데, 세그먼트만 봐서는 "아직 첫 줄 전"과 "간주 중"을 구분할 수
 * 없다. 같은 파일을 두 번 읽지 않도록 여기서 같이 파싱한다.
 *
 * @returns {{segments: Array, markers: {vocalStartSec: number|null, interludes: Array}}}
 */
export async function loadLyricsAndMarkers(audioPath, duration = 0) {
  const empty = { segments: [], markers: { vocalStartSec: null, interludes: [] } };
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (!content || !content.trim()) return empty;

    let segments = parseLrc(content, duration);

    // 사이드카를 여기서 함께 읽는다.
    //
    // 예전에는 가사 싱크 편집기와 정렬 대기열에서만 읽었다. 그래서 재생 중인
    // 곡의 세그먼트에는 단어 타임(words)이 한 번도 실리지 않았고, 오버레이와
    // 라이브 화면의 진행도가 결국 줄 단위 선형 보간으로만 그려졌다 —
    // 편집기에서 맞춰 둔 타이밍과 어긋나 보이는 원인이었다.
    //
    // 실패해도 가사는 그대로 쓴다. 사이드카는 있으면 좋은 파생 데이터지,
    // 없다고 재생을 막을 것이 아니다.
    try {
      const sidecar = await invoke('load_alignment_metadata', { audioPath });
      if (sidecar) {
        const { applyAlignmentMetadata } = await import('./alignment-metadata.js');
        segments = applyAlignmentMetadata(segments, sidecar).segments;
      }
    } catch (metaErr) {
      console.log('[Lyrics] alignment sidecar not loaded:', metaErr);
    }

    return { segments, markers: parseMarkers(content) };
  } catch (err) {
    console.log("[Lyrics] No LRC file found or load failed:", err);
  }
  return empty;
}

/**
 * Reads just the "보컬 시작 지점" marker (if any) from a track's LRC file —
 * used to auto-skip a leading intro (music-video intro, dialogue, etc.) on
 * YouTube-sourced songs. Returns null when there's no LRC file or no marker.
 */
export async function getVocalStartMarker(audioPath) {
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (content && content.trim()) {
      return parseMarkers(content).vocalStartSec;
    }
  } catch (err) {
    console.log("[Lyrics] No LRC file found for vocal-start marker lookup:", err);
  }
  return null;
}

/**
 * 인트로 자동 건너뛰기의 목표 지점(초)을 계산한다. 보컬 시작 전에 끝나는
 * 간주(전주) 마커가 있으면 그 간주의 시작으로(전주 음악은 안 잘림), 없으면
 * 보컬 시작으로. LRC/마커가 없으면 null. (getIntroSkipTargetSec 참고)
 */
export async function getIntroSkipTarget(audioPath) {
  try {
    const content = await invoke('load_lrc_file', { audioPath });
    if (content && content.trim()) {
      return getIntroSkipTargetSec(parseMarkers(content));
    }
  } catch (err) {
    console.log("[Lyrics] No LRC file found for intro-skip lookup:", err);
  }
  return null;
}
