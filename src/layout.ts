import { Enums, RenderingEngine } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import * as tools from '@cornerstonejs/tools';
import type { Series } from './types';
import { ViewportCell } from './viewport-cell';

export type PrimaryTool =
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
  | 'label';

const ENGINE_ID = 'viewer-engine';
const TOOLGROUP_ID = 'main-tools';
/** Largest preset (3 x 3); cells beyond the active layout stay created but hidden. */
const MAX_CELLS = 9;

const TOOL_NAMES: Record<PrimaryTool, string> = {
  scroll: tools.StackScrollTool.toolName,
  wl: tools.WindowLevelTool.toolName,
  pan: tools.PanTool.toolName,
  zoom: tools.ZoomTool.toolName,
  magnify: tools.MagnifyTool.toolName,
  length: tools.LengthTool.toolName,
  angle: tools.AngleTool.toolName,
  rectangleroi: tools.RectangleROITool.toolName,
  ellipticalroi: tools.EllipticalROITool.toolName,
  probe: tools.ProbeTool.toolName,
  label: tools.ArrowAnnotateTool.toolName,
};

export const MEASUREMENT_TOOLS: PrimaryTool[] = [
  'length',
  'angle',
  'rectangleroi',
  'ellipticalroi',
  'probe',
  'label',
];

/** Mouse buttons these tools keep bound to regardless of which tool is primary. */
const FIXED_BINDINGS: Partial<Record<PrimaryTool, { mouseButton: number }[]>> = {
  pan: [{ mouseButton: tools.Enums.MouseBindings.Auxiliary }],
  zoom: [{ mouseButton: tools.Enums.MouseBindings.Secondary }],
  scroll: [{ mouseButton: tools.Enums.MouseBindings.Wheel }],
};

export interface LayoutPreset {
  rows: number;
  cols: number;
  label: string;
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  { rows: 1, cols: 1, label: '1 × 1' },
  { rows: 1, cols: 2, label: '1 × 2' },
  { rows: 2, cols: 1, label: '2 × 1' },
  { rows: 2, cols: 2, label: '2 × 2' },
  { rows: 2, cols: 3, label: '2 × 3' },
  { rows: 3, cols: 3, label: '3 × 3' },
];

interface CellEntry {
  wrapper: HTMLDivElement;
  csElement: HTMLDivElement;
  overlay: Record<'tl' | 'tr' | 'bl' | 'br', HTMLDivElement>;
  placeholder: HTMLDivElement;
  cell: ViewportCell;
}

export interface VisibleEntry {
  index: number;
  cell: ViewportCell;
  overlay: CellEntry['overlay'];
}

/**
 * Owns the Cornerstone RenderingEngine, the one shared ToolGroup, and a grid of
 * ViewportCells. Tool selection (the left-mouse-button tool) is global, matching
 * how multi-viewport DICOM viewers usually behave; window/level and presentation
 * are per cell. Cells beyond the current layout are kept alive but hidden, so
 * switching layouts back and forth never loses what was loaded into a cell.
 */
export class LayoutManager {
  private engine: RenderingEngine;
  private toolGroup: NonNullable<ReturnType<typeof tools.ToolGroupManager.createToolGroup>>;
  private entries: CellEntry[] = [];
  private rows = 1;
  private cols = 1;
  private active = 0;
  private primary: PrimaryTool = 'wl';
  private listeners = new Set<() => void>();
  private pending = 0;
  private syncing = false;
  private maximized: number | null = null;
  linkScroll = false;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly getSeriesByUid: (uid: string) => Series | undefined,
  ) {
    this.engine = new RenderingEngine(ENGINE_ID);
    const tg = tools.ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
    for (const name of Object.values(TOOL_NAMES)) tg.addTool(name);
    this.toolGroup = tg;

    this.ensureCell(0);
    this.applyLayoutCss();
    this.applyBindings();
    this.setActive(0);
  }

  // ---- change notification (throttled to one callback per frame) ----
  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }
  private scheduleEmit(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.listeners.forEach((cb) => cb());
    });
  }

  // ---- cell creation ----
  private ensureCell(index: number): CellEntry {
    const existing = this.entries[index];
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.className = 'cell';
    wrapper.dataset.index = String(index);

    const csElement = document.createElement('div');
    csElement.className = 'cs-el';
    csElement.addEventListener('contextmenu', (e) => e.preventDefault());

    const overlay = {
      tl: document.createElement('div'),
      tr: document.createElement('div'),
      bl: document.createElement('div'),
      br: document.createElement('div'),
    };
    const overlayWrap = document.createElement('div');
    overlayWrap.className = 'cell-overlay';
    overlayWrap.setAttribute('aria-hidden', 'true');
    for (const [pos, el] of Object.entries(overlay)) {
      el.className = `ov ${pos}`;
      overlayWrap.append(el);
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'cell-empty';
    placeholder.textContent = 'Click, then choose a series — or drag one here';

    wrapper.append(csElement, overlayWrap, placeholder);
    wrapper.addEventListener('mousedown', () => this.setActive(index));
    wrapper.addEventListener('dblclick', () => this.toggleMaximize(index));
    wrapper.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('text/x-series-uid')) e.preventDefault();
    });
    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      const sourceIndex = e.dataTransfer?.getData('text/x-cell-index');
      if (sourceIndex) {
        const src = Number(sourceIndex);
        if (!Number.isNaN(src)) {
          void this.swapCells(src, index);
          return;
        }
      }
      const uid = e.dataTransfer?.getData('text/x-series-uid');
      const series = uid ? this.getSeriesByUid(uid) : undefined;
      if (series) void this.assign(index, series);
    });
    // The overlay text doubles as a drag handle for moving/swapping a cell's series
    // onto another cell — dragging the whole wrapper would fight Cornerstone's own
    // mouse-based tool interactions (drawing a measurement is also a drag).
    for (const el of Object.values(overlay)) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        const series = this.entries[index]?.cell.series;
        if (!series) {
          e.preventDefault();
          return;
        }
        e.dataTransfer!.setData('text/x-series-uid', series.uid);
        e.dataTransfer!.setData('text/x-cell-index', String(index));
        e.dataTransfer!.effectAllowed = 'move';
      });
    }

    this.container.append(wrapper);

    const viewportId = `vp-${index}`;
    this.engine.enableElement({
      viewportId,
      type: Enums.ViewportType.STACK,
      element: csElement,
      defaultOptions: { background: [0, 0, 0] },
    });
    this.toolGroup.addViewport(viewportId, ENGINE_ID);
    const viewport = this.engine.getViewport(viewportId) as Types.IStackViewport;
    const cell = new ViewportCell(viewportId, viewport);

    for (const ev of [Enums.Events.STACK_NEW_IMAGE, Enums.Events.VOI_MODIFIED, Enums.Events.CAMERA_MODIFIED]) {
      csElement.addEventListener(ev, () => {
        if (ev === Enums.Events.STACK_NEW_IMAGE) this.syncScroll(index);
        this.scheduleEmit();
      });
    }
    new ResizeObserver(() => this.engine.resize(true, false)).observe(csElement);

    const entry: CellEntry = { wrapper, csElement, overlay, placeholder, cell };
    this.entries[index] = entry;
    return entry;
  }

  private syncScroll(sourceIndex: number): void {
    if (!this.linkScroll || this.syncing) return;
    const idx = this.entries[sourceIndex].cell.currentIndex;
    this.syncing = true;
    for (let i = 0; i < this.rows * this.cols; i++) {
      if (i === sourceIndex) continue;
      const e = this.entries[i];
      if (e?.cell.series) void e.cell.goTo(idx);
    }
    this.syncing = false;
  }

  // ---- layout ----
  get layoutRows(): number {
    return this.rows;
  }
  get layoutCols(): number {
    return this.cols;
  }

  setLayout(rows: number, cols: number): void {
    if (this.maximized !== null) this.setMaximized(null);
    this.rows = rows;
    this.cols = cols;
    const count = Math.min(MAX_CELLS, rows * cols);
    for (let i = 0; i < count; i++) this.ensureCell(i);
    for (let i = 0; i < MAX_CELLS; i++) {
      const e = this.entries[i];
      if (e) e.wrapper.hidden = i >= count;
    }
    this.applyLayoutCss();
    if (this.active >= count) this.setActive(0);
    this.scheduleEmit();
  }

  private applyLayoutCss(): void {
    this.container.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;
    this.container.style.gridTemplateRows = `repeat(${this.rows}, 1fr)`;
  }

  // ---- active cell ----
  get activeIndex(): number {
    return this.active;
  }
  get activeCell(): ViewportCell {
    return this.entries[this.active].cell;
  }
  setActive(index: number): void {
    if (!this.entries[index]) return;
    this.active = index;
    this.entries.forEach((e, i) => e?.wrapper.classList.toggle('active', i === index));
    this.scheduleEmit();
  }

  // ---- maximize (double-click a cell to fill the grid; double-click again to restore) ----
  get maximizedIndex(): number | null {
    return this.maximized;
  }

  toggleMaximize(index: number): void {
    this.setMaximized(this.maximized === index ? null : index);
  }

  private setMaximized(index: number | null): void {
    this.maximized = index;
    this.container.classList.toggle('maximized', index !== null);
    this.entries.forEach((e, i) => e?.wrapper.classList.toggle('maximized', i === index));
    if (index !== null) this.setActive(index);
    this.scheduleEmit();
  }

  // ---- series assignment ----
  async assign(index: number, series: Series, imageIndex = 0): Promise<void> {
    const entry = this.ensureCell(index);
    await entry.cell.load(series, imageIndex);
    entry.placeholder.hidden = true;
    this.setActive(index);
  }

  /**
   * Dragging one cell's series onto another. If the target already has a series,
   * they trade places; if the target is empty, the source's series is copied there
   * (the source keeps showing it too) — cells are never left empty by a drag, since
   * Cornerstone's stack API isn't meant to be pointed at an empty array (see
   * clearLocalLibrary's reload-based workaround in main.ts for the same constraint).
   */
  async swapCells(sourceIndex: number, targetIndex: number): Promise<void> {
    if (sourceIndex === targetIndex) return;
    const source = this.entries[sourceIndex];
    const target = this.entries[targetIndex];
    const sourceSeries = source?.cell.series;
    if (!source || !target || !sourceSeries) return;
    const sourceImageIndex = source.cell.currentIndex;
    const targetSeries = target.cell.series;
    const targetImageIndex = target.cell.currentIndex;
    await this.assign(targetIndex, sourceSeries, sourceImageIndex);
    if (targetSeries) await this.assign(sourceIndex, targetSeries, targetImageIndex);
    this.setActive(targetIndex);
  }

  /**
   * Reset window/level, zoom, pan, flip and rotation for every cell in the current
   * layout that has a series loaded — the single-cell "Reset" button only touches the
   * active cell, which isn't enough once a study is spread across a 2x2/3x3 layout.
   * ViewportCell.resetView() already no-ops on an empty cell, so this can run over
   * every visible entry without filtering first.
   */
  async resetAll(): Promise<void> {
    await Promise.all(this.visibleEntries().map((e) => e.cell.resetView()));
  }

  /** Cells that belong to the current layout (in grid order). */
  visibleEntries(): VisibleEntry[] {
    const count = this.rows * this.cols;
    const out: VisibleEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = this.entries[i];
      if (e) out.push({ index: i, cell: e.cell, overlay: e.overlay });
    }
    return out;
  }

  // ---- tools ----
  get primaryTool(): PrimaryTool {
    return this.primary;
  }

  setPrimaryTool(tool: PrimaryTool): void {
    this.primary = tool;
    this.applyBindings();
    this.scheduleEmit();
  }

  /**
   * Cornerstone's own ToolGroup.setToolActive() merges the bindings you pass it into
   * whatever bindings that tool already had — it concatenates prevBindings + newBindings
   * and dedupes, but never drops one on its own (see setToolActive in
   * @cornerstonejs/tools' ToolGroup.js). Calling it here every time the primary tool
   * changes, with a binding list that's meant to *shrink* for whichever tool just lost
   * Primary, silently fails to shrink anything: Zoom/Pan/Scroll would each keep their
   * stale Primary-mouse-button binding forever after their one turn as the primary tool,
   * so after enough tool switches several tools end up simultaneously bound to the left
   * mouse button and drags stop reliably reaching whichever measurement tool is actually
   * selected. `setToolPassive(name, { removeAllBindings: true })` is the one call that
   * genuinely clears a tool's bindings (it filters the existing list down to nothing), so
   * every tool is fully reset before being reactivated with only the bindings it should
   * currently have.
   */
  private applyBindings(): void {
    const { MouseBindings } = tools.Enums;
    for (const key of Object.keys(TOOL_NAMES) as PrimaryTool[]) {
      const name = TOOL_NAMES[key];
      this.toolGroup.setToolPassive(name, { removeAllBindings: true });
      const bindings = [...(FIXED_BINDINGS[key] ?? [])];
      if (key === this.primary) bindings.push({ mouseButton: MouseBindings.Primary });
      if (bindings.length) this.toolGroup.setToolActive(name, { bindings });
    }
  }

  /** Remove every measurement annotation from one cell (defaults to the active cell). */
  clearMeasurements(index = this.active): void {
    const entry = this.entries[index];
    if (!entry) return;
    for (const t of MEASUREMENT_TOOLS) {
      tools.annotation.state.removeAnnotations(TOOL_NAMES[t], entry.csElement);
    }
    tools.utilities.triggerAnnotationRender(entry.csElement);
    this.scheduleEmit();
  }

  destroy(): void {
    this.engine.destroy();
  }
}
