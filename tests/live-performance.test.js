import { lineProgress } from '../src/js/alignment-metadata.js';
import { describe, expect, it } from 'vitest';
import { appendLiveHistory, buildPerformerLyricModel, findUpcomingIndex, getLiveKeyBpm, getLiveSectionState, isMrReady, moveQueueItem, nextLiveQueuePath, resolveNextLiveQueuePath, takePreviousLivePath, resolveLineWindow } from '../src/js/live-performance.js';

describe('live performer timing model', () => {
  const lyrics = [
    { text: '첫 줄', start: 10, end: 15 },
    { text: '다음 줄', start: 15, end: 20 },
  ];

  it('provides current/next lyrics, countdown and line progress', () => {
    const model = buildPerformerLyricModel(lyrics, 0, 12, {});
    expect(model.current.text).toBe('첫 줄');
    expect(model.next.text).toBe('다음 줄');
    expect(model.nextInSec).toBe(3);
    expect(model.progress).toBeCloseTo(0.4);
  });

  it('distinguishes intro, interlude and vocal countdown', () => {
    const markers = { vocalStartSec: 20, interludes: [{ start: 5, end: 12 }, { start: 40, end: 50 }] };
    expect(getLiveSectionState(8, markers)).toMatchObject({ kind: 'intro', label: '전주', remainingSec: 4 });
    expect(getLiveSectionState(16, markers)).toMatchObject({ kind: 'vocal-countdown', remainingSec: 4 });
    expect(getLiveSectionState(45, markers)).toMatchObject({ kind: 'interlude', label: '간주', remainingSec: 5 });
  });

  it('reports unsynced lyrics instead of inventing timing', () => {
    expect(buildPerformerLyricModel([{ text: '미싱크', start: 0, end: 0 }], -1, 2, {}).hasSyncedLyrics).toBe(false);
  });
});

describe('live playlist helpers', () => {
  it('moves queue items without changing the persisted shape', () => {
    expect(moveQueueItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('uses the item after current, or the first item for an external current track', () => {
    expect(nextLiveQueuePath(['a', 'b', 'c'], 'b')).toBe('c');
    expect(nextLiveQueuePath(['a', 'b', 'c'], 'c')).toBe('a');
    expect(nextLiveQueuePath(['a', 'b'], 'outside')).toBe('a');
    expect(nextLiveQueuePath(['a'], 'a')).toBeNull();
  });

  it('skips missing library paths and reports them for cleanup', () => {
    expect(resolveNextLiveQueuePath(['a', 'missing', 'b'], 'a', new Set(['a', 'b'])))
      .toEqual({ path: 'b', stalePaths: ['missing'] });
  });

  it('records and consumes session playback history without stale tracks', () => {
    const history = appendLiveHistory([], 'a', 'b');
    const result = takePreviousLivePath([...history, 'missing'], new Set(['a', 'b']));
    expect(result).toEqual({ path: 'a', history: [] });
  });
});

describe('MR 준비 판정', () => {
  // 라이브 큐가 hasMr/mrReady만 보던 시절, 분리가 끝난 곡이 "원곡"으로 찍혔다.
  it('저장 경로마다 다른 필드 이름을 모두 인정한다', () => {
    for (const song of [
      { isSeparated: true }, { is_separated: true },
      { isMr: true }, { is_mr: true },
      { mr_path: 'C:/mr/a.wav' }, { hasMr: true }, { has_mr: true }, { mrReady: true },
    ]) expect(isMrReady(song)).toBe(true);
  });

  it('분리 전 곡과 빈 값은 준비되지 않은 것으로 본다', () => {
    expect(isMrReady({ isSeparated: false, mr_path: '' })).toBe(false);
    expect(isMrReady({})).toBe(false);
    expect(isMrReady(null)).toBe(false);
    expect(isMrReady(undefined)).toBe(false);
  });
});

describe('라이브 헤더 KEY/BPM', () => {
  it('서로 다른 저장 필드와 소수 BPM을 표시용 값으로 정리한다', () => {
    expect(getLiveKeyBpm({ song_key: ' F# minor ', bpm: 127.6 }))
      .toEqual({ key: 'F# minor', bpm: 128 });
    expect(getLiveKeyBpm({ key: 'C', bpm: '95' }))
      .toEqual({ key: 'C', bpm: 95 });
  });

  it('값이 없거나 유효 범위를 벗어나면 표시하지 않는다', () => {
    expect(getLiveKeyBpm({ songKey: ' ', bpm: 0 })).toEqual({ key: null, bpm: null });
    expect(getLiveKeyBpm(null)).toEqual({ key: null, bpm: null });
  });
});

describe('가사 진행도 · 리드인', () => {
  const segs = [
    { text: '1번째 줄', start: 10, end: 12 },
    { text: '2번째 줄', start: 16, end: 18 },
    { text: '3번째 줄', start: 22, end: 24 },
  ];

  // 줄 사이 간주에서 lyric-drawer는 index로 -1을 준다. 예전에는 list[index+1]이
  // list[0]으로 떨어져 곡 첫 줄이 계속 "다음 가사"로 떠 있었다.
  it('간주 중에는 실제로 다가오는 줄을 잡는다', () => {
    const m = buildPerformerLyricModel(segs, -1, 20, {});
    expect(m.current.text).toBe('3번째 줄');
    expect(m.pending).toBe(true);
    expect(m.startsInSec).toBe(2);
    expect(m.next).toBeNull();
  });

  it('부르기 전에는 줄을 미리 띄우되 진행도는 0으로 둔다', () => {
    const pre = buildPerformerLyricModel(segs, -1, 15, {});
    expect(pre.current.text).toBe('2번째 줄');
    expect(pre.next.text).toBe('3번째 줄');
    expect(pre.progress).toBe(0);
  });

  it('시작 시각을 지나면 그 자리에서 바로 쓸어내기 시작한다', () => {
    expect(buildPerformerLyricModel(segs, 1, 16, {}).progress).toBe(0);
    expect(buildPerformerLyricModel(segs, 1, 17, {}).progress).toBeCloseTo(0.5);
    // 종료 경계부터는 이미 부른 줄 대신 다음 줄을 0%로 미리 올린다.
    expect(buildPerformerLyricModel(segs, 1, 17.999, {}).progress).toBeCloseTo(1, 2);
    expect(buildPerformerLyricModel(segs, 1, 18, {}).progress).toBe(0);
    expect(buildPerformerLyricModel(segs, 1, 18, {}).current.text).toBe('3번째 줄');
    expect(buildPerformerLyricModel(segs, 1, 17, {}).pending).toBe(false);
  });

  // 0은 앱 전체가 "미지정" 센티널로 쓰는 값인데 validTime이 유한값이라 통과시켜
  // `?? 다음 줄 시작` 폴백이 죽어 있었다 — LRC 가사는 진행도가 0%에 멈췄다.
  it('끝 시각이 없으면 다음 줄 시작까지로 채운다', () => {
    const lrc = [{ text: '첫 줄', start: 10, end: 0 }, { text: '둘째 줄', start: 16, end: 0 }];
    expect(buildPerformerLyricModel(lrc, 0, 13, {}).progress).toBeCloseTo(0.5);
    expect(buildPerformerLyricModel(lrc, 0, 15.999, {}).progress).toBeCloseTo(1, 2);
    expect(buildPerformerLyricModel(lrc, 0, 16, {}).current.text).toBe('둘째 줄');
    expect(buildPerformerLyricModel(lrc, 0, 16, {}).progress).toBe(0);
  });

  it('뒤에 긴 간주가 붙어도 쓸어내기가 기어가지 않는다', () => {
    const long = [{ text: '마지막 줄', start: 10, end: 0 }, { text: '후렴', start: 45, end: 0 }];
    // 35초에 걸쳐 기어가는 대신 상한(10초) 안에서 끝난다.
    expect(buildPerformerLyricModel(long, 0, 20, {}).progress).toBe(1);
    expect(buildPerformerLyricModel(long, 0, 15, {}).progress).toBeCloseTo(0.5);
  });
});

describe('다음 줄 찾기 (라이브 화면·OBS 오버레이 공용)', () => {
  const segs = [
    { text: '1절 첫줄', start: 10, end: 14 },
    { text: '1절 둘째줄', start: 16, end: 20 },
    { text: '후렴', start: 30, end: 34 },
  ];

  // 두 화면이 각자 계산하다가 둘 다 lyrics[0]을 집었다 — 줄 사이 간주마다
  // 곡의 첫 줄이 "다음 가사"로 떠 있었다.
  it('줄 사이에서는 이미 지나간 줄이 아니라 다가오는 줄을 집는다', () => {
    expect(findUpcomingIndex(segs, 15)).toBe(1);   // 첫 줄과 둘째 줄 사이
    expect(findUpcomingIndex(segs, 22)).toBe(2);   // 둘째 줄 뒤 긴 간주
    expect(findUpcomingIndex(segs, 25)).toBe(2);
  });

  it('첫 줄 전에는 첫 줄을, 마지막 줄 뒤에는 아무것도 집지 않는다', () => {
    expect(findUpcomingIndex(segs, 0)).toBe(0);
    expect(findUpcomingIndex(segs, 36)).toBe(-1);
  });

  it('시각이 없는 줄(start 0)은 후보로 보지 않는다', () => {
    expect(findUpcomingIndex([{ text: '미싱크', start: 0, end: 0 }], 5)).toBe(-1);
    expect(findUpcomingIndex([], 5)).toBe(-1);
    expect(findUpcomingIndex(null, 5)).toBe(-1);
  });
});

describe('끝난 가사 대신 다음 가사를 메인에 미리 보여 준다', () => {
  const segs = [
    { text: '첫 줄', start: 10, end: 14 },
    { text: '둘째 줄', start: 16, end: 20 },
    { text: '후렴', start: 30, end: 34 },
  ];

  it('줄이 끝난 직후 다음 줄을 0% 상태로 올린다', () => {
    const m = buildPerformerLyricModel(segs, -1, 14.5, {});
    expect(m.current.text).toBe('둘째 줄');
    expect(m.displayIndex).toBe(1);
    expect(m.pending).toBe(true);
    expect(m.startsInSec).toBe(1.5);
    expect(m.progress).toBe(0);
  });

  it('긴 간주에서도 앞으로 부를 가사를 계속 보여 준다', () => {
    // 둘째 줄은 20초에 끝나고 후렴은 30초에 시작한다.
    for (const t of [21, 24, 25.9]) {
      const m = buildPerformerLyricModel(segs, -1, t, {});
      expect(m.current.text).toBe('후렴');
      expect(m.pending).toBe(true);
      expect(m.progress).toBe(0);
    }
  });

  it('다음 줄 시작 전에는 남은 시간을 알린다', () => {
    const 직전 = buildPerformerLyricModel(segs, -1, 27, {});
    expect(직전.current.text).toBe('후렴');
    expect(직전.pending).toBe(true);
  });

  it('마지막 줄이 끝나도 그 줄이 남는다', () => {
    const m = buildPerformerLyricModel(segs, -1, 40, {});
    expect(m.current.text).toBe('후렴');
    expect(m.pending).toBe(false);
  });

  it('곡 첫 줄 전에는 붙들 것이 없으니 첫 줄을 미리 보여 준다', () => {
    const m = buildPerformerLyricModel(segs, -1, 8, {});
    expect(m.current.text).toBe('첫 줄');
    expect(m.pending).toBe(true);
  });
});

describe('진행도 — 단어 타임을 쓴다 (계산이 한 곳)', () => {
  const M = { vocalStartSec: null, interludes: [] };
  const withWords = [{
    start: 10, end: 12, text: '아침 햇살',
    words: [
      { word: '아침', startMs: 10000, endMs: 10600 },
      { word: '햇살', startMs: 11400, endMs: 12000 },
    ],
  }];
  const at = (sec) => buildPerformerLyricModel(withWords, 0, sec, M).progress;

  it('선형이 아니라 실제 발음 시점을 따른다', () => {
    // 선형이라면 10.3초는 (10.3-10)/(12-10) = 0.15.
    // 단어 기반이면 첫 단어(10.0~10.6)의 절반 = 전체의 0.25.
    expect(at(10.3)).toBeCloseTo(0.25, 3);
    expect(at(10.3)).not.toBeCloseTo(0.15, 3);
  });

  it('단어 사이 빈 구간에서는 멈춘다', () => {
    expect(at(10.6)).toBeCloseTo(0.5, 3);
    expect(at(11.0)).toBeCloseTo(0.5, 3);
    expect(at(11.3)).toBeCloseTo(0.5, 3);
  });

  it('둘째 단어에서 다시 찬다', () => {
    expect(at(11.7)).toBeCloseTo(0.75, 3);
    expect(at(12.0)).toBe(1);
  });

  it('단어 타임이 없으면 줄 단위 선형으로 물러난다', () => {
    const noWords = [{ start: 5, end: 9, text: 'x' }];
    expect(buildPerformerLyricModel(noWords, 0, 6, M).progress).toBeCloseTo(0.25, 3);
    expect(buildPerformerLyricModel(noWords, 0, 7, M).progress).toBeCloseTo(0.5, 3);
  });

  it('시작 0초는 여전히 "아직 안 정해짐" 센티널이다', () => {
    // 이 규칙을 깨면 미싱크 줄이 진행도를 그리기 시작한다.
    expect(buildPerformerLyricModel([{ start: 0, end: 4, text: 'x' }], 0, 2, M).progress).toBe(0);
  });
});

describe('resolveLineWindow — 두 화면이 같은 구간을 쓴다', () => {
  it('끝 시각이 있으면 그대로', () => {
    expect(resolveLineWindow({ start: 10, end: 12 }, { start: 12 }))
      .toEqual({ startSec: 10, endSec: 12 });
  });

  it('AI 줄은 다음 가사 시작이 아니라 CTC 끝과 끝음 연장을 사용한다', () => {
    expect(resolveLineWindow({
      start: 10, end: 14, ctcEnd: 11.8, tailExtensionMs: 300, approx: true,
    }, { start: 14 })).toEqual({ startSec: 10, endSec: 12.1 });
  });

  it('끝 시각이 없으면 다음 줄 시작까지', () => {
    // LRC로 가져온 가사는 끝 시각이 없는 게 흔하다. 예전에는 오버레이가
    // end=0을 그대로 받아 진행도를 아예 안 그렸다.
    expect(resolveLineWindow({ start: 10, end: 0 }, { start: 13 }))
      .toEqual({ startSec: 10, endSec: 13 });
  });

  it('간격이 너무 길면 상한을 쓴다', () => {
    // 마지막 줄·간주 앞 줄은 다음 줄까지 수십 초라, 그대로 두면 진행도가
    // 기어가듯 움직인다.
    expect(resolveLineWindow({ start: 10, end: 0 }, { start: 90 }))
      .toEqual({ startSec: 10, endSec: 20 });
    expect(resolveLineWindow({ start: 10, end: 90 }, null))
      .toEqual({ startSec: 10, endSec: 20 });
  });

  it('다음 줄이 없고 끝도 없으면 끝을 정하지 않는다', () => {
    expect(resolveLineWindow({ start: 10, end: 0 }, null))
      .toEqual({ startSec: 10, endSec: null });
  });

  it('시작 0초는 "아직 안 정해짐"이라 값으로 치지 않는다', () => {
    expect(resolveLineWindow({ start: 0, end: 4 }, null).startSec).toBeNull();
  });

  it('buildPerformerLyricModel과 같은 구간을 낸다', () => {
    // 모델이 안에서 쓰는 구간과 오버레이로 보내는 구간이 갈리면, 같은 줄인데
    // 두 화면의 채워진 정도가 달라진다.
    const M = { vocalStartSec: null, interludes: [] };
    const list = [{ start: 10, end: 0, text: 'a' }, { start: 90, text: 'b' }];
    const win = resolveLineWindow(list[0], list[1]);
    const model = buildPerformerLyricModel(list, 0, 15, M);
    // 구간이 10~20이면 15초는 정확히 절반이다.
    expect(win).toEqual({ startSec: 10, endSec: 20 });
    expect(model.progress).toBeCloseTo(0.5, 3);
  });
});

describe('진행도는 오버레이로 보낸 값 하나만 쓴다', () => {
  // 예전에는 라이브가 buildPerformerLyricModel로 진행도를 따로 냈다. 노래하는
  // 동안은 같았지만, 그 모델은 공연자용 규칙(다음 줄 미리 보기·끝난 줄 잠깐
  // 붙들기)이라 줄 사이 구간에서 오버레이와 달랐다 — 끝난 줄이 100%로 남았다.
  const M = { vocalStartSec: null, interludes: [] };
  const list = [
    { start: 10, end: 13, text: 'a' },
    { start: 14, end: 17, text: 'b' },
  ];

  it('줄이 끝난 뒤 모델은 다음 줄을 0%로 미리 보여준다', () => {
    const m = buildPerformerLyricModel(list, -1, 13.4, M);
    expect(m.current?.text).toBe('b');
    expect(m.pending).toBe(true);
    expect(m.progress).toBe(0);
  });

  it('오버레이가 쓰는 구간 계산은 그 구간 밖에서 0이다', () => {
    // 라이브도 이제 이 값을 쓴다 — 그래서 둘이 같아진다.
    const win = resolveLineWindow(list[0], list[1]);
    expect(lineProgress({ start: win.startSec, end: win.endSec }, 13400)).toBe(1);
    // 다만 그 줄이 '현재 줄'이 아니게 되면 라이브는 아예 0을 쓴다(win.index 불일치).
    // 그 판정은 live-screen.js가 하고, 여기서는 계산이 같다는 것만 확인한다.
    expect(lineProgress({ start: win.startSec, end: win.endSec }, 11500)).toBeCloseTo(0.5, 3);
  });
});
