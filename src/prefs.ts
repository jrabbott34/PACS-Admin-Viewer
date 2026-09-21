/**
 * Toolbar preferences: which tool buttons the user has chosen to hide, to declutter a
 * toolbar for a workflow that never touches Probe, Magnify, etc. Purely cosmetic — this
 * only ever changes which buttons render, never what's possible or permitted, and it's
 * never meant to gate anything: a static browser page has no way to actually enforce a
 * restriction (anyone can reopen devtools and flip it back), so this stays a personal
 * customization layer, not access control. Stored in localStorage, separate from the
 * IndexedDB image library in persist.ts — this is UI preference, not patient data.
 */
const KEY = 'pacs-viewer:hidden-tools';

export function loadHiddenTools(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveHiddenTools(hidden: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    // Best-effort — private browsing / quota / disabled storage just means the
    // preference doesn't stick, not that anything breaks.
  }
}
