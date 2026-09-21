import './style.css';
import { utilities as csUtils } from '@cornerstonejs/core';
import { wadouri } from '@cornerstonejs/dicom-image-loader';
import { initCornerstone } from './cs';
import { HeaderPanel } from './header';
import { entriesFromDataTransfer, filesFromEntries, ingest, library, orderedSeries } from './ingest';
import { LAYOUT_PRESETS, LayoutManager, type PrimaryTool } from './layout';
import { CT_PRESETS } from './presets';
import type { Series } from './types';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const gridEl = $<HTMLDivElement>('#viewport-grid');
const seriesEl = $('#series');
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
const layoutGroupEl = $('#layout-group');

let layout: LayoutManager;
let header: HeaderPanel;
let lastPresetSeries: Series | null = null;
const thumbQueue: (() => Promise<void>)[] = [];
let thumbRunning = false;

function setStatus(msg: string, title = ''): void {
  statusEl.textContent = msg;
  statusEl.title = title;
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
  $('#btn-invert').setAttribute('aria-pressed', String(st.invert));
  $('#btn-flip-h').setAttribute('aria-pressed', String(st.flipH));
  $('#btn-flip-v').setAttribute('aria-pressed', String(st.flipV));
  linkScrollBtn.setAttribute('aria-pressed', String(layout.linkScroll));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === layout.primaryTool);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.tool === layout.primaryTool));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
    const [r, c] = b.dataset.layout!.split('x').map(Number);
    const on = r === layout.layoutRows && c === layout.layoutCols;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const id of ['#btn-invert', '#btn-flip-h', '#btn-flip-v', '#btn-rotate', '#btn-reset', '#btn-clear-meas']) {
    ($(id) as HTMLButtonElement).disabled = none;
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
      h.textContent = [s.patientName, s.studyDescription, s.studyDate].filter(Boolean).join(' · ') || 'Study';
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
  if (!imageId) return undefined;
  const m = /^dicomfile:(\d+)/.exec(imageId);
  return m ? wadouri.fileManager.get(Number(m[1])) : undefined;
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
async function loadFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  setStatus(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  const report = await ingest(files, (done, total) => {
    if (done % 8 === 0 || done === total) setStatus(`Reading files… ${done} / ${total}`);
  });
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

  // Open the first new series into the active cell if it's still empty.
  if (!layout.activeCell.series && report.touched.length) {
    const first = orderedSeries().find((s) => report.touched.includes(s));
    if (first) await pickSeries(first);
  } else {
    markCurrentSeries();
  }
}

// ---------- events ----------
function wire(): void {
  $('#open-files').addEventListener('click', () => fileInput.click());
  $('#open-folder').addEventListener('click', () => folderInput.click());
  for (const input of [fileInput, folderInput]) {
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      void loadFiles(files);
    });
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.addEventListener('click', () => layout.setPrimaryTool(b.dataset.tool as PrimaryTool));
  }

  for (const p of LAYOUT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.layout = `${p.rows}x${p.cols}`;
    b.textContent = p.label;
    b.title = `${p.label} layout`;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => layout.setLayout(p.rows, p.cols));
    layoutGroupEl.append(b);
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
  $('#btn-clear-meas').addEventListener('click', () => layout.clearMeasurements());
  linkScrollBtn.addEventListener('click', () => {
    layout.linkScroll = !layout.linkScroll;
    linkScrollBtn.setAttribute('aria-pressed', String(layout.linkScroll));
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
    else if (k === 'i' || k === 'I') layout.activeCell.toggleInvert();
    else if (k === 'r' || k === 'R') $('#btn-reset').click();
    else if (k === 'h' || k === 'H') toggleHeader();
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
  fillPresets(null);
  wire();
  refreshAll();
  setStatus('Ready');
  // Test hook for automated checks.
  (window as unknown as { __viewer: LayoutManager }).__viewer = layout;
}

main().catch((e) => {
  console.error(e);
  setStatus(`Failed to start: ${e instanceof Error ? e.message : e}`);
});
