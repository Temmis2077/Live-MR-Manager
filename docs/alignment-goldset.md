# 가사 정렬 골드셋

이 디렉터리는 정렬 변경의 회귀와 품질을 측정하는 수동 기준 데이터의 규약이다. 오디오와 실제 가사는 저작권·용량 문제로 저장소에 넣지 않고, 로컬 경로로 참조한다.

아래 형식으로 로컬 `manifest.local.json`을 만들고, 각 항목에 원문 LRC와 분리 보컬 경로, 수동 확정한 줄 시작 시각을 기록한다. `segmentIndex`는 LRC의 원래 배열 인덱스이며, 정렬이 이 값이나 원문 순서를 바꾸면 실패다.

```json
{
  "version": 1,
  "tracks": [{
    "id": "mixed-song-01",
    "category": ["korean", "english-mixed", "long-instrumental"],
    "audioPath": "C:/path/to/separated/vocals.wav",
    "lrcPath": "C:/path/to/lyrics.lrc",
    "referenceStarts": [{ "segmentIndex": 0, "startMs": 12450 }]
  }]
}
```

처음에는 다음을 합쳐 10곡을 구성한다.

- 한국어, 영어, 한영 혼합
- 랩, 반복 후렴, 긴 간주
- 리버브·코러스, 저품질 보컬

각 실행에는 모델 모드, 입력 LRC의 해시, 결과와 아래 지표를 함께 남긴다.

- 확정 줄의 중앙/90백분위 시작 시각 오차
- 미싱크율과 잘못된 채택률
- 중복 병합률, 역순 배치율
- 원문 변경과 블록 재배치 건수

초기 합격 기준은 기존 기준선보다 중앙 시작 오차 25% 이상 감소, 심각 실패 50% 이상 감소, 원문 변경·재배치 0건이다. 기준선이 확보되기 전에는 절대 confidence 임계값을 상향하지 않는다.
