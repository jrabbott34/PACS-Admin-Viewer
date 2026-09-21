# DICOM Viewer — project context

Local-first, browser-only DICOM viewer. **Not for diagnostic use** (keep the footer disclaimer). No network calls,
no telemetry, no CDN assets: images may contain PHI, so everything stays in the tab. Keep it that way.

## Stack
Vite 8, TypeScript 5.9, Cornerstone3D 5.10.7 (`core`, `tools`, `dicom-image-loader`), dcmjs 0.52, dicom-parser,
pdfjs-dist 6 (**legacy build**). Plain DOM/CSS, no UI framework.

## Commands
`npm install`, `npm run dev` (5173), `npm run build` (tsc + vite build), `npm run preview`.

## Layout
| File | Role |
| --- | --- |
| `src/cs.ts` | One-time init of Cornerstone, tools and the DICOM loader |
| `src/ingest.ts` | Sniffs files, parses headers (dicom-parser), groups into series, sorts slices, folder drop helpers |
| `src/wrap.ts` | JPG/PNG/etc. and PDF pages -> in-memory DICOM Secondary Capture (via dcmjs) |
| `src/presets.ts` | `CT_PRESETS` window/level presets (shared data, no Cornerstone dependency) |
| `src/viewport-cell.ts` | `ViewportCell`: one stack viewport's load/scroll/W-L/presentation state |
| `src/layout.ts` | `LayoutManager`: shared RenderingEngine + one global ToolGroup, the grid of cells, active-cell tracking, layout presets, link-scroll, measurement-tool clearing |
| `src/header.ts` | dcmjs-based tag reader and the searchable header panel |
| `src/main.ts` | DOM wiring: toolbar, series list, thumbnails, per-cell overlays, drag/drop, shortcuts |
| `src/types.ts` | `Series`, `InstanceInfo`, `IngestReport` |
| `samples/` | Synthetic test data + `generate_samples.py` (needs pydicom, numpy, pillow, reportlab) |
| `tests/e2e/` | Headless Playwright (Python) checks; run from `samples/` |

## Data model
Every input becomes DICOM. Files are registered with `wadouri.fileManager.add(blob)` giving imageIds like
`dicomfile:7`; multi-frame objects use `dicomfile:7?frame=N` (**1-based**). Wrapped images and PDF pages are Part 10
Secondary Capture blobs, so the viewport, series list and header panel treat them like any other DICOM.
Grayscale JPG/PNG/PDF pages are stored as MONOCHROME2 (so W/L works); colour ones as RGB (W/L disabled).
The library (`library` in `ingest.ts`) is keyed by SeriesInstanceUID and de-duplicates by SOPInstanceUID.

## Layouts and the active cell (phase 2)
`LayoutManager` owns one `RenderingEngine` and one shared `ToolGroup` covering every cell's viewport. Tool
selection (the left-mouse-button tool, including the five measurement tools) is **global** — it applies to
whichever viewport you interact with next, matching how multi-viewport PACS viewers usually behave. Window/level,
invert, flip, rotation and the current slice are **per cell** (`ViewportCell` state).

Cells are created lazily up to a 3x3 ceiling (`MAX_CELLS`) and never destroyed when the layout shrinks — they're
just hidden (`wrapper.hidden`). This means flipping between, say, 1x1 and 2x2 never loses what was loaded into a
cell that persists across both layouts. `LayoutManager.setLayout(rows, cols)` only changes the CSS grid template
and which cells are visible.

The **active cell** (`layout.activeIndex` / `layout.activeCell`) is whichever cell was last clicked (`mousedown`
on the cell wrapper). Toolbar actions that only make sense for one viewport — W/L typed values and presets,
invert, flip, rotate, reset, "Clear" measurements, the header panel — act on the active cell. Clicking a series
list item loads it into the active cell; dragging a series list item (`draggable`, `dataset.uid`, custom
`text/x-series-uid` MIME type) onto any cell assigns it to that specific cell directly, bypassing "active cell"
entirely, and also makes that cell active.

**Link scroll**: when `layout.linkScroll` is on, a `STACK_NEW_IMAGE` event on any cell broadcasts the same
(clamped) image index to every other cell that has a series loaded. A `syncing` re-entrancy guard stops this
from cascading into an infinite loop across cells.

**Measurement tools**: Length, Angle, Rectangle ROI, Ellipse ROI, Probe, added globally in `cs.ts` and to the
shared tool group in `layout.ts`. They use whatever pixel-spacing calibration Cornerstone finds on the image
(real DICOM's PixelSpacing, falling back to pixels for wrapped JPG/PNG which have none — untested which message
Cornerstone shows for that fallback, see NOT verified below). `LayoutManager.clearMeasurements(index)` removes
all annotations for one cell via `tools.annotation.state.removeAnnotations(toolName, element)` per tool name,
then calls `tools.utilities.triggerAnnotationRender(element)` — removal alone does not force the SVG annotation
layer to redraw.

## Hard-won gotchas — read before changing anything here
1. **`useLegacyMetadataProvider: true` in `cs.ts` is required.** With Cornerstone v5's default "naturalized metadata"
   path, every load failed with `no pixel data in NATURALIZED` for our fileManager blobs (the same parsing works in
   Node, so the cause is browser-side and was never diagnosed). The legacy provider prints two deprecation warnings;
   they are expected. Revisit when moving to the new `@cornerstonejs/metadata` API.
2. **Never call `viewport.resetProperties()`.** It breaks the MONOCHROME1 invert default (image renders inverted
   even though the flag looks right, and re-setting the flag is a no-op). `Viewer.resetView()` re-runs `setStack`
   instead, and `defaultWindow()` reads WindowCenter/Width from the cached image. `state.invert` is reported
   relative to the series default (`baseInvert`) so an untouched X-ray does not read as "Inverted".
3. **Vite config** (`vite.config.ts`): alias `events` and `url` to the npm polyfills (dcmjs -> xmlbuilder2 needs them,
   otherwise "Class extends value undefined"); exclude `dicom-image-loader` from pre-bundling; include
   `dicom-parser` and the four `codec-*` decode modules; `worker.format = 'es'`.
4. **dcmjs `datasetToBlob` needs Node's `Buffer`.** Use `DicomDict.write()` (see `wrap.ts`).
5. **pdf.js 6 needs `Map.getOrInsertComputed`**, missing in slightly older browsers. Use `pdfjs-dist/legacy/...`.
6. `loadImageToCanvas` (thumbnails) sets inline pixel sizes on the canvas; `style.css` overrides with `!important`.
7. `window.__viewer` is a deliberate test hook used by `tests/e2e`. Keep it or update the tests.
8. `npm audit` reports vulnerabilities in transitive dependencies (not investigated). Fine for a local tool.

## Verified (headless Chromium 141, software WebGL)
Dev and production builds; CT/MR/DX series, sorting, scroll (wheel, drag, keys); W/L drag, presets, typed values;
zoom, pan, flip, rotate, invert, reset; MONOCHROME1 rendering; RLE, JPEG 2000 and JPEG-LS decode pixel-identical to
uncompressed; JPG, PNG and PDF import; header panel and filter; thumbnails; zero console errors.

Phase 2, headless Chromium: 2x2 layout with three different series (DX/CT/MR) loaded into three cells
simultaneously; click-to-activate a cell; click a series list item to load into the active cell; drag a series
onto a specific cell (synthetic HTML5 `drop` dispatch — see below); Length tool draws a correctly-calibrated line
("130 mm", matching the synthetic phantom's known pixel spacing); "Clear" removes the annotation's SVG text node;
link scroll propagates a `goTo()` on one cell to another cell showing the same series; zero console errors
throughout.

**Not verified**: real mouse-drag HTML5 drag-and-drop (Playwright's synthetic `mousedown`/`mousemove`/`mouseup`
does not trigger native `dragstart`; the test dispatches a `DragEvent('drop', { dataTransfer })` directly instead
— exercises the same drop handler, but not real OS-level drag gesture recognition), Angle/Rectangle ROI/Ellipse
ROI/Probe individually (only Length was drawn), calibration fallback for wrapped JPG/PNG (no PixelSpacing tag),
3x3 layout, resizing a cell after measurements exist, more than 2 series linked by scroll at once.

## NOT verified
Real GPU rendering, Firefox/Safari, studies of 500+ slices (memory, load time), native colour DICOM (RGB/YBR/palette),
multi-frame and enhanced CT/MR (code path exists, no test file), JPEG lossy and HTJ2K, DICOMDIR, very large PDFs
(capped at 100 pages), layout on narrow screens (series list is simply hidden below 820px).

## Roadmap
**Phase 2 — layouts and measurements. Done**, see above.

**Phase 3 — import/export and header editing.** Import zips and DICOMDIR. Export DICOM, PNG/JPG (with or without burned-in
annotations) and zip. Header editing behind an explicit admin mode: log every change (tag, old, new, timestamp), an
option to regenerate UIDs, and an anonymization profile. Write edits with dcmjs and re-register the blob.
DICOMweb (QIDO/WADO/STOW) is a later option for talking to a real PACS.

**Phase 4 — hanging protocols.** JSON schema: matching rules (modality, body part, laterality, series description,
prior vs current), a layout, ordered display-set assignments, per-cell defaults (W/L, orientation). A builder that
saves the current arrangement, and a matcher that picks the best protocol when a study loads.

## Conventions
Plain sentence-case UI copy; errors say what happened and how to fix it. The viewport stays true black on purpose.
Overlay text is pale yellow. Keep the UI keyboard-accessible (visible focus, `aria-*` on toggles).
