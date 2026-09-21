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
  playing: boolean;
}

/**
 * One stack viewport's worth of state (load, scroll, W/L, presentation).
 * Owned and positioned by a LayoutManager, which also owns the shared tool group.
 */
export class ViewportCell {
  series: Series | null = null;
  /** Invert flag Cornerstone applies by default (true for MONOCHROME1). */
  private baseInvert = false;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private playing_ = false;

  constructor(
    readonly viewportId: string,
    private readonly viewport: Types.IStackViewport,
  ) {}

  /** The Cornerstone-managed DOM element this cell renders into. */
  get element(): HTMLDivElement {
    return this.viewport.element;
  }

  /** The rendered pixel canvas for the current frame (no annotation overlay). */
  getCanvas(): HTMLCanvasElement {
    return this.viewport.getCanvas();
  }

  // ---- series / stack ----
  async load(series: Series, index = 0): Promise<void> {
    this.pause();
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

  // ---- cine ----
  get playing(): boolean {
    return this.playing_;
  }

  /**
   * Loop through every image at the given frame rate, wrapping back to the start.
   * Self-scheduling (each tick waits for the previous goTo() to actually resolve
   * before queuing the next one) rather than a raw setInterval, so a slow decode
   * can't pile up overlapping frame advances.
   */
  play(fps = 10): void {
    this.pause();
    if (!this.series || this.series.instances.length < 2) return;
    this.playing_ = true;
    const delayMs = 1000 / Math.max(1, fps);
    const tick = () => {
      this.playTimer = setTimeout(async () => {
        if (!this.playing_ || !this.series) return;
        await this.goTo((this.currentIndex + 1) % this.series.instances.length);
        if (this.playing_) tick();
      }, delayMs);
    };
    tick();
  }

  pause(): void {
    this.playing_ = false;
    if (this.playTimer !== null) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
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

  /**
   * Cornerstone bug: `setViewPresentation({ flipHorizontal: false })` is a no-op when already
   * flipped. Its own implementation only toggles when the flag is truthy (a "flip now" signal,
   * not a "set to this value" one), so asking it to set `false` skips the toggle entirely —
   * a button click can turn a flip on but never back off. Call the underlying toggle directly
   * instead; passing `true` always flips, which is exactly what a click should do either way.
   */
  flip(axis: 'h' | 'v'): void {
    const toggle = this.viewport as unknown as {
      flip: (d: { flipHorizontal?: boolean; flipVertical?: boolean }) => void;
    };
    toggle.flip(axis === 'h' ? { flipHorizontal: true } : { flipVertical: true });
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
      playing: this.playing_,
    };
  }
}
