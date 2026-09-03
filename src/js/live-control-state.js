/**
 * 지연되거나 순서가 뒤바뀔 수 있는 오디오 명령을 UI와 안전하게 연결한다.
 * 입력은 즉시 화면에 반영하고, 최신 요청만 확정/복구 권한을 가진다.
 */
export function createLiveControlChannel({
  initialValue,
  delayMs = 0,
  apply,
  onOptimistic = () => {},
  onConfirmed = () => {},
  onRollback = () => {},
}) {
  let confirmedValue = initialValue;
  let pendingValue = null;
  let requestSequence = 0;
  let error = null;
  let timer = null;
  let disposed = false;

  const snapshot = () => ({ confirmedValue, pendingValue, requestSequence, error });

  const commit = async (sequence, value) => {
    if (disposed) return snapshot();
    try {
      await apply(value);
      if (disposed || sequence !== requestSequence) return snapshot();
      confirmedValue = value;
      pendingValue = null;
      error = null;
      onConfirmed(value, snapshot());
    } catch (reason) {
      if (disposed || sequence !== requestSequence) return snapshot();
      pendingValue = null;
      error = reason;
      onRollback(confirmedValue, reason, snapshot());
    }
    return snapshot();
  };

  const schedule = (sequence, value, flush) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (flush || delayMs <= 0) return commit(sequence, value);
    timer = setTimeout(() => {
      timer = null;
      commit(sequence, value);
    }, delayMs);
    return Promise.resolve(snapshot());
  };

  return {
    set(value, { flush = false } = {}) {
      if (disposed) return Promise.resolve(snapshot());
      pendingValue = value;
      error = null;
      const sequence = ++requestSequence;
      onOptimistic(value, snapshot());
      return schedule(sequence, value, flush);
    },
    flush() {
      if (pendingValue == null || disposed) return Promise.resolve(snapshot());
      const value = pendingValue;
      const sequence = requestSequence;
      if (timer) clearTimeout(timer);
      timer = null;
      return commit(sequence, value);
    },
    sync(value) {
      if (timer) clearTimeout(timer);
      timer = null;
      requestSequence++;
      confirmedValue = value;
      pendingValue = null;
      error = null;
      onConfirmed(value, snapshot());
      return snapshot();
    },
    get value() { return pendingValue ?? confirmedValue; },
    get state() { return snapshot(); },
    dispose() {
      disposed = true;
      requestSequence++;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

