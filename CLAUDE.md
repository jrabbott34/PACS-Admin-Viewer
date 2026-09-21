# DICOM Viewer — project context

Local-first, browser-only DICOM viewer. **Not for diagnostic use** (keep the footer disclaimer). No network calls,
no telemetry, no CDN assets: images may contain PHI, so everything stays in the tab. Keep it that way.

## Stack
Vite 8, TypeScript 5.9, Cornerstone3D 5.10.7 (`core`, `tools`, `dicom-image-loader`), dcmjs 0.52, dicom-parser,
pdfjs-dist 6 (**legacy build**). Plain DOM/CSS, no UI framework.

## Commands
`npm install`, `npm run dev` (5173), `npm run build` (tsc + vite build), `npm run preview`.

**Double-click launchers** for non-terminal users: `launch.bat` (Windows) and `launch.command` (macOS/Linux).
Both: install deps on first run if `node_modules` is missing, kill whatever's already on port 5173 (fixes the
"port keeps drifting to 5174, 5175…" confusion from running `npm run dev` twice without stopping the first),
start `vite --port 5173 --strictPort` (fails loudly instead of silently picking a different port, since the
kill step above already guarantees 5173 is free), wait ~3s, then open the browser to the fixed URL. Verified:
running the launcher twice in a row (simulating "forgot the first one was still open") correctly frees the
port and starts fresh on 5173 both times, rather than drifting.

## Layout
| File | Role |
| --- | --- |
| `src/cs.ts` | One-time init of Cornerstone, tools and the DICOM loader |
| `src/ingest.ts` | Sniffs files, parses headers (dicom-parser), groups into series, sorts slices, folder drop helpers |
| `src/wrap.ts` | JPG/PNG/etc. and PDF pages -> in-memory DICOM Secondary Capture (via dcmjs) |
| `src/presets.ts` | `CT_PRESETS` window/level presets (shared data, no Cornerstone dependency) |
| `src/viewport-cell.ts` | `ViewportCell`: one stack viewport's load/scroll/W-L/presentation state |
| `src/layout.ts` | `LayoutManager`: shared RenderingEngine + one global ToolGroup, the grid of cells, active-cell tracking, layout presets, link-scroll, measurement-tool clearing |
| `src/header.ts` | dcmjs-based tag reader/editor: the searchable header panel, admin edit mode, change log, regenerate-UID |
| `src/export.ts` | Export DICOM (zip), export the active cell's frame as PNG/JPG, anonymize-and-export a series |
| `src/persist.ts` | IndexedDB-backed local library: save/load/clear blobs, `requestPersistence`, `estimateUsage` |
| `src/icons.ts` | Hand-authored inline SVG icon set (no CDN); `icon()`, `layoutIcon()` (draws an actual rows x cols grid), `fillIcons()` |
| `src/flyout.ts` | `createFlyout(trigger, panel)`: generic "explode down" popover (menu, layout picker, tool picker) |
| `src/main.ts` | DOM wiring: toolbar, flyouts, series list, thumbnails, per-cell overlays, drag/drop, shortcuts |
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

## UI: flyouts and icons (post-phase-2 redesign)
The toolbar was reworked from a row of always-visible text buttons into three "explode down" flyouts plus a
compact row of icon buttons, using `createFlyout()` (`src/flyout.ts`) and the icon set in `src/icons.ts`:

- **Menu** (`#menu-trigger` / `#menu-panel`, hamburger icon): Import (Open files/folder, wired to the real file
  inputs), Export and Anonymize (disabled, `title="Coming in phase 3"` — these are real roadmap items, not
  decoration; wire them up when phase 3 lands instead of adding new menu entries).
- **Layout** (`#layout-trigger` / `#layout-panel`): a 3-column grid of the six `LAYOUT_PRESETS`, each rendered
  with `layoutIcon(rows, cols)` — the icon is generated from the actual preset, not a static asset, so it can't
  drift out of sync.
Tool selection (`[data-tool]`) is **not** a flyout — see "Tool selection is always-visible" below, which
superseded the original hidden-behind-a-dropdown design after real users couldn't find it twice in a row.

The Layout trigger button shows the *current* layout's icon and label — updated in `refreshToolbar()` every
time `layout.onChange` fires, from `layoutIcon(layout.layoutRows, layout.layoutCols)`. `[data-layout]` buttons
are generated (not static HTML) and carry `role="radio"`/`aria-checked`.

Static toolbar/menu icons are placeholders in `index.html` (`<span data-icon="...">`) filled once by
`fillIcons()` at the top of `wire()`. Dynamically generated buttons (Tools/Layout flyout items) call `icon()`/
`layoutIcon()` directly instead, since there's no static placeholder to fill.

Palette: cool slate background with a sky-blue accent (`--accent: #38bdf8`), replacing the original warm-gold
theme — same CSS custom property names in `style.css`, just different values, so component rules didn't need
touching. `--chrome-3` was added for flyout item hover state.

**Verified**: headless Chromium — menu/layout/tools flyouts open and show correct content; picking a layout or
tool closes its flyout and updates the trigger's icon/label; clicking outside an open flyout closes it; the
existing `tests/e2e/*.py` suite (unmodified) still passes against the new toolbar, confirming no functional
regression from the reskin. **Not verified**: real mouse hover/focus states, narrow-screen wrapping of the new
toolbar groups, screen reader behavior of the flyouts (aria-hidden/aria-expanded are set, but not tested with
an actual AT).

## Import/export and header editing (phase 3)

**Import**: `ingest()` (`ingest.ts`) now calls `expandArchives(files)` first. Any `.zip` (sniffed by extension or
`PK` magic bytes, not just extension) is unzipped in-browser with `fflate`'s `unzipSync` and its entries spliced
back into the file list — recursively, so a zip inside a zip works too. `__MACOSX/` junk and `._*` AppleDouble
files are filtered out. **DICOMDIR is not specially parsed** — a DICOMDIR file itself has no pixel data, so it's
just reported as skipped, same as any other non-image file; every DICOM file *loose in the same archive* still
gets read from its own header exactly like a normal folder drop, so the net result is correct even without
walking the DICOMDIR directory-record tree. This was a deliberate scope cut, not an oversight: DICOMDIR parsing
would only change ordering/efficiency, not correctness, given `ingest()` already derives series/study structure
per-file.

**Export** (`export.ts`), all from the Menu, all scoped to the **active cell's series**:
- `exportSeriesDicomZip`: zips every instance's current blob (original, or header-edited if one exists — see
  below) and downloads it, no re-encoding.
- `exportCellImage`: composites the active cell's rendered pixel canvas (`ViewportCell.getCanvas()`) with the
  Cornerstone annotation SVG layer (`cell.element.querySelector('svg.svg-layer')`, cloned, serialized, drawn via
  an `Image` onto an offscreen canvas) and downloads a PNG or JPG. Both current menu entries burn annotations in;
  `exportCellImage`'s `burnInAnnotations` parameter already supports `false` for a future "without annotations"
  menu entry, just not wired to the UI yet.
- `anonymizeSeriesAndExport`: works on **copies** — reads each instance's current blob, blanks a fixed list of
  identifying tags (`ANON_TAGS`: PatientName, PatientID, PatientBirthDate, addresses, physician names,
  AccessionNumber, StudyID, StationName — PatientSex/Age deliberately left alone, they're not direct
  identifiers), assigns a fresh SOPInstanceUID, zips and downloads. **Never touches the loaded series or the
  live `library`** — anonymizing is purely an export-time transform, so it can't accidentally corrupt what's on
  screen or drift the series list out of sync with what Cornerstone has cached.

**Header admin editing** (`header.ts` + wiring in `main.ts`) is deliberately **not** wired through Cornerstone's
imageId/stack system at all, on purpose: a header-only edit doesn't change pixel data, so reloading the stack
(`cell.load()`) to pick it up would reset zoom/pan/W-L for no reason, and would need re-keying `library.series`
(keyed by UID) if a UID tag changed. Instead:
1. `HeaderPanel` keeps the parsed `DicomDict` (`this.msg`, from `DicomMessage.readFile`) alive across edits. An
   edit calls `msg.upsertTag(tag, vr, value)`, re-renders its own table from the mutated dict, appends a log
   entry (`{time, tag, name, oldValue, newValue}`, session-only, never persisted), writes `msg.write()` to a new
   `Blob`, and fires `onCommit(blob, sourceKey)` — `sourceKey` is the imageId `show()` was called with, captured
   at edit time, not re-derived from "whatever's active now".
2. `main.ts`'s `onCommit` handler stores the blob in `library.edited` (`Map<baseImageId, Blob>` — keyed without
   the `?frame=` suffix, so every frame of a multi-frame object shares one edited blob), finds the owning
   series via `findInstanceByImageId`, and calls `refreshSeriesSummary` to re-derive the series' display fields
   (patient/study/series text) from the edited blob via `dicom-parser`, then re-renders the series list.
3. Every blob lookup that should honor edits — the header panel, `Export DICOM`, `Anonymize & export` — goes
   through `resolveInstanceBlob(imageId)` (checks `library.edited` first, falls back to `wadouri.fileManager`)
   instead of reading `wadouri.fileManager` directly.

Editable VRs are an explicit allow-list (`EDITABLE_VRS` in `header.ts`): `PN, LO, SH, ST, LT, UT, CS, DA, TM,
DT, AS` — free text and dates only. **`UI` is deliberately excluded**: StudyInstanceUID/SeriesInstanceUID edits
aren't supported at all (would require re-keying `library.series`, a Map keyed by SeriesInstanceUID), and
SOPInstanceUID only changes via the dedicated **Regenerate UID** button (`newUid()` from `wrap.ts`, same UID
generator used when wrapping JPG/PNG/PDF), which also updates the file-meta `MediaStorageSOPInstanceUID` to
match. Sequences and binary/numeric VRs stay read-only — a wrong-shaped value for those could make the file
unreadable elsewhere in ways a text field never would.

**Verified** (headless Chromium): zip import (5 DICOM + 1 JPG, with `__MACOSX/` junk correctly filtered) via the
file input; Export DICOM produces a zip of valid Part-10 files; Export PNG produces a real non-empty image;
Anonymize & export produces a zip whose bytes no longer contain the original PatientName; editing PatientName
in the header panel updates the table, the series list's study title, and the change log immediately, and the
edit is reflected in a subsequent DICOM export; Regenerate UID changes SOPInstanceUID and logs it; the full
pre-existing `tests/e2e/*.py` suite (unmodified) still passes, confirming none of this broke phase 1/2. **Not
verified**: multi-frame objects sharing one edited blob across frames (no multi-frame sample file exists yet —
see the general NOT-verified multi-frame gap below), editing a JPG/PNG/PDF-wrapped Secondary Capture's header
(should work the same way since it's still a real DICOM object, just untested), very large series export
(zipping is synchronous and in-memory — no chunking/streaming), anonymizing a series with hundreds of instances
(performance untested).

## Tool selection is always-visible, not a flyout
The original phase-2 redesign put all nine `PrimaryTool`s behind a single "Tools" flyout (icon + current
label + caret, click to expand a 3x3 grid). In practice a real user opened the app twice and never found the
measurement tools at all — a dropdown whose trigger just shows "Window/Level" doesn't read as "click me for
more tools" at a glance. That flyout is gone. Tool selection is now two always-visible, always-labeled
segmented button groups directly in the toolbar (`index.html`, static markup, `class="tool-btn"`,
`data-tool="..."`, `data-icon="..."`):
- **Navigate** (`role="radiogroup" aria-label="Navigation tool"`): Scroll, W/L, Pan, Zoom.
- **Measure** (`role="radiogroup" aria-label="Measurement tool"`): Length, Angle, Rect, Ellipse, Probe.

Each button is icon + short visible text label (not icon-only — the whole point is that it can't be missed),
`.tool-btn` styled at the standard 28px toolbar-button height so the row doesn't jump around, `.segmented`
giving each group a connected-pill look (revived from the pre-flyout design, since nothing else needed it
until now). `main.ts` wiring is back to the simple pre-flyout pattern too: a plain
`document.querySelectorAll('[data-tool]')` click-binding loop (no panel generation, no `createFlyout` call),
and `refreshToolbar()` toggles both `.active` (for the `button.active` accent-highlight CSS rule) and
`aria-checked` on whichever button matches `layout.primaryTool`. `TOOL_META` (icon/label/tooltip lookup) is
gone from `main.ts` — with the buttons hand-written in HTML there was nothing left to generate them from.

If tool selection needs a flyout again for space reasons (e.g. a much smaller viewport), the trigger must show
more than the current tool's name to read as clickable — a visible "Tools" word plus the icon, not just
whatever's currently selected — or it will regress to the same discoverability problem.

**Probe on CT already reports Hounsfield units** — no work needed. Cornerstone's `ProbeTool` calls
`getPixelValueUnits(modality, ...)` internally, which returns `'HU'` for `modality === 'CT'` (from the image's
resolved DICOM metadata) and appends it to the displayed value automatically. Verified: probing the synthetic
CT phantom (`RescaleSlope=1`, `RescaleIntercept=0`) rendered "44.0 HU" in the annotation text. This only works
if the metadata provider resolves `generalSeriesModule.modality` correctly for the imageId, which it does here
(confirmed by the same test) — if a future change to the legacy-metadata-provider workaround (gotcha #1) ever
breaks metadata resolution, this is the first symptom that would show it.

## Splash screen
`index.html` has a `#splash` overlay (title "PACS Admin DICOM Viewer", a `.splash-byline` ("by Jason Abbott"),
an inline-SVG scan/crosshair motif — no CDN, same rule as everywhere else — and a status line mirroring
`setStatus()`) shown from first paint, full-screen and on top (`z-index: 100`, no `pointer-events: none`, so it
genuinely blocks interaction with the app underneath, not just visually covers it).

**The splash does not auto-hide.** It originally faded out automatically once `main()` finished; changed to a
manual gate on request (the user wanted to see the app name/branding, not have it flash past). Once `main()`
succeeds, `revealSplashOpen()` un-hides `#splash-open` ("Open Viewer") — `hideSplash()` only runs when that
button is clicked (`{ once: true }` listener). On a `main()` failure the button is never revealed and the
splash stays up with the "Failed to start: …" message, instead of leaving a half-built, non-functional page
exposed underneath with no explanation.

**This means the app is not interactive until the button is clicked — automated tests must click it.** Every
`tests/e2e/*.py` script now does `pg.click("#splash-open")` immediately after the
`window.__viewer !== undefined` wait (the button is already un-hidden by that point in `main()`'s execution
order — `revealSplashOpen()` runs before `window.__viewer` is assigned). Forgetting this makes every subsequent
`.click()` on the underlying page hang for the full 30s Playwright timeout with "intercepts pointer events"
pointing at `#splash` in the call log — that exact symptom means this, not a real bug in whatever was clicked.
Verified: splash present in the raw HTML before any script runs and still present (with the button visible)
after `window.__viewer` exists; clicking the button removes it; the full `tests/e2e/*.py` suite passes with the
click added.

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
9. **`viewport.setViewPresentation({ flipHorizontal: false })` is a no-op when already flipped.** Same family of
   bug as #2, different symptom: Cornerstone's own `setViewPresentation` correctly detects the target differs
   from the current flip and calls its internal `flip()`, but that internal method only toggles when the flag
   is *truthy* — it treats the argument as "flip now", not "set to this value" — so requesting `false` calls
   `flip({ flipHorizontal: false })`, which is falsy and does nothing. A flip button wired straight to
   `setViewPresentation` can turn a flip on but never back off with a second click. `ViewportCell.flip()`
   bypasses `setViewPresentation` for this and calls the viewport's `flip()` toggle directly (always `true` —
   it's inherently a toggle, so "set to false" isn't a concept it needs), verified by a pixel round-trip: flip
   twice and diff against the un-flipped screenshot.
10. **Ellipse ROI and Angle need a different gesture than Length/Rectangle/Probe, by Cornerstone's own design —
    not a bug, but easy to mistake for one (a user reported "measuring doesn't work" and this was the actual
    cause).** Length and Rectangle ROI are corner-to-corner: the drag start and end become two opposite corners
    of the shape, so `width = |dragDeltaX|`. **`EllipticalROITool._dragDrawCallback` treats the drag start as
    the ellipse's *center*, not a corner** — `dX`/`dY` are computed as the distance from that start point to
    the current mouse position and used directly as `rx`/`ry` (the radius), so a corner-to-corner drag the same
    size as a Rectangle drag produces an ellipse roughly 2x too big in each dimension (confirmed: read the
    library source down to `drawEllipseByCoordinates.js`, where `radiusX = w/2` is computed correctly from the
    4 handle points — the bug, if it is one, is upstream in how those points get set during the drag, not in
    the rendering math). **AngleTool is a genuine two-step gesture**: `addNewAnnotation` creates a 2-point line
    from the first drag, then `_endCallback` checks `angleStartedNotYetCompleted && points.length === 2` and
    deliberately does *not* finish — it needs a **second click** afterward to place the third point and
    complete the angle. A single drag (what Length/Rectangle expect) leaves an incomplete, stuck-looking
    annotation. Neither of these needed a code fix — both work correctly once you know the gesture — but they
    do need *telling* the user, since nothing about the cursor or the button communicates it. `TOOL_HINTS` in
    `main.ts` shows a status-bar message (not just a toolbar tooltip — by the time someone's dragging on the
    image they're not hovering the button anymore) when either tool is selected: "click the center, then drag
    outward" for Ellipse, "drag the first line, then click again to place the second" for Angle. Verified: with
    the correct gesture, Ellipse renders at the expected size (`rx`/`ry` matching the actual drag distance) and
    Angle completes and adds a text label on the second click.
11. **`tests/e2e/e2e_comp.py` had two stale issues found while fixing it for the splash gate, both now fixed.**
    It targeted `#viewport`, an id that hasn't existed since the phase-2 layout refactor introduced
    `#viewport-grid` and per-cell `.cs-el` divs — this test was never re-run after that refactor, so it silently
    bit-rotted. Fixed to `.cell.active`. That surfaced a second, more general gotcha: **Playwright's
    `locator.screenshot()` captures the visual region at that element's bounding box, not just that element's
    own DOM subtree** — a positioned sibling that visually overlaps (like the per-cell overlay text, a sibling
    of `.cs-el` within `.cell`, not a descendant) shows up in the screenshot regardless of DOM nesting. The
    compressed-transfer-syntax pixel-identity check was comparing overlay text (different SeriesDescription per
    variant: "RLE" vs "J2K" vs "Chest phantom 5mm") as if it were image content, producing false mismatches.
    Fixed by cropping to the central 70% of the screenshot (`im.crop((w*0.15, h*0.15, w*0.85, h*0.85))`),
    clear of all four corners' overlay text, before diffing. Worth remembering for any future visual-regression
    test: screenshot a tighter element, or crop after the fact, whenever overlapping siblings could contaminate
    the comparison.

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

## Local library (IndexedDB persistence)
Added after phase 3, outside the original phase numbering: everything imported now survives closing the tab,
via `src/persist.ts` (a small IndexedDB wrapper — one object store, blobs keyed by SOPInstanceUID). This was a
deliberate, scoped choice over the two bigger alternatives — a real Query/Retrieve client (nothing to query
against yet; the user has no PACS/DICOMweb server) and a local PACS server with its own database and background
process (real infrastructure, not justified by anything asked for so far). IndexedDB gets "still there next
time" with zero new setup and no service to run, without ruling either bigger option out later.

- `ingest()` takes `{ persist?: boolean }` (default `true`); `register()` calls `saveBlob(sop, blob)`
  (fire-and-forget) for every newly-registered instance when persisting. Startup restore (`restoreLibrary()` in
  `main.ts`) re-ingests every saved blob through the exact same `ingest()`/`loadFiles()` path a fresh drop would
  use, with `persist: false` (so restoring doesn't re-save what was just loaded from storage) — this reuses all
  existing sniffing/grouping/sorting logic instead of duplicating it, and means a restored library looks and
  behaves identically to a fresh import.
- Header edits write through too: `header.onCommit` in `main.ts` calls `saveBlob(instance.sop, blob)` alongside
  the existing `library.edited` in-memory override, so an edited PatientName (for example) is still edited
  after a reload, not just for the rest of the session.
- **Clear local library** (Menu → Local library) clears IndexedDB then calls `location.reload()` — deliberately
  *not* hand-rolled in-place viewport clearing. Cornerstone's `StackViewport.setStack()` isn't meant to be
  pointed at an empty array (reads `imageIds[currentImageIdIndex]` unconditionally, which would be `undefined`),
  so reusing the exact same clean-slate path a fresh launch takes is both simpler and safer than trying to
  reset five cells' viewport state by hand.
- `requestPersistence()` (best-effort `navigator.storage.persist()`) is called once on startup so the browser
  is less likely to evict the library under storage pressure. `estimateUsage()` exists in `persist.ts` but isn't
  wired into any UI yet — a natural next step if someone wants to see how much space the library is using.

**Verified** (headless Chromium, using a persistent browser context so IndexedDB survives across page reloads
the way a real browser profile would): import → reload the page → the same series are still in the list;
editing a header tag (PatientName) → reload → the edit is still there, both in the table and the series list's
study title; Clear local library → confirmed empty afterward with a clean "Ready" status; zero console errors
throughout. The full pre-existing `tests/e2e/*.py` suite (each launches its own fresh, non-persistent browser
context, so no cross-test contamination) still passes. **Not verified**: storage quota exhaustion behavior
(what happens when the browser refuses to store more), a library large enough that `restoreLibrary()`'s startup
re-ingest is slow, IndexedDB behavior in a private/incognito window (typically ephemeral or blocked by design —
the library just won't survive there, which is correct, not a bug to fix).

## Cell interaction: swap-by-drag, maximize, and the series panel
A batch of direct usability requests, all in `layout.ts` / `main.ts` / `style.css` unless noted:

- **Active-cell color** is its own token, `--select: #2dd4bf` (a cool teal), separate from `--accent`
  (`#38bdf8`, sky-blue) — they used to be the same color, and the active-cell border didn't stand out enough
  against all the other accent-colored chrome (buttons, highlights). `.cell.active` uses a 3px inset
  `box-shadow` plus a soft outer glow, not a `border` (a real border would shift layout by its width; a
  `box-shadow` doesn't).
- **Cell-to-cell drag** (drag one viewport's series onto another) reuses the same `text/x-series-uid` payload
  the series-list-to-cell drop already used, plus a second MIME type, `text/x-cell-index`, set only when the
  drag originates from a cell — that's how the drop handler in `ensureCell()` tells "drag from the list"
  (assign, non-destructive) apart from "drag from another cell" (`swapCells()`, see below).
  **The drag handle is the per-cell overlay text (`.ov` elements), not the whole cell wrapper.** Making the
  whole `.cell` draggable was considered and rejected: HTML5 drag-and-drop and Cornerstone's own mouse-based
  tool interactions (drawing a measurement is also a mousedown-drag-mouseup gesture) would fight over the same
  mousedown, breaking tool drags inside cells. The overlay text corners are a safe, separate hit target
  (`pointer-events: auto` layered on the otherwise `pointer-events: none` `.cell-overlay`), styled
  `cursor: grab`.
  `swapCells(sourceIndex, targetIndex)`: if the target already has a series, they trade places; if the target
  is empty, the source's series is copied there and the source keeps showing it too — a cell is never left
  empty by a drag, for the same reason `clearLocalLibrary()` reloads the page instead of hand-clearing a
  viewport (gotcha: Cornerstone's `StackViewport.setStack()` isn't meant to be pointed at an empty array).
- **Double-click to maximize/restore** (`toggleMaximize()`/`setMaximized()`): interpreted "double-click and go
  1x1 in a pop-out window" as an in-page maximize, not a literal second OS window — a second window would need
  to either re-initialize Cornerstone in a new document or proxy rendering across `window.opener`, both far
  more machinery than "focus on this one image" actually needs, and double-click-to-maximize/restore is a
  well-established pattern (video calls, image viewers) that reads correctly without documentation.
  Deliberately **CSS-only**: `.viewport-grid.maximized .cell:not(.maximized) { display: none }` and
  `.cell.maximized { grid-column: 1/-1; grid-row: 1/-1 }` — hides every other cell and stretches the target to
  fill the grid, without calling `setLayout()` or touching any series assignment. This means restoring is just
  removing the classes; nothing was ever reloaded or reassigned, so there's no risk of losing what was in the
  other cells (the same "don't touch Cornerstone's stack state for a non-pixel change" principle as the header
  editor and `clearLocalLibrary`). Picking a new layout while maximized un-maximizes first
  (`setLayout()` calls `setMaximized(null)` before applying the new grid), so the two features can't leave the
  UI in a confusing combined state.
- **Resizable/collapsible series panel**: `#app`'s grid uses `grid-template-columns: var(--series-w, 248px) ...`;
  `main.ts` sets that CSS custom property directly (`document.documentElement.style.setProperty`) from a
  `mousedown`/`mousemove`/`mouseup` drag on `#series-resize` (an absolutely-positioned 6px handle at the panel's
  right edge — `.series` needed `position: relative` to anchor it) clamped to `[SERIES_MIN_W, SERIES_MAX_W]` =
  `[160, 480]`. A new toolbar icon button (`#btn-toggle-series`, the "sidebar" icon) sets `--series-w: 0px` and
  a `.collapsed` class instead of hiding via `hidden`, so the same variable drives both resize and collapse and
  there's only one code path to keep correct. Collapsing remembers the pre-collapse width (`seriesWidth` isn't
  reset), so un-collapsing restores exactly where it was, not the 248px default.
  **Gotcha hit while building this**: the series list content (`renderSeriesList()`'s target) had to move from
  the outer `#series` aside into a new inner `#series-list` div, because `renderSeriesList()` calls
  `seriesEl.replaceChildren()` on every refresh — if that target were still the outer element, it would wipe
  out the resize handle (a sibling-in-waiting) on every series list update. `main.ts`'s `seriesEl` constant now
  points at `#series-list`; a separate `seriesPanelEl` constant points at the outer `#series` for the
  resize/collapse logic.
  A **second gotcha**, caught by testing (not by reasoning about it in advance): giving `.series` a bare
  `position: relative` (needed as the containing block for the resize handle) made the Layout flyout panel
  render *underneath* the series panel when open over it — Playwright's `.click()` failed with
  `#series-list ... intercepts pointer events`. Investigated and it turned out to be a false alarm from the
  test script itself (it tried to click a layout preset button without first clicking `#layout-trigger` to
  open that flyout — an invisible, `pointer-events: none` target correctly falls through to whatever's
  actually visible underneath it, which was the series panel). Worth remembering next time a flyout-related
  test fails with a "some other element intercepts pointer events" message: check whether the flyout was
  actually opened first before suspecting a real z-index/stacking bug.

**Verified** (headless Chromium): the active cell's `box-shadow` computes to the teal `rgb(45, 212, 191)`;
dragging one cell's series onto another (synthetic `DragEvent('drop', …)` with both MIME types, same technique
as the series-list-to-cell drag test) correctly swaps two populated cells' series; double-click maximizes
(`maximizedIndex` set, `.maximized` class present) and a second double-click restores it
(`maximizedIndex → null`); dragging `#series-resize` changes `--series-w` by the drag distance (clamped);
clicking the toggle button collapses to `0px` and restores the previous (resized) width, not the default. The
full pre-existing `tests/e2e/*.py` suite still passes.

## Roadmap
**Phase 2 — layouts and measurements. Done**, see above.

**Phase 3 — import/export and header editing. Done**, see above.

**Local library persistence. Done**, see above — added between phases 3 and 4 in response to a direct request,
not part of the original plan.

**DICOMweb (QIDO-RS/WADO-RS) Query/Retrieve** — talking to a real PACS instead of local files — is still a
later option, not started, and explicitly *not* recommended until there's an actual server to point it at.
Revisit if the user gets access to one.

**A local PACS server** (disk storage + a real database + a background service, enabling multi-device access
and true C-FIND/C-MOVE-style retrieval) was considered and explicitly deferred in favor of the much lighter
IndexedDB approach above. Revisit only if a real need for multi-device/multi-user access or archival-scale
storage shows up — nothing so far has needed it.

**Phase 4 — hanging protocols.** JSON schema: matching rules (modality, body part, laterality, series description,
prior vs current), a layout, ordered display-set assignments, per-cell defaults (W/L, orientation). A builder that
saves the current arrangement, and a matcher that picks the best protocol when a study loads.

## Conventions
Plain sentence-case UI copy; errors say what happened and how to fix it. The viewport stays true black on purpose.
Overlay text is a near-white light gray (`--overlay`) — an earlier cyan-tinted version read as "highlighted
text" against the black background and was reverted; don't reuse the accent color for overlay text. Keep the UI
keyboard-accessible (visible focus, `aria-*` on toggles).
