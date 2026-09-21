import { cache, utilities as csUtils } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import type { Series } from './types';

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

/**
 * One stack viewport's worth of state (load, scroll, W/L, presentation).
 * Owned and positioned by a LayoutManager, which also owns the shared tool group.
 */
export class ViewportCell {
  series: Series | null = null;
  /** Invert flag Cornerstone applies by default (true for MONOCHROME1). */
  private baseInvert = false;

  constructor(
    readonly viewportId: string,
    private readonly viewport: Types.IStackViewport,
  ) {}

  // ---- series / stack ----
  async load(series: Series, index = 0): Promise<void> {
    this.series = series;
    const ids = series.instances.map((i) => i.imageId);
    await this.viewport.setStack(ids, Math.min(index, ids.length - 1));
    this.viewport.resetCamera();
    this.baseInvert = !!this.viewport.getProperties().invert;
    this.viewport.render();
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
}
