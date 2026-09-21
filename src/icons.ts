/**
 * Small hand-authored icon set (no CDN — everything stays in the tab).
 * 24x24 viewBox, stroke-based, colored via CSS `color` (stroke="currentColor").
 */
export type IconName =
  | 'menu'
  | 'caret'
  | 'scroll'
  | 'wl'
  | 'pan'
  | 'zoom'
  | 'magnify'
  | 'length'
  | 'angle'
  | 'rectangleroi'
  | 'ellipticalroi'
  | 'probe'
  | 'invert'
  | 'flip-h'
  | 'flip-v'
  | 'rotate'
  | 'reset'
  | 'clear'
  | 'link'
  | 'header'
  | 'import'
  | 'export'
  | 'anonymize'
  | 'sidebar'
  | 'overlay';

const PATHS: Record<IconName, string> = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  caret: '<path d="M6 9l6 6 6-6"/>',
  scroll: '<path d="M7 8l5-5 5 5M7 16l5 5 5-5"/>',
  wl: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  pan: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
  zoom: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/>',
  magnify: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/><path d="M10 7v6M7 10h6"/>',
  length: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none"/>',
  angle: '<path d="M5 19L12 5L19 19"/><path d="M10.3 9.8l1.7-1.9 1.7 1.9"/>',
  rectangleroi: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  ellipticalroi: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  probe: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  invert: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 000 18z" fill="currentColor" stroke="none"/>',
  'flip-h': '<path d="M12 3v18" stroke-dasharray="3 3"/><path d="M8 9L4 12l4 3M16 9l4 3-4 3"/>',
  'flip-v': '<path d="M3 12h18" stroke-dasharray="3 3"/><path d="M9 8L12 4l3 4M9 16l3 4 3-4"/>',
  rotate: '<path d="M21 12a9 9 0 10-3.5 7.1"/><path d="M21 5v6h-6"/>',
  reset: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  clear: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  link: '<rect x="3" y="9" width="10" height="6" rx="3" transform="rotate(-45 8 12)"/><rect x="11" y="9" width="10" height="6" rx="3" transform="rotate(-45 16 12)"/>',
  header: '<path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 12h6M9 16h6"/>',
  import: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"/>',
  anonymize:
    '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.4 9.4 0 0112 5c5 0 8.5 4 9.9 7a15 15 0 01-3 4M6.2 6.2A15 15 0 002.1 12c1 2 3 4.4 5.7 5.8M9.9 9.9a3 3 0 004.2 4.2"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  overlay:
    '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/>',
};

export function icon(name: IconName, size = 18): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** A small grid-pattern icon matching an actual rows x cols layout. */
export function layoutIcon(rows: number, cols: number, size = 18): string {
  const pad = 3;
  const gap = 2;
  const w = (24 - 2 * pad - (cols - 1) * gap) / cols;
  const h = (24 - 2 * pad - (rows - 1) * gap) / rows;
  let rects = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (pad + c * (w + gap)).toFixed(1);
      const y = (pad + r * (h + gap)).toFixed(1);
      rects += `<rect x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.2"/>`;
    }
  }
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${rects}</svg>`;
}

/** Fills every `[data-icon]` placeholder found under root with its icon markup. */
export function fillIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon as IconName;
    if (name in PATHS) el.innerHTML = icon(name, el.dataset.iconSize ? Number(el.dataset.iconSize) : 18);
  }
}
