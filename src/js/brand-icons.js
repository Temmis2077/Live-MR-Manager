/** Red Orbit icon primitives. All icons share a 24px grid and 1.8px stroke. */
const PATHS = {
  folder: '<path d="M3.5 6.5h6l2 2h9v10.5a2 2 0 0 1-2 2h-15z"/><path d="M3.5 9h17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/><path d="M8 10.5h5"/>',
  list: '<path d="M7 5h13M7 12h13M7 19h13"/><path d="M3.5 5h.01M3.5 12h.01M3.5 19h.01"/>',
  stems: '<path d="M5 4v16M12 7v10M19 2v20"/><circle cx="5" cy="9" r="2"/><circle cx="12" cy="13" r="2"/><circle cx="19" cy="7" r="2"/>',
  bolt: '<path d="m13 2-8 12h7l-1 8 8-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lyrics: '<path d="M5 5h14v10H9l-4 4z"/><path d="M8 9h8M8 12h6"/>',
  live: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/>',
  keys: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h8"/>',
  orbit: '<circle cx="12" cy="12" r="4.5"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-16 12 12)"/><circle cx="20" cy="10" r="1"/>',
  warning: '<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17.5h.01"/>',
  sparkle: '<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>',
  play: '<path d="m8.5 5.5 10 6.5-10 6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  previous: '<path d="M6 5v14M18 6l-8 6 8 6z"/>',
  next: '<path d="M18 5v14M6 6l8 6-8 6z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  drag: '<path d="M8 7h.01M16 7h.01M8 12h.01M16 12h.01M8 17h.01M16 17h.01"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
};

export function brandIcon(name, className = '') {
  const path = PATHS[name] || PATHS.orbit;
  return `<span class="osw-icon ${className}" aria-hidden="true"><svg viewBox="0 0 24 24">${path}</svg></span>`;
}
