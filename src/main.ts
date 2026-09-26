import './style.css';
import { utilities as csUtils } from '@cornerstonejs/core';
import { initCornerstone } from './cs';
import { anonymizeSeriesAndExport, exportCellImage, exportSeriesDicomZip } from './export';
import { createFlyout } from './flyout';
import { HeaderPanel } from './header';
import { fillIcons, icon, layoutIcon } from './icons';
import {
  entriesFromDataTransfer,
  filesFromEntries,
  findInstanceByImageId,
  ingest,
  library,
  orderedSeries,
  refreshSeriesSummary,
  resolveInstanceBlob,
  sopsForStudy,
} from './ingest';
import { LAYOUT_PRESETS, LayoutManager, type PrimaryTool } from './layout';
import { clearLibrary, deleteBlobs, loadAllBlobs, requestPersistence, saveBlob } from './persist';
import { CT_PRESETS } from './presets';
import { loadHiddenTools, saveHiddenTools } from './prefs';
import { initHostBridge } from './host-bridge';
import type { IngestReport, Series } from './types';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const splashEl = $('#splash');
const splashStatusEl = $('#splash-status');
const splashOpenBtn = $<HTMLButtonElement>('#splash-open');

const gridEl = $<HTMLDivElement>('#viewport-grid');
const seriesPanelEl = $('#series');
const seriesEl = $('#series-list');
const seriesResizeEl = $('#series-resize');
const toggleSeriesBtn = $<HTMLButtonElement>('#btn-toggle-series');
const statusEl = $('#status');
const emptyEl = $('#empty');
const dropVeil = $('#dropveil');
const presetEl = $<HTMLSelectElement>('#preset');
const wwEl = $<HTMLInputElement>('#ww');
const wcEl = $<HTMLInputElement>('#wc');
const headerBtn = $<HTMLButtonElement>('#btn-header');
const fileInput = $<HTMLInputElement>('#file-input');
const folderInput = $<HTMLInputElement>('#folder-input');
const linkScrollBtn = $<HTMLButtonElement>('#btn-link-scroll');
const toggleOverlaysBtn = $<HTMLButtonElement>('#btn-toggle-overlays');
const cineBtn = $<HTMLButtonElement>('#btn-cine');
const cineIconEl = $('#btn-cine [data-icon]');
const cineFpsEl = $<HTMLSelectElement>('#cine-fps');
const layoutPanelEl = $('#layout-panel');
const layoutTriggerIconEl = $('#layout-trigger-icon');
const layoutTriggerLabelEl = $('#layout-trigger-label');
const prefsTriggerBtn = $<HTMLButtonElement>('#prefs-trigger');
const prefsPanelEl = $('#prefs-panel');

/**
 * Length, Rectangle ROI and Probe all use the same "drag from one corner/point to
 * another" gesture, so they're self-explanatory. Ellipse and Angle don't — Ellipse
 * is drawn from its center outward (not corner-to-corner, unlike Rectangle right
 * next to it), and Angle needs a second click after the first drag to place its
 * second ray. Surfaced as a status-bar hint on selection, since a toolbar tooltip
 * requires hovering the button, which a user who already moved to the image won't
 * see.
 */
const TOOL_HINTS: Partial<Record<PrimaryTool, string>> = {
  ellipticalroi: 'Ellipse ROI: click the center of the area, then drag outward.',
  angle: 'Angle: drag to draw the first line, then click again to place the second.',
  label: 'Label: drag from the point to where the text should sit, then type the label.',
};

let layout: LayoutManager;
let header: HeaderPanel;
let lastPresetSeries: Series | null = null;
const thumbQueue: (() => Promise<void>)[] = [];
let thumbRunning = false;

function setStatus(msg: string, title = ''): void {
  statusEl.textContent = msg;
  statusEl.title = title;
  if (!splashEl.classList.contains('hide')) splashStatusEl.textContent = msg;
}

/** Reveal the "Open Viewer" button once the app is ready — the splash stays up until clicked. */
function revealSplashOpen(): void {
  splashOpenBtn.hidden = false;
  splashOpenBtn.addEventListener('click', hideSplash, { once: true });
}

function hideSplash(): void {
  splashEl.classList.add('hide');
  setTimeout(() => splashEl.remove(), 400);
}

/**
 * Cine is per-cell (see gotcha in CLAUDE.md): the Play/Pause button and Space only ever
 * act on layout.activeCell, so a cell started playing and then left behind by clicking
 * onto a different cell has no way back to it short of reselecting that exact cell. Esc
 * is the unconditional panic button — every visible cell's cine, active or not.
 */
function stopAllCine(): void {
  for (const { cell } of layout.visibleEntries()) cell.pause();
}

// ---------- overlays (one set of four corners per visible cell) ----------
function refreshOverlays(): void {
  for (const { cell, overlay } of layout.visibleEntries()) {
    const s = cell.series;
    const set = (cls: 'tl' | 'tr' | 'bl' | 'br', lines: (string | false | undefined)[]) => {
      overlay[cls].textContent = lines.filter(Boolean).join('\n');
    };
    if (!s) {
      set('tl', []);
      set('tr', []);
      set('bl', []);
      set('br', []);
      continue;
    }
    const st = cell.state;
    const inst = s.instances[st.index];
    const imported = s.kind !== 'dicom';
    set('tl', [
      imported ? s.seriesDescription : s.patientName,
      !imported && s.patientId,
      s.studyDate,
      !imported && s.studyDescription,
    ]);
    set('tr', [
      !imported && s.seriesDescription,
      !imported && s.institution,
      imported && (s.kind === 'pdf' ? 'PDF' : 'Image'),
    ]);
    set('bl', [
      `${s.kind === 'pdf' ? 'Page' : 'Image'} ${st.index + 1} / ${st.total}`,
      inst?.sliceLocation !== undefined && `Loc ${inst.sliceLocation.toFixed(1)} mm`,
      inst?.thickness !== undefined && `Thk ${inst.thickness.toFixed(1)} mm`,
    ]);
    set('br', [
      !s.isColor && st.windowWidth !== undefined && `W ${Math.round(st.windowWidth)}  L ${Math.round(st.windowCenter!)}`,
      `Zoom ${st.zoom.toFixed(2)}×`,
      st.invert && 'Inverted',
      st.playing && '▶ Playing (Esc to stop all)',
    ]);
  }
}

// ---------- toolbar state ----------
function refreshToolbar(): void {
  const activeSeries = layout.activeCell.series;
  if (activeSeries !== lastPresetSeries) {
    fillPresets(activeSeries);
    lastPresetSeries = activeSeries;
  }
  const st = layout.activeCell.state;
  const color = !!activeSeries?.isColor;
  const none = !activeSeries;
  wwEl.disabled = wcEl.disabled = presetEl.disabled = color || none;
  const btnResetAll = $('#btn-reset-all') as HTMLButtonElement;
  const anyLoaded = layout.visibleEntries().some((e) => e.cell.series);
  btnResetAll.disabled = !anyLoaded;
  btnResetAll.title = anyLoaded
    ? 'Reset window/level, zoom, pan, flip and rotation for every viewport in this layout'
    : 'Open a series first';
  $('#btn-invert').setAttribute('aria-pressed', String(st.invert));
  $('#btn-flip-h').setAttribute('aria-pressed', String(st.flipH));
  $('#btn-flip-v').setAttribute('aria-pressed', String(st.flipV));
  linkScrollBtn.setAttribute('aria-pressed', String(layout.linkScroll));

  const canPlay = !!activeSeries && activeSeries.instances.length > 1;
  cineBtn.disabled = !canPlay;
  cineFpsEl.disabled = !canPlay;
  cineBtn.setAttribute('aria-pressed', String(st.playing));
  cineBtn.title = !canPlay
    ? 'Cine needs a series with more than one image'
    : st.playing
      ? 'Pause (Space) — active cell'
      : 'Play (Space) — active cell';
  cineIconEl.innerHTML = icon(st.playing ? 'pause' : 'play', 18);

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    const on = b.dataset.tool === layout.primaryTool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }

  layoutTriggerIconEl.innerHTML = layoutIcon(layout.layoutRows, layout.layoutCols);
  layoutTriggerLabelEl.textContent = `${layout.layoutRows} × ${layout.layoutCols}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
    const [r, c] = b.dataset.layout!.split('x').map(Number);
    b.setAttribute('aria-checked', String(r === layout.layoutRows && c === layout.layoutCols));
  }
  for (const id of [
    '#btn-invert',
    '#btn-flip-h',
    '#btn-flip-v',
    '#btn-rotate',
    '#btn-reset',
    '#btn-clear-meas',
    '#menu-export-png',
    '#menu-export-jpg',
    '#menu-export-dicom',
    '#menu-anonymize',
  ]) {
    const b = $(id) as HTMLButtonElement;
    b.disabled = none;
    b.title = none ? 'Open a series first' : '';
  }
  if (!color && st.windowWidth !== undefined) {
    if (document.activeElement !== wwEl) wwEl.value = String(Math.round(st.windowWidth));
    if (document.activeElement !== wcEl) wcEl.value = String(Math.round(st.windowCenter!));
    syncPresetSelection(st.windowWidth, st.windowCenter!);
  } else if (color || none) {
    wwEl.value = wcEl.value = '';
  }
}

function fillPresets(series: Series | null): void {
  presetEl.replaceChildren();
  const add = (value: string, label: string) => presetEl.append(new Option(label, value));
  add('custom', 'Custom');
  add('default', 'Default');
  add('auto', 'Full range');
  if (series?.modality === 'CT') {
    CT_PRESETS.forEach((p, i) => add(`ct:${i}`, `${p.label} (${p.width}/${p.center})`));
  }
  presetEl.value = 'default';
}

function syncPresetSelection(w: number, c: number): void {
  // If the window no longer matches the selected CT preset, fall back to "Custom".
  const v = presetEl.value;
  if (v.startsWith('ct:')) {
    const p = CT_PRESETS[Number(v.slice(3))];
    if (Math.round(w) !== p.width || Math.round(c) !== p.center) presetEl.value = 'custom';
  }
}

// ---------- series list ----------
function renderSeriesList(): void {
  const list = orderedSeries();
  seriesEl.replaceChildren();
  if (!list.length) return;
  let lastStudy = '';
  for (const s of list) {
    if (s.studyUid !== lastStudy) {
      lastStudy = s.studyUid;
      const h = document.createElement('div');
      h.className = 'study-title';
      const label = document.createElement('span');
      label.textContent = [s.patientName, s.studyDescription, s.studyDate].filter(Boolean).join(' · ') || 'Study';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'study-close';
      close.title = 'Close this study (removes it from your local library)';
      close.setAttribute('aria-label', `Close ${label.textContent}`);
      close.textContent = '×';
      close.addEventListener('click', () => void closeStudy(s.studyUid, label.textContent!));
      h.append(label, close);
      seriesEl.append(h);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'series-item';
    btn.dataset.uid = s.uid;
    btn.draggable = true;
    btn.setAttribute('aria-current', String(s === layout.activeCell.series));
    const fallback = document.createElement('div');
    fallback.className = 'thumb-fallback';
    fallback.textContent = s.modality || '—';
    const text = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${s.seriesNumber !== undefined && s.kind === 'dicom' ? `${s.seriesNumber}: ` : ''}${s.seriesDescription || s.modality || 'Series'}`;
    label.title = label.textContent;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const n = s.instances.length;
    sub.textContent = `${s.kind === 'pdf' ? 'PDF' : s.kind === 'image' ? 'Image' : s.modality || 'Series'} · ${n} ${s.kind === 'pdf' ? 'page' : 'image'}${n === 1 ? '' : 's'}`;
    text.append(label, sub);
    btn.append(fallback, text);
    btn.addEventListener('click', () => void pickSeries(s));
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-series-uid', s.uid);
      e.dataTransfer!.effectAllowed = 'copy';
    });
    seriesEl.append(btn);
    queueThumbnail(s, btn, fallback);
  }
}

function markCurrentSeries(): void {
  const current = layout.activeCell.series;
  for (const b of seriesEl.querySelectorAll<HTMLButtonElement>('.series-item')) {
    b.setAttribute('aria-current', String(b.dataset.uid === current?.uid));
  }
}

const thumbCache = new Map<string, HTMLElement>();

function queueThumbnail(s: Series, btn: HTMLElement, fallback: HTMLElement): void {
  const cached = thumbCache.get(s.uid);
  if (cached) {
    fallback.replaceWith(cached);
    return;
  }
  thumbQueue.push(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 112;
    try {
      const mid = s.instances[Math.floor(s.instances.length / 2)];
      await csUtils.loadImageToCanvas({ canvas, imageId: mid.imageId, thumbnail: true });
      const box = document.createElement('div');
      box.className = 'thumb';
      box.append(canvas);
      thumbCache.set(s.uid, box);
      btn.querySelector('.thumb-fallback')?.replaceWith(box);
    } catch (e) {
      console.warn('thumbnail failed for', s.seriesDescription, e);
    }
  });
  void runThumbs();
}

async function runThumbs(): Promise<void> {
  if (thumbRunning) return;
  thumbRunning = true;
  while (thumbQueue.length) await thumbQueue.shift()!();
  thumbRunning = false;
}

// ---------- opening series into the active cell ----------
async function pickSeries(s: Series, index = 0): Promise<void> {
  await layout.assign(layout.activeIndex, s, index);
  refreshAll();
  setStatus(`${s.seriesDescription || s.modality} — ${s.instances.length} ${s.instances.length === 1 ? 'image' : 'images'}`);
}

function blobForImageId(imageId: string | undefined): Blob | undefined {
  return imageId ? resolveInstanceBlob(imageId) : undefined;
}

let headerTimer = 0;
function refreshHeader(): void {
  if (!header.visible) return;
  window.clearTimeout(headerTimer);
  headerTimer = window.setTimeout(() => {
    const id = layout.activeCell.currentImageId;
    void header.show(blobForImageId(id), id ?? '');
  }, 80);
}

function refreshAll(): void {
  markCurrentSeries();
  refreshOverlays();
  refreshToolbar();
  refreshHeader();
}

// ---------- loading files ----------
interface LoadOptions {
  persist?: boolean;
  label?: string;
  /**
   * Open the loaded series in the active cell even if it already shows something — and if
   * every file was already loaded (re-opening the same study), open the series they belong to.
   */
  open?: boolean;
}

async function loadFiles(files: File[], opts: LoadOptions = {}): Promise<IngestReport | undefined> {
  if (!files.length) return undefined;
  const persist = opts.persist ?? true;
  setStatus(opts.label ?? `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  const report = await ingest(
    files,
    (done, total) => {
      if (done % 8 === 0 || done === total) setStatus(`Reading files… ${done} / ${total}`);
    },
    { persist },
  );
  renderSeriesList();
  if (report.touched.length) emptyEl.hidden = true;

  const parts: string[] = [];
  if (report.instancesAdded) {
    parts.push(`Loaded ${report.instancesAdded} image${report.instancesAdded === 1 ? '' : 's'} in ${report.touched.length} series`);
  }
  if (report.duplicates) parts.push(`${report.duplicates} duplicate${report.duplicates === 1 ? '' : 's'} ignored`);
  if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  const detail = report.skipped
    .slice(0, 12)
    .map((s) => `${s.name}: ${s.reason}`)
    .join('\n');
  setStatus(parts.join(' · ') || 'Nothing to load', detail);

  // Open the first new series into the active cell if it's still empty (or if asked to).
  const target = opts.open
    ? orderedSeries().find((s) => report.touched.includes(s) || report.alreadyLoaded.includes(s))
    : !layout.activeCell.series
      ? orderedSeries().find((s) => report.touched.includes(s))
      : undefined;
  if (target) await pickSeries(target);
  else markCurrentSeries();
  return report;
}

/** Reload everything saved from a previous session (IndexedDB) back into the library. */
async function restoreLibrary(): Promise<void> {
  const saved = await loadAllBlobs();
  if (!saved.length) return;
  const files = saved.map(({ sop, blob }) => new File([blob], `${sop}.dcm`, { type: 'application/dicom' }));
  await loadFiles(files, {
    persist: false,
    label: `Restoring ${saved.length} saved image${saved.length === 1 ? '' : 's'} from your local library…`,
  });
}

/**
 * Permanently delete everything in the local library (IndexedDB), then reload the
 * page — the same clean-slate startup path a fresh launch takes, rather than
 * hand-rolling viewport-clearing logic (Cornerstone's stack API isn't meant to be
 * pointed at an empty array).
 */
async function clearLocalLibrary(): Promise<void> {
  if (!confirm('Delete everything in your local library? This cannot be undone.')) return;
  await clearLibrary();
  location.reload();
}

/**
 * Close one study (all its series) without touching any other study in the local
 * library. Deletes just that study's blobs from IndexedDB, then reloads — the same
 * reload-based clean slate as clearLocalLibrary(), just scoped to fewer SOPs, for the
 * same reason: Cornerstone's StackViewport.setStack() isn't meant to be pointed at an
 * empty array, so there's no safe way to hand-clear a cell that's showing one of the
 * study's series in place. restoreLibrary() re-ingests whatever's left in IndexedDB on
 * the next `main()` run, so every other study reappears exactly as it was; this one
 * just doesn't.
 */
async function closeStudy(studyUid: string, label: string): Promise<void> {
  const sops = sopsForStudy(studyUid);
  if (!sops.length) return;
  if (!confirm(`Close ${label}? It stays out of your local library until you re-import it.`)) return;
  await deleteBlobs(sops);
  location.reload();
}

// ---------- toolbar preferences: hide tools a given workflow never uses ----------
/**
 * Purely cosmetic decluttering, not access control — see prefs.ts. Applies the saved
 * hidden-tools set to both the actual [data-tool] buttons and the preferences panel's
 * own checkboxes (so reopening the panel later reflects what's really hidden), and
 * falls back off a tool that just got hidden while it was the selected primary tool —
 * otherwise the toolbar would show nothing highlighted and clicking the image would
 * silently do nothing until another tool was picked.
 */
function applyToolVisibility(): void {
  const hidden = loadHiddenTools();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.hidden = hidden.has(b.dataset.tool!);
  }
  for (const cb of prefsPanelEl.querySelectorAll<HTMLInputElement>('[data-pref-tool]')) {
    cb.checked = !hidden.has(cb.dataset.prefTool!);
  }
  if (layout && hidden.has(layout.primaryTool)) {
    const fallback = document.querySelector<HTMLButtonElement>('[data-tool]:not([hidden])');
    if (fallback) layout.setPrimaryTool(fallback.dataset.tool as PrimaryTool);
  }
}

function wirePrefsPanel(): void {
  createFlyout(prefsTriggerBtn, prefsPanelEl);
  applyToolVisibility();
  for (const cb of prefsPanelEl.querySelectorAll<HTMLInputElement>('[data-pref-tool]')) {
    cb.addEventListener('change', () => {
      const hidden = loadHiddenTools();
      const tool = cb.dataset.prefTool!;
      if (cb.checked) hidden.delete(tool);
      else hidden.add(tool);
      saveHiddenTools(hidden);
      applyToolVisibility();
    });
  }
}

// ---------- series panel: drag-to-resize, toggle to collapse ----------
const SERIES_MIN_W = 160;
const SERIES_MAX_W = 480;
let seriesWidth = 248;
let seriesCollapsed = false;

function applySeriesPanel(): void {
  document.documentElement.style.setProperty('--series-w', seriesCollapsed ? '0px' : `${seriesWidth}px`);
  seriesPanelEl.classList.toggle('collapsed', seriesCollapsed);
  toggleSeriesBtn.setAttribute('aria-pressed', String(seriesCollapsed));
  toggleSeriesBtn.title = seriesCollapsed ? 'Show the series panel' : 'Hide the series panel';
}

function wireSeriesPanel(): void {
  toggleSeriesBtn.addEventListener('click', () => {
    seriesCollapsed = !seriesCollapsed;
    applySeriesPanel();
  });

  let dragging = false;
  seriesResizeEl.addEventListener('mousedown', (e) => {
    if (seriesCollapsed) return;
    dragging = true;
    seriesResizeEl.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    seriesWidth = Math.min(SERIES_MAX_W, Math.max(SERIES_MIN_W, e.clientX));
    applySeriesPanel();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    seriesResizeEl.classList.remove('dragging');
  });
}

// ---------- overlay text toggle ----------
let overlaysVisible = true;

function applyOverlaysToggle(): void {
  gridEl.classList.toggle('no-overlays', !overlaysVisible);
  toggleOverlaysBtn.setAttribute('aria-pressed', String(overlaysVisible));
  toggleOverlaysBtn.title = overlaysVisible ? 'Hide overlays (O)' : 'Show overlays (O)';
}

// ---------- events ----------
function wire(): void {
  fillIcons();
  wireSeriesPanel();
  wirePrefsPanel();
  toggleOverlaysBtn.addEventListener('click', () => {
    overlaysVisible = !overlaysVisible;
    applyOverlaysToggle();
  });

  $('#menu-open-files').addEventListener('click', () => fileInput.click());
  $('#menu-open-folder').addEventListener('click', () => folderInput.click());
  $('#menu-clear-library').addEventListener('click', () => void clearLocalLibrary());

  const runExport = (label: string, task: () => Promise<void>) => {
    void task()
      .then(() => setStatus(`${label} done`))
      .catch((e) => setStatus(`${label} failed: ${e instanceof Error ? e.message : e}`));
  };
  $('#menu-export-png').addEventListener('click', () => {
    if (layout.activeCell.series) runExport('Export PNG', () => exportCellImage(layout.activeCell, 'png', true));
  });
  $('#menu-export-jpg').addEventListener('click', () => {
    if (layout.activeCell.series) runExport('Export JPG', () => exportCellImage(layout.activeCell, 'jpeg', true));
  });
  $('#menu-export-dicom').addEventListener('click', () => {
    const s = layout.activeCell.series;
    if (s) runExport('Export DICOM', () => exportSeriesDicomZip(s));
  });
  $('#menu-anonymize').addEventListener('click', () => {
    const s = layout.activeCell.series;
    if (!s) return;
    void anonymizeSeriesAndExport(s)
      .then((r) => setStatus(`Anonymized ${r.instances} image${r.instances === 1 ? '' : 's'}, ${r.tagsChanged} tag${r.tagsChanged === 1 ? '' : 's'} changed`))
      .catch((e) => setStatus(`Anonymize failed: ${e instanceof Error ? e.message : e}`));
  });
  $('#about-version').textContent = `Version ${__APP_VERSION__}`;
  $('#menu-about').addEventListener('click', () => $<HTMLDialogElement>('#about-dialog').showModal());
  for (const input of [fileInput, folderInput]) {
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      void loadFiles(files);
    });
  }

  createFlyout($<HTMLButtonElement>('#menu-trigger'), $('#menu-panel'));
  createFlyout($<HTMLButtonElement>('#layout-trigger'), layoutPanelEl);

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.addEventListener('click', () => {
      const tool = b.dataset.tool as PrimaryTool;
      layout.setPrimaryTool(tool);
      const hint = TOOL_HINTS[tool];
      if (hint) setStatus(hint);
    });
  }

  for (const p of LAYOUT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'flyout-item';
    b.dataset.layout = `${p.rows}x${p.cols}`;
    b.title = `${p.label} layout`;
    b.setAttribute('role', 'radio');
    b.innerHTML = `${layoutIcon(p.rows, p.cols)}<span>${p.label}</span>`;
    b.addEventListener('click', () => layout.setLayout(p.rows, p.cols));
    layoutPanelEl.append(b);
  }

  const applyTyped = () => {
    const w = Number(wwEl.value);
    const c = Number(wcEl.value);
    if (Number.isFinite(w) && Number.isFinite(c) && w > 0) {
      presetEl.value = 'custom';
      layout.activeCell.setWindow(w, c);
    }
  };
  wwEl.addEventListener('change', applyTyped);
  wcEl.addEventListener('change', applyTyped);
  presetEl.addEventListener('change', () => {
    const v = presetEl.value;
    if (v === 'default') layout.activeCell.defaultWindow();
    else if (v === 'auto') layout.activeCell.autoWindow();
    else if (v.startsWith('ct:')) {
      const p = CT_PRESETS[Number(v.slice(3))];
      layout.activeCell.setWindow(p.width, p.center);
    }
  });

  $('#btn-invert').addEventListener('click', () => layout.activeCell.toggleInvert());
  $('#btn-flip-h').addEventListener('click', () => layout.activeCell.flip('h'));
  $('#btn-flip-v').addEventListener('click', () => layout.activeCell.flip('v'));
  $('#btn-rotate').addEventListener('click', () => layout.activeCell.rotate(90));
  $('#btn-reset').addEventListener('click', () => {
    presetEl.value = 'default';
    void layout.activeCell.resetView();
  });
  $('#btn-reset-all').addEventListener('click', () => {
    presetEl.value = 'default';
    void layout.resetAll();
  });
  $('#btn-clear-meas').addEventListener('click', () => layout.clearMeasurements());
  linkScrollBtn.addEventListener('click', () => {
    layout.linkScroll = !layout.linkScroll;
    linkScrollBtn.setAttribute('aria-pressed', String(layout.linkScroll));
  });
  cineBtn.addEventListener('click', () => {
    const cell = layout.activeCell;
    if (cell.playing) cell.pause();
    else cell.play(Number(cineFpsEl.value));
  });
  cineFpsEl.addEventListener('change', () => {
    const cell = layout.activeCell;
    if (cell.playing) cell.play(Number(cineFpsEl.value));
  });
  headerBtn.addEventListener('click', toggleHeader);

  layout.onChange(refreshAll);

  // drag and drop (folders included)
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropVeil.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropVeil.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    // A drop of a series-list item onto a cell is handled by the cell itself.
    if (e.dataTransfer?.types.includes('text/x-series-uid')) return;
    e.preventDefault();
    dragDepth = 0;
    dropVeil.hidden = true;
    const dt = e.dataTransfer;
    if (!dt) return;
    const entries = entriesFromDataTransfer(dt); // must be read synchronously
    const loose = Array.from(dt.files);
    void (entries.length ? filesFromEntries(entries) : Promise.resolve(loose)).then(loadFiles);
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A modal <dialog> (About…) is open — let its native Escape-to-close behavior run
    // unimpeded rather than have our own Escape handler's preventDefault() swallow it,
    // and don't let toolbar shortcuts (arrow keys, tool letters, Space) act on the
    // viewport behind the modal either.
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    let handled = true;
    if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') void layout.activeCell.step(-1);
    else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') void layout.activeCell.step(1);
    else if (k === 'Home') void layout.activeCell.goTo(0);
    else if (k === 'End') void layout.activeCell.goTo(Number.MAX_SAFE_INTEGER);
    else if (k === 's' || k === 'S') layout.setPrimaryTool('scroll');
    else if (k === 'w' || k === 'W') layout.setPrimaryTool('wl');
    else if (k === 'p' || k === 'P') layout.setPrimaryTool('pan');
    else if (k === 'z' || k === 'Z') layout.setPrimaryTool('zoom');
    else if (k === 'm' || k === 'M') layout.setPrimaryTool('magnify');
    else if (k === 'i' || k === 'I') layout.activeCell.toggleInvert();
    else if (k === 'r' || k === 'R') $('#btn-reset').click();
    else if (k === 'h' || k === 'H') toggleHeader();
    else if (k === 'o' || k === 'O') toggleOverlaysBtn.click();
    else if (k === ' ') cineBtn.click();
    else if (k === 'Escape') stopAllCine();
    else handled = false;
    if (handled) e.preventDefault();
  });
}

function toggleHeader(): void {
  const on = !header.visible;
  header.setVisible(on);
  headerBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    const id = layout.activeCell.currentImageId;
    void header.show(blobForImageId(id), id ?? '');
  }
}

async function main(): Promise<void> {
  setStatus('Starting…');
  await initCornerstone();
  layout = new LayoutManager(gridEl, (uid) => library.series.get(uid));
  header = new HeaderPanel($('#header-panel'));
  header.onCommit((blob, sourceKey) => {
    library.edited.set(sourceKey.split('?')[0], blob);
    const found = findInstanceByImageId(sourceKey);
    if (found) {
      void saveBlob(found.instance.sop, blob); // write-through so the edit survives a reload
      void refreshSeriesSummary(found.series, blob).then(() => {
        renderSeriesList();
        refreshOverlays();
      });
    }
  });
  fillPresets(null);
  wire();
  void requestPersistence();
  await restoreLibrary();
  refreshAll();
  setStatus('Ready');
  revealSplashOpen();
  // Test hook for automated checks.
  (window as unknown as { __viewer: LayoutManager }).__viewer = layout;

  // No-op in a normal browser tab; only active inside the Windows desktop shell (WebView2).
  initHostBridge({
    appVersion: __APP_VERSION__,
    status: (msg) => setStatus(msg),
    load: async (files, { label }) => {
      // The user explicitly opened a study in the native shell; don't make them also
      // dismiss the splash to see it.
      if (!splashEl.classList.contains('hide')) hideSplash();
      // persist: false — the archive is the source of truth; don't silently copy PHI
      // into this machine's browser storage.
      const report = await loadFiles(files, { persist: false, label, open: true });
      return {
        images: report?.instancesAdded ?? 0,
        duplicates: report?.duplicates ?? 0,
        series: report?.touched.length ?? 0,
        skipped: report?.skipped.length ?? 0,
      };
    },
  });
}

main().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${e instanceof Error ? e.message : e}`);
});
