import { Enums, RenderingEngine, cache, utilities as csUtils } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import * as tools from '@cornerstonejs/tools';
import type { Series } from './types';

export type PrimaryTool = 'scroll' | 'wl' | 'pan' | 'zoom';

const ENGINE_ID = 'viewer-engine';
const VIEWPORT_ID = 'main';
const TOOLGROUP_ID = 'main-tools';

const TOOL_NAMES: Record<PrimaryTool, string> = {
  scroll: tools.StackScrollTool.toolName,
  wl: tools.WindowLevelTool.toolName,
  pan: tools.PanTool.toolName,
  zoom: tools.ZoomTool.toolName,
};

export interface ViewState {
  index: number;
  total: number;
  windowWidth?: number;
  windowCenter?: number;
  zoom: number;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  rotation: number;
}

export interface WindowPreset {
  label: string;
  width: number;
  center: number;
}

/** Common CT presets (Hounsfield units). */
export const CT_PRESETS: WindowPreset[] = [
  { label: 'Brain', width: 80, center: 40 },
  { label: 'Subdural', width: 300, center: 100 },
  { label: 'Stroke', width: 40, center: 40 },
  { label: 'Soft tissue', width: 400, center: 40 },
  { label: 'Liver', width: 150, center: 60 },
  { label: 'Mediastinum', width: 350, center: 50 },
  { label: 'Lung', width: 1500, center: -600 },
  { label: 'Bone', width: 2000, center: 500 },
];

export class Viewer {
  readonly element: HTMLDivElement;
  private engine: RenderingEngine;
  private viewport: Types.IStackViewport;
  private toolGroup: NonNullable<ReturnType<typeof tools.ToolGroupManager.createToolGroup>>;
  private primary: PrimaryTool = 'wl';
  /** Invert flag Cornerstone applies by default (true for MONOCHROME1). */
  private baseInvert = false;
  private listeners = new Set<() => void>();
  private pending = 0;
  series: Series | null = null;

  constructor(element: HTMLDivElement) {
    this.element = element;
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    this.engine = new RenderingEngine(ENGINE_ID);
    this.engine.enableElement({
      viewportId: VIEWPORT_ID,
      type: Enums.ViewportType.STACK,
      element,
      defaultOptions: { background: [0, 0, 0] },
    });
    this.viewport = this.engine.getViewport(VIEWPORT_ID) as Types.IStackViewport;

    const tg = tools.ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
    for (const name of Object.values(TOOL_NAMES)) tg.addTool(name);
    tg.addViewport(VIEWPORT_ID, ENGINE_ID);
    this.toolGroup = tg;
    this.applyBindings();

    for (const ev of [
      Enums.Events.STACK_NEW_IMAGE,
      Enums.Events.VOI_MODIFIED,
      Enums.Events.CAMERA_MODIFIED,
    ]) {
      element.addEventListener(ev, () => this.scheduleEmit());
    }

    new ResizeObserver(() => {
      this.engine.resize(true, false);
    }).observe(element);
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

  // ---- tools ----
  get primaryTool(): PrimaryTool {
    return this.primary;
  }

  setPrimaryTool(tool: PrimaryTool): void {
    this.primary = tool;
    this.applyBindings();
    this.scheduleEmit();
  }

  private applyBindings(): void {
    const { MouseBindings } = tools.Enums;
    // Fixed secondary bindings: middle = pan, right = zoom, wheel = scroll.
    const bindings: Record<PrimaryTool, { mouseButton: number }[]> = {
      wl: [],
      pan: [{ mouseButton: MouseBindings.Auxiliary }],
      zoom: [{ mouseButton: MouseBindings.Secondary }],
      scroll: [{ mouseButton: MouseBindings.Wheel }],
    };
    bindings[this.primary].push({ mouseButton: MouseBindings.Primary });
    for (const key of Object.keys(TOOL_NAMES) as PrimaryTool[]) {
      const b = bindings[key];
      if (b.length) this.toolGroup.setToolActive(TOOL_NAMES[key], { bindings: b });
      else this.toolGroup.setToolPassive(TOOL_NAMES[key]);
    }
  }

  // ---- series / stack ----
  async load(series: Series, index = 0): Promise<void> {
    this.series = series;
    const ids = series.instances.map((i) => i.imageId);
    await this.viewport.setStack(ids, Math.min(index, ids.length - 1));
    this.viewport.resetCamera();
    this.baseInvert = !!this.viewport.getProperties().invert;
    this.viewport.render();
    this.scheduleEmit();
  }

  get currentImageId(): string | undefined {
    return this.series ? this.viewport.getCurrentImageId() : undefined;
  }

  get currentIndex(): number {
    return this.series ? this.viewport.getCurrentImageIdIndex() : 0;
  }

  async goTo(index: number): Promise<void> {
    if (!this.series) return;
    const n = this.series.instances.length;
    const next = Math.max(0, Math.min(n - 1, index));
    if (next !== this.currentIndex) await this.viewport.setImageIdIndex(next);
  }

  step(delta: number): Promise<void> {
    return this.goTo(this.currentIndex + delta);
  }

  // ---- window / level ----
  setWindow(width: number, center: number): void {
    if (!this.series || this.series.isColor) return;
    const { lower, upper } = csUtils.windowLevel.toLowHighRange(Math.max(1, width), center);
    this.viewport.setProperties({ voiRange: { lower, upper } });
    this.viewport.render();
  }

  /** Full pixel range of the current image (modality units). */
  autoWindow(): void {
    const id = this.currentImageId;
    const img = id ? cache.getImage(id) : undefined;
    if (!img) return;
    const lo = img.minPixelValue * img.slope + img.intercept;
    const hi = img.maxPixelValue * img.slope + img.intercept;
    this.viewport.setProperties({ voiRange: { lower: lo, upper: hi } });
    this.viewport.render();
  }

  /** Back to the window stored in the DICOM header (falls back to the full pixel range). */
  defaultWindow(): void {
    const id = this.currentImageId;
    const img = id ? cache.getImage(id) : undefined;
    const first = (v: unknown): number | undefined => (Array.isArray(v) ? v[0] : (v as number | undefined));
    const w = first(img?.windowWidth);
    const c = first(img?.windowCenter);
    if (w !== undefined && c !== undefined && w > 0) this.setWindow(w, c);
    else this.autoWindow();
  }

  // ---- presentation ----
  toggleInvert(): void {
    const { invert } = this.viewport.getProperties();
    this.viewport.setProperties({ invert: !invert });
    this.viewport.render();
  }

  flip(axis: 'h' | 'v'): void {
    const p = this.viewport.getViewPresentation();
    this.viewport.setViewPresentation(
      axis === 'h' ? { flipHorizontal: !p.flipHorizontal } : { flipVertical: !p.flipVertical },
    );
    this.viewport.render();
  }

  rotate(deg: number): void {
    const p = this.viewport.getViewPresentation();
    this.viewport.setViewPresentation({ rotation: (((p.rotation ?? 0) + deg) % 360 + 360) % 360 });
    this.viewport.render();
  }

  /**
   * Reset zoom, pan, rotation, flips, invert and window by re-running the same
   * setStack path used on load. viewport.resetProperties() is deliberately not
   * used: it mishandles the MONOCHROME1 invert default.
   */
  async resetView(): Promise<void> {
    if (!this.series) return;
    await this.load(this.series, this.currentIndex);
    this.viewport.setViewPresentation({ rotation: 0, flipHorizontal: false, flipVertical: false });
    this.viewport.render();
  }

  // ---- state for overlays / toolbar ----
  get state(): ViewState {
    const props = this.viewport.getProperties();
    const range = props.voiRange;
    const wl = range ? csUtils.windowLevel.toWindowLevel(range.lower, range.upper) : undefined;
    const pres = this.viewport.getViewPresentation();
    return {
      index: this.currentIndex,
      total: this.series?.instances.length ?? 0,
      windowWidth: wl?.windowWidth,
      windowCenter: wl?.windowCenter,
      zoom: this.series ? this.viewport.getZoom() : 1,
      invert: !!props.invert !== this.baseInvert,
      flipH: !!pres.flipHorizontal,
      flipV: !!pres.flipVertical,
      rotation: pres.rotation ?? 0,
    };
  }

  destroy(): void {
    this.engine.destroy();
  }
}
