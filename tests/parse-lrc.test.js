import { describe, expect, it } from 'vitest';
import { parseLrc, parseMarkers, formatMarkerLine, isTriplet, getSyncText, encodeLrc, normalizeLyricTimeline, suggestVocalStartFromSegments, getIntroSkipTargetSec, parseTimeInput, formatTimeInput, groupTripletLines, isHangulDominant } from '../src/js/lrc-parser.js';

describe('encodeLrc', () => {
  it('preserves segment order for partially-synced lyrics (no time-sorting)', () => {
    // 위쪽 두 줄은 싱크됨, 아래 두 줄은 아직 미싱크(0초) — 저장/재로드 후에도
    // 미싱크 줄이 위로 올라오지 않고 원래 텍스트 순서가 유지되어야 한다.
    const segments = [
      { text: '싱크된 첫 줄', start: 10, end: 15 },
      { text: '싱크된 둘째 줄', start: 15, end: 0 },
      { text: '미싱크 셋째 줄', start: 0, end: 0 },
      { text: '미싱크 넷째 줄', start: 0, end: 0 },
    ];
    const content = encodeLrc(segments);
    const roundTripped = parseLrc(content, 60);
    expect(roundTripped.map((s) => s.text)).toEqual([
      '싱크된 첫 줄', '싱크된 둘째 줄', '미싱크 셋째 줄', '미싱크 넷째 줄',
    ]);
    expect(roundTripped[0].start).toBeCloseTo(10);
    expect(roundTripped[2].start).toBe(0);
  });

  it('appends marker lines at the end and they still parse', () => {
    const segments = [{ text: '가사', start: 0, end: 0 }];
    const markers = [formatMarkerLine(12.5, 'vocalstart'), formatMarkerLine(60, 'ilstart'), formatMarkerLine(75, 'ilend')];
    const content = encodeLrc(segments, markers);
    const parsedMarkers = parseMarkers(content);
    expect(parsedMarkers.vocalStartSec).toBeCloseTo(12.5);
    expect(parsedMarkers.interludes).toHaveLength(1);
    // 마커 줄이 가사 세그먼트로 새지 않아야 함
    expect(parseLrc(content, 90).map((s) => s.text)).toEqual(['가사']);
  });

  it('round-trips triplet cues', () => {
    const segments = [
      { text: '原文', original: '原文', pronunciation: '차음', translation: '번역', start: 5, end: 0 },
    ];
    const roundTripped = parseLrc(encodeLrc(segments), 30);
    expect(roundTripped).toHaveLength(1);
    expect(isTriplet(roundTripped[0])).toBe(true);
    expect(roundTripped[0].pronunciation).toBe('차음');
    expect(roundTripped[0].start).toBeCloseTo(5);
  });

  it('preserves completed lyric order before writing', () => {
    const content = encodeLrc([
      { text: '늦게 입력된 앞 가사', start: 20, end: 0 },
      { text: '먼저 불린 뒷 가사', start: 10, end: 0 },
      { text: '마지막 가사', start: 30, end: 0 },
    ]);
    expect(parseLrc(content, 40).map((s) => s.text)).toEqual([
      '늦게 입력된 앞 가사', '먼저 불린 뒷 가사', '마지막 가사',
    ]);
  });
});

describe('parseLrc', () => {
  it('parses timestamped lines', () => {
    const lrc = `[00:12.50]첫 번째 줄\n[00:18.00]두 번째 줄`;
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('첫 번째 줄');
    expect(segments[0].start).toBeCloseTo(12.5);
    expect(segments[1].start).toBeCloseTo(18);
    expect(segments[0].end).toBeCloseTo(18);
  });

  it('ignores metadata tags', () => {
    const lrc = `[ar:Artist]\n[00:01.00]가사`;
    const segments = parseLrc(lrc, 10);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('가사');
  });

  it('does not misread literal bracketed lyric text as a triplet/marker tag', () => {
    const lrc = `[00:01.00][후렴]가사`;
    const segments = parseLrc(lrc, 10);
    expect(segments[0].text).toBe('[후렴]가사');
    expect(isTriplet(segments[0])).toBe(false);
  });

  it('preserves lyric order even when imported timestamps are reverse', () => {
    const segments = parseLrc([
      '[00:20.00]둘째로 입력됐지만 늦은 가사',
      '[00:10.00]먼저 불린 가사',
      '[00:30.00]마지막 가사',
    ].join('\n'), 40);
    expect(segments.map((s) => s.start)).toEqual([20, 10, 30]);
    expect(segments.map((s) => s.text)).toEqual([
      '둘째로 입력됐지만 늦은 가사', '먼저 불린 가사', '마지막 가사',
    ]);
  });

  it('never moves cues across unsynced lyrics', () => {
    const normalized = normalizeLyricTimeline([
      { text: '늦은 싱크', start: 20 },
      { text: '아직 미싱크', start: 0 },
      { text: '이른 싱크', start: 10 },
    ]);
    expect(normalized.map((s) => s.text)).toEqual(['늦은 싱크', '아직 미싱크', '이른 싱크']);
  });

  it('keeps cue ordering and timing values untouched', () => {
    const normalized = normalizeLyricTimeline([
      { text: '늦은 가사', start: 20, end: 30 },
      { text: '빠른 가사', start: 10, end: 25 },
      { text: '동시 보컬', start: 10, end: 22 },
      { text: '마지막', start: 30, end: 35 },
    ]);
    expect(normalized.map((s) => s.start)).toEqual([20, 10, 10, 30]);
    expect(normalized.map((s) => s.end)).toEqual([30, 25, 22, 35]);
  });
});

describe('parseLrc triplet cues (원문/차음/번역)', () => {
  it('groups orig/pron/tran lines sharing a timestamp into one segment', () => {
    const lrc = [
      '[00:12.34][orig]忘れられぬものだけが',
      '[00:12.34][pron]와스레라레누 모노 다케가',
      '[00:12.34][tran]잊지 못하는 것만이',
    ].join('\n');
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(1);
    expect(segments[0].original).toBe('忘れられぬものだけが');
    expect(segments[0].pronunciation).toBe('와스레라레누 모노 다케가');
    expect(segments[0].translation).toBe('잊지 못하는 것만이');
    expect(segments[0].start).toBeCloseTo(12.34);
    expect(isTriplet(segments[0])).toBe(true);
    expect(getSyncText(segments[0])).toBe('와스레라레누 모노 다케가');
  });

  it('does not merge separate unsynced triplet cues that all sit at 00:00', () => {
    const lrc = [
      '[00:00.00][orig]一行目',
      '[00:00.00][pron]첫줄',
      '[00:00.00][tran]번역1',
      '[00:00.00][orig]二行目',
      '[00:00.00][pron]둘째줄',
      '[00:00.00][tran]번역2',
    ].join('\n');
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(2);
    expect(segments[0].original).toBe('一行目');
    expect(segments[1].original).toBe('二行目');
  });

  it('leaves plain single-line segments as non-triplet', () => {
    const segments = parseLrc('[00:01.00]평범한 가사', 10);
    expect(isTriplet(segments[0])).toBe(false);
    expect(getSyncText(segments[0])).toBe('평범한 가사');
  });
});

describe('parseMarkers', () => {
  it('extracts the vocal start anchor', () => {
    const lrc = `[00:12.34][vocalstart]\n[00:15.00]가사`;
    const markers = parseMarkers(lrc);
    expect(markers.vocalStartSec).toBeCloseTo(12.34);
  });

  it('pairs interlude start/end markers', () => {
    const lrc = `[00:10.00][ilstart]\n[00:25.50][ilend]`;
    const markers = parseMarkers(lrc);
    expect(markers.interludes).toHaveLength(1);
    expect(markers.interludes[0].start).toBeCloseTo(10);
    expect(markers.interludes[0].end).toBeCloseTo(25.5);
  });

  it('pairs multiple interludes in chronological order', () => {
    const lrc = [
      formatMarkerLine(60, 'ilstart'),
      formatMarkerLine(75, 'ilend'),
      formatMarkerLine(120, 'ilstart'),
      formatMarkerLine(140, 'ilend'),
    ].join('\n');
    const markers = parseMarkers(lrc);
    expect(markers.interludes).toHaveLength(2);
    expect(markers.interludes[0]).toMatchObject({ start: 60, end: 75 });
    expect(markers.interludes[1]).toMatchObject({ start: 120, end: 140 });
  });

  it('drops an unpaired trailing ilstart', () => {
    const lrc = `[00:10.00][ilstart]\n[00:25.00][ilend]\n[00:90.00][ilstart]`;
    const markers = parseMarkers(lrc);
    expect(markers.interludes).toHaveLength(1);
  });

  it('does not let marker lines leak into parseLrc segments', () => {
    const lrc = `${formatMarkerLine(5, 'vocalstart')}\n[00:10.00]첫 가사`;
    const segments = parseLrc(lrc, 30);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('첫 가사');
  });
});

describe('suggestVocalStartFromSegments (MV 인트로 감지)', () => {
  it('suggests the earliest synced start minus a lead-in', () => {
    const segments = [
      { text: 'a', start: 12.5, end: 14 },
      { text: 'b', start: 16, end: 18 },
    ];
    expect(suggestVocalStartFromSegments(segments)).toBeCloseTo(12.2);
  });

  it('ignores unsynced (start 0) segments when finding the earliest', () => {
    const segments = [
      { text: 'a', start: 0, end: 0 },
      { text: 'b', start: 20, end: 22 },
      { text: 'c', start: 0, end: 0 },
    ];
    expect(suggestVocalStartFromSegments(segments)).toBeCloseTo(19.7);
  });

  it('returns null when the intro is negligible (below the minimum)', () => {
    const segments = [{ text: 'a', start: 1.2, end: 3 }];
    expect(suggestVocalStartFromSegments(segments)).toBeNull();
  });

  it('returns null when nothing is synced', () => {
    const segments = [{ text: 'a', start: 0, end: 0 }];
    expect(suggestVocalStartFromSegments(segments)).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(suggestVocalStartFromSegments(null)).toBeNull();
    expect(suggestVocalStartFromSegments(undefined)).toBeNull();
  });
});

describe('getIntroSkipTargetSec (간주/보컬시작 구분)', () => {
  it('jumps to the pre-vocal interlude start instead of the vocal start', () => {
    // [MV 인트로 0~20s] [전주 간주 20~45s] [보컬 45s~] — 전주가 잘리면 안 됨
    const markers = { vocalStartSec: 45, interludes: [{ start: 20, end: 45 }] };
    expect(getIntroSkipTargetSec(markers)).toBe(20);
  });

  it('falls back to the vocal start when no interlude precedes it', () => {
    // 간주는 곡 중간에만 있음 — 전주 아님
    const markers = { vocalStartSec: 30, interludes: [{ start: 90, end: 120 }] };
    expect(getIntroSkipTargetSec(markers)).toBe(30);
  });

  it('allows a small tolerance for interludes ending just past the vocal start', () => {
    const markers = { vocalStartSec: 45, interludes: [{ start: 20, end: 45.8 }] };
    expect(getIntroSkipTargetSec(markers)).toBe(20);
  });

  it('ignores interludes that extend well past the vocal start', () => {
    // 보컬 시작을 한참 지나 끝나는 구간은 전주가 아니라 겹침 오류로 취급
    const markers = { vocalStartSec: 45, interludes: [{ start: 20, end: 80 }] };
    expect(getIntroSkipTargetSec(markers)).toBe(45);
  });

  it('picks the earliest qualifying interlude start', () => {
    const markers = {
      vocalStartSec: 60,
      interludes: [{ start: 40, end: 58 }, { start: 15, end: 35 }],
    };
    expect(getIntroSkipTargetSec(markers)).toBe(15);
  });

  it('returns null when there is no vocal-start marker', () => {
    expect(getIntroSkipTargetSec({ vocalStartSec: null, interludes: [{ start: 5, end: 10 }] })).toBeNull();
    expect(getIntroSkipTargetSec(null)).toBeNull();
  });
});

describe('parseTimeInput / formatTimeInput (마커 시각 편집)', () => {
  it('parses mm:ss, mm:ss.xx, and plain seconds', () => {
    expect(parseTimeInput('01:23')).toBeCloseTo(83);
    expect(parseTimeInput('01:23.45')).toBeCloseTo(83.45);
    expect(parseTimeInput('83')).toBeCloseTo(83);
    expect(parseTimeInput('83.5')).toBeCloseTo(83.5);
    expect(parseTimeInput(' 2:05 ')).toBeCloseTo(125);
  });

  it('rejects invalid input', () => {
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('1:75')).toBeNull(); // 초는 60 미만
    expect(parseTimeInput('-5')).toBeNull();
    expect(parseTimeInput('1:2:3')).toBeNull();
  });

  it('round-trips through formatTimeInput', () => {
    expect(formatTimeInput(83.45)).toBe('01:23.45');
    expect(parseTimeInput(formatTimeInput(207.9))).toBeCloseTo(207.9);
    expect(formatTimeInput(0)).toBe('00:00.00');
    expect(formatTimeInput(null)).toBe('');
    expect(formatTimeInput(-1)).toBe('');
  });
});

describe('groupTripletLines (3줄 모드 스크립트 인식 그룹핑)', () => {
  it('groups JP original + KR pron + KR translation', () => {
    const cues = groupTripletLines(['忘れられぬものだけが', '와스레라레누 모노 다케가', '잊지 못하는 것만이']);
    expect(cues).toHaveLength(1);
    expect(cues[0].original).toBe('忘れられぬものだけが');
    expect(cues[0].pronunciation).toBe('와스레라레누 모노 다케가');
    expect(cues[0].translation).toBe('잊지 못하는 것만이');
  });

  it('does not shift when an English one-line section is mixed in', () => {
    const cues = groupTripletLines([
      '忘れられぬ', '와스레라레누', '잊지 못하는',
      "I'm still standing here",
      '二行目', '니교메', '두번째 줄',
    ]);
    expect(cues).toHaveLength(3);
    expect(cues[1].text).toBe("I'm still standing here");
    expect(cues[1].original).toBeUndefined(); // 일반 줄 — 싱크는 text 기준
    expect(cues[2].original).toBe('二行目');
    expect(cues[2].pronunciation).toBe('니교메');
  });

  it('supports 2-line groups (no translation)', () => {
    const cues = groupTripletLines(['歌詞', '카시']);
    expect(cues[0].pronunciation).toBe('카시');
    expect(cues[0].translation).toBe('');
  });

  it('isHangulDominant distinguishes scripts', () => {
    expect(isHangulDominant('와스레라레누 모노')).toBe(true);
    expect(isHangulDominant('忘れられぬ')).toBe(false);
    expect(isHangulDominant('English line')).toBe(false);
    expect(isHangulDominant('')).toBe(false);
  });
});
