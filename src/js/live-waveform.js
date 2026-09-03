/** Path-keyed waveform cache. A load already in progress is shared by the live
 * screen and the one-track look-ahead prefetch. */
export function createWaveformRepository(loadSummary, { maxEntries = 8 } = {}) {
  const cache = new Map();
  const inflight = new Map();

  function remember(path, summary) {
    cache.delete(path);
    cache.set(path, summary);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return summary;
  }

  function load(path) {
    if (!path) return Promise.reject(new Error('waveform path is required'));
    if (cache.has(path)) {
      const value = cache.get(path);
      cache.delete(path);
      cache.set(path, value);
      return Promise.resolve(value);
    }
    if (inflight.has(path)) return inflight.get(path);
    const promise = Promise.resolve().then(() => loadSummary(path))
      .then((summary) => remember(path, summary))
      .finally(() => inflight.delete(path));
    inflight.set(path, promise);
    return promise;
  }

  return {
    load,
    prefetch(path) { return path ? load(path).catch(() => null) : Promise.resolve(null); },
    has(path) { return cache.has(path); },
    isLoading(path) { return inflight.has(path); },
  };
}

export function isCurrentWaveformRequest(sequence, currentSequence, path, currentPath) {
  return sequence === currentSequence && path === currentPath;
}
