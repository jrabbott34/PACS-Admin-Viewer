# DICOM Viewer — project context

Local-first DICOM viewer. **Not for diagnostic use** (keep the footer disclaimer). No telemetry, no CDN assets:
images may contain PHI. **The browser build makes no network calls**; everything stays in the tab. Keep it that way.
The one exception is inside the Windows desktop shell (`desktop/`, see "Windows desktop shell" below). There,
`src/host-bridge.ts` fetches only host-intercepted `https://*.pacs-viewer.example` URLs, which the shell answers
itself and which never reach the real network from the page. That module is inert outside WebView2.

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
| `src/host-bridge.ts` | Viewer half of the desktop-shell bridge (`desktop/BRIDGE.md`); no-op in a browser tab |
| `desktop/` | Windows shell (WPF + WebView2, .NET 8), Orthanc client, MSI; see `desktop/README.md` |
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
12. **`ToolGroup.setToolActive()` merges bindings, it never drops one — a real bug in our own
    `LayoutManager.applyBindings()`, not a Cornerstone design quirk like #9/#10.** Reported as: measurement
    tools (Length, Ellipse, etc.) work the first time, but after zooming, panning, or clicking Reset, they stop
    responding to drags — the tool button still shows selected/active, but dragging on the image draws nothing.
    Root cause, confirmed by reading `@cornerstonejs/tools`' `ToolGroup.js`: `setToolActive(name, {bindings})`
    computes `[...prevBindings, ...newBindings]` and dedupes — it only ever **adds** bindings, never removes
    ones missing from the new list. `applyBindings()` loops over every tool on each `setPrimaryTool()` call and
    calls `setToolActive` with a bindings array sized for *that* call (e.g. Zoom gets `[Secondary, Primary]`
    while it's primary, then just `[Secondary]` once something else is selected) — but because Cornerstone only
    adds, Zoom's old Primary binding never actually goes away. After a few tool switches, Zoom, Pan and
    StackScroll all end up simultaneously `Active` and bound to the left mouse button alongside whichever
    measurement tool is actually selected, and Cornerstone's own dispatch no longer reliably routes the drag to
    the intended tool. `setToolPassive()`, by contrast, *does* actually clear bindings — but only the ones
    matching `getDefaultPrimaryBindings()` unless you pass `{ removeAllBindings: true }`, which filters the
    tool's binding list down to empty unconditionally. Fix: `applyBindings()` now calls
    `this.toolGroup.setToolPassive(name, { removeAllBindings: true })` for every tool *before* recomputing and
    (if non-empty) reactivating its bindings, so every tool starts each pass from a genuinely clean slate
    instead of accreting stale bindings across tool switches. Confirmed via `tg.toolOptions` dumps in headless
    Chromium: before the fix, `Zoom`'s bindings grew to `[2, 1]` and stayed there even after Zoom stopped being
    primary; after the fix every non-primary tool's bindings match exactly what `FIXED_BINDINGS` says it should
    have, with no accumulation across an arbitrary number of switches (verified with 15 randomized 3-tool switch
    sequences, each followed by a successful Length draw). Also verified the fix doesn't regress the
    always-available fixed bindings: right-drag zoom and W/L drag both still work regardless of which tool is
    primary.

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
  `[160, 480]`. The toggle button (`#btn-toggle-series`, the "sidebar" icon) sets `--series-w: 0px` and a
  `.collapsed` class instead of hiding via `hidden`, so the same variable drives both resize and collapse and
  there's only one code path to keep correct. Collapsing remembers the pre-collapse width (`seriesWidth` isn't
  reset), so un-collapsing restores exactly where it was, not the 248px default.
  **The toggle button's position went through two iterations, both on direct request.** First it lived at the
  far end of the toolbar's icon row (original design). Moved to `position: absolute` inside `.stage`, flush
  against the sidebar's edge, so it read as attached to the panel it controls rather than a generic toolbar
  button — reasoned to be more discoverable, but the user didn't spot it there and reported the button as
  missing entirely (it was rendering correctly; headless testing confirmed it in every layout/state, so this
  was a real "user didn't see it," not a bug) until told explicitly where to look. Moved again, per direct
  instruction, to sit right beside `#menu-trigger` inside `#menu-flyout` (`index.html`) — an ordinary toolbar
  `<button id="btn-toggle-series" class="icon-btn">` again, now next to the hamburger menu specifically because
  that's the other control that governs what's visible/available around the viewport, so grouping them reads as
  "viewer chrome" rather than either floating on the image or lost at the end of a long icon row. The lesson:
  for a toggle whose whole job is to be find-able, a conventional toolbar position beats a cleverer one users
  have to be told about — same lesson as the tool-selection flyout-to-always-visible change above, applied to
  a single button instead of a whole tool group. `wireSeriesPanel()`/`applySeriesPanel()` in `main.ts` still
  select the button by id, so none of the collapse/resize/aria wiring changed across either move.
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
- **"Reset all" button** (`#btn-reset-all`, `LayoutManager.resetAll()` in `layout.ts`): the existing `#btn-reset`
  only ever touched `layout.activeCell` (by design — most toolbar actions are per-cell), which stopped being
  enough once a study is spread across a 2x2/3x3 layout and the user wants every viewport back to its default
  window/level, zoom, pan, flip and rotation in one click, not one cell at a time. `resetAll()` is just
  `Promise.all(this.visibleEntries().map(e => e.cell.resetView()))` — `ViewportCell.resetView()` already no-ops
  on a cell with no series loaded, so it can run over every visible entry unconditionally, populated or not.
  Styled as a `.tool-btn` (icon + visible "Reset all" label) rather than joining its icon-only neighbors
  (`#btn-reset`, invert, flip, rotate, etc.) as a bare icon — those are all single-cell actions where a mistake
  is a one-cell undo, but this one touches every viewport in the layout at once, so it gets the same
  can't-be-missed treatment as tool selection rather than relying on a tooltip alone to disambiguate it from
  plain "Reset". Its `disabled` state is intentionally decoupled from the other per-cell action buttons in
  `refreshToolbar()` (which all key off whether the *active* cell has a series): it's enabled whenever *any*
  visible cell has a series loaded, since its whole point is to reach cells other than the active one.

**Verified** (headless Chromium): the active cell's `box-shadow` computes to the teal `rgb(45, 212, 191)`;
dragging one cell's series onto another (synthetic `DragEvent('drop', …)` with both MIME types, same technique
as the series-list-to-cell drag test) correctly swaps two populated cells' series; double-click maximizes
(`maximizedIndex` set, `.maximized` class present) and a second double-click restores it
(`maximizedIndex → null`); dragging `#series-resize` changes `--series-w` by the drag distance (clamped);
clicking the toggle button collapses to `0px` and restores the previous (resized) width, not the default;
in a 2x2 layout with two cells independently zoomed away from 1.0×, "Reset all" is disabled with nothing
loaded, enabled once any cell has a series, and one click puts both cells' zoom back to 1.0× in the same pass.
The full pre-existing `tests/e2e/*.py` suite still passes.

## Closing a single study
A direct request: with several patients/exams loaded at once, close just one from the sidebar instead of the
all-or-nothing Menu → Clear local library. A small "×" button (`.study-close`) sits on each study's header row
in the series list (`renderSeriesList()` in `main.ts`), next to the patient/study/date label — study-level, not
per-series, matching the request ("close that study"); a study with several series (DX+CT+MR sharing one
StudyInstanceUID, same as the synthetic sample set) closes all of them together in one click.

**Why this reloads the page instead of hand-clearing in place** (same reasoning as `clearLocalLibrary()`,
scoped down): once a study's blob is gone, any cell currently showing one of its series would need to be reset
to empty, and Cornerstone's `StackViewport.setStack()` still isn't meant to be pointed at an empty array (the
gotcha behind `clearLocalLibrary()`'s reload and `swapCells()`'s never-leave-empty rule). There's no existing
"unassign a cell" method in `LayoutManager` and building one just for this would mean being the first code path
to test that constraint's edge, for a rarely-used action. `closeStudy(studyUid, label)` instead: confirms
(`confirm()`, same destructive-action pattern as Clear local library), deletes just that study's blobs from
IndexedDB via `deleteBlobs()` (new in `persist.ts` — `sops.forEach(store.delete)` inside one transaction, as
opposed to `clearLibrary()`'s whole-store `.clear()`), then reloads. `restoreLibrary()` re-ingests whatever's
left in IndexedDB on the next `main()` run exactly like a fresh launch, so every *other* study reappears intact
— only the closed one doesn't come back. `sopsForStudy(studyUid)` (new in `ingest.ts`) collects the SOPs to
delete; a multi-frame instance's frames all share one SOP (set per source blob, not per frame — see `register()`
in `ingest.ts`), so the result is de-duplicated through a `Set` rather than the series' instances array directly.

**Verified** (headless Chromium, persistent browser context so IndexedDB survives real reloads): closing a
study with two series (DX+CT) removes both and the study group disappears from the list, confirmed again after
a second, fully independent page navigation (not just the immediate post-close reload) — the deletion is
actually persisted, not just reflected in stale in-memory state; with two distinct studies loaded, closing one
leaves the other's series list entry and thumbnails completely intact; declining the confirm dialog leaves the
series list unchanged. The full pre-existing `tests/e2e/*.py` suite still passes.

## Magnify tool and overlay toggle
Two more direct requests, both small additions to the existing tool/toolbar machinery rather than new
subsystems:

- **Magnify** is Cornerstone3D's own built-in `MagnifyTool` (`@cornerstonejs/tools`), not a hand-rolled loupe —
  it already does exactly this: mousedown creates a small magnified sub-viewport that follows the drag and is
  torn down on mouseup, entirely inside the library (`preMouseDownCallback`/`_dragCallback`/`_dragEndCallback`
  in `MagnifyTool.js`). Wired in exactly like every other `PrimaryTool`: registered in `cs.ts`
  (`tools.addTool(tools.MagnifyTool)`), added to the `PrimaryTool` union and `TOOL_NAMES` in `layout.ts`, and a
  `data-tool="magnify"` button in the Navigate segmented group (`index.html`) — no `FIXED_BINDINGS` entry, since
  unlike Zoom/Pan it's only meant to be reachable by deliberately selecting it, not layered under another tool.
  Because it plugs into the same generic `TOOL_NAMES`-keyed loop `applyBindings()` already iterates, gotcha #12
  (stale-binding accumulation) applies here too automatically — no special-casing needed, and confirmed by
  testing Length immediately after a Magnify drag. **Icon note**: `zoom` was already a plain magnifying glass
  glyph, so `magnify`'s icon reuses it with a `+` added inside the lens (same base path, two extra strokes) —
  distinguishable at a glance, and the "Magnify" text label (this app never does icon-only tool buttons, see
  "Tool selection is always-visible" above) removes any remaining ambiguity.
- **Overlay toggle** (`#btn-toggle-overlays`, `O` key) hides the four corner-overlay text blocks (patient/study,
  series, image number, W/L/zoom) across every cell at once, for an unobstructed look at the image or a clean
  screenshot. Deliberately **CSS-only**, the same pattern as double-click-maximize: `.viewport-grid.no-overlays
  .cell-overlay { display: none }`, toggled by a plain `overlaysVisible` boolean in `main.ts` — `refreshOverlays()`
  keeps computing and setting the corner text on every frame exactly as before, the toggle just hides the
  container, so there's no risk of the overlay data going stale or needing to be recomputed on re-enable. Global
  across all cells (like Link scroll), not per-cell — the point is to see the unobstructed grid, not one clean
  cell among cluttered ones. `aria-pressed`/title update directly in the click handler (`applyOverlaysToggle()`),
  matching the series-panel collapse button's pattern rather than routing through `refreshToolbar()`.

**Verified** (headless Chromium): selecting Magnify and holding-and-dragging on a cell creates a
`.magnifyTool` element that's removed again on mouseup; switching to Length immediately afterward and drawing
still works (no lingering tool-binding contamination, per gotcha #12); toggling overlays off hides all four
corner text blocks (`.ov.tl` etc. no longer visible) and sets `aria-pressed="false"`; pressing `O` toggles them
back on and flips `aria-pressed` back to `true`. The full pre-existing `tests/e2e/*.py` suite still passes.

## Cine mode
Auto-play through the active cell's stack. Lives in `ViewportCell` (`play(fps)`/`pause()`/`playing` getter in
`viewport-cell.ts`) rather than `LayoutManager` or `main.ts`, on the same reasoning as invert/flip/rotation:
it's genuinely per-cell state, so it belongs on the object that already owns the rest of a cell's view state.

- **Self-scheduling, not `setInterval`**: each tick is a `setTimeout` that only queues the *next* tick after
  `goTo()`'s promise actually resolves, instead of firing on a fixed clock regardless of whether the previous
  frame finished loading. A raw `setInterval` at, say, 24fps would keep firing every ~42ms even if a frame takes
  longer than that to decode, queuing up overlapping `setImageIdIndex` calls; the self-scheduling loop can't get
  ahead of itself that way — worst case it just runs slower than the requested fps on a slow series, never faster
  or overlapping.
- **Loops**: `(currentIndex + 1) % total`, wrapping back to frame 0 indefinitely rather than stopping at the
  last image — this is what "cine" conventionally means (a looping clip), not a one-shot playthrough.
- **`ViewportCell.load()` calls `this.pause()` first**, so playback can never keep ticking against a stack that
  was just replaced out from under it. This one `pause()` call at the top of `load()` covers every path that
  reassigns a cell's series — `assign()`, `swapCells()`, and (deliberately) `resetView()` too, since `resetView()`
  re-runs `load()` on the same series to reset presentation state. So clicking **Reset** or **Reset all** on a
  playing cell stops its cine — an accepted side effect of reusing the single "safely change the stack" choke
  point rather than adding a second one; `resetView()` passes the current index through, so at least the reset
  doesn't also jump playback back to frame 0.
- **Toolbar**: `#btn-cine` (`Space` key) is styled like every other icon toggle (`aria-pressed`, title text) but
  swaps its actual icon between `play`/`pause` glyphs on state change — the one departure from this app's usual
  "single static glyph, color-highlight for on/off" toggle pattern (link scroll, overlay toggle, sidebar), because
  play/pause is such a globally standard shape-swap convention that using a single static icon would read as
  broken. `#cine-fps` (5/10/15/24/30, default 10) is read at play time; changing it while already playing calls
  `cell.play(newFps)` again, which itself calls `pause()` first, so changing speed mid-playback just restarts the
  timer at the new rate rather than stacking a second loop. Disabled whenever the active cell has no series or
  only one image (`activeSeries.instances.length > 1`) — nothing to animate — checked independently of the
  cine-specific `canPlay` other than reusing `activeSeries`, not folded into the generic `none`-keyed disable
  loop in `refreshToolbar()` the way most single-cell buttons are, since the condition (more than one image) is
  cine-specific.
- **Not built**: cine doesn't auto-pause on manual scroll/wheel/drag interaction with the same cell — if you
  scroll a playing cell by hand, the next cine tick will just overwrite wherever you scrolled to. Accepted as a
  known v1 limitation rather than adding interrupt-detection across every scroll input path (wheel, drag, arrow
  keys, link-scroll) for what's a fairly minor UX rough edge. Also doesn't pause when a playing cell is scrolled
  out of the current layout (e.g. 2x2 → 1x1 hides cell 2) — consistent with how nothing else in this app pauses
  hidden-cell state either (link scroll keeps syncing hidden cells too).
- **Bug found within a day of shipping: "I can't seem to stop it once started."** Root cause wasn't the
  play/pause logic itself (`ViewportCell.play()`/`pause()` were and are correct — a cell playing and paused via
  the same active cell round-trips perfectly, confirmed by headless test). It's that `#btn-cine` and `Space`
  both act on `layout.activeCell` exactly like every other single-cell toolbar action (Reset, Invert, flip,
  ...) — which is fine for those, but cine is the first control whose effect (a background timer) *outlives*
  the moment of clicking it. Start cine on cell A in a multi-cell layout, then click cell B to look at something
  else, and the button and Space now both act on cell B — cell A keeps looping with no remaining way to reach it
  short of clicking back onto that exact cell first, which isn't obvious once you've moved on. Reproduced
  directly: play cell 0 in a 2x2, click cell 1 active, confirm cell 0 is still `playing === true`, confirm
  neither the button nor Space touches it. **Fix, two parts**: (1) `Escape` (`stopAllCine()` in `main.ts`) pauses
  every visible cell's cine unconditionally, regardless of which is active — a panic button that doesn't depend
  on remembering which cell you started it on; (2) the `br` overlay corner (`refreshOverlays()`) now shows
  "▶ Playing (Esc to stop all)" on any cell that's playing, active or not, so a cell left running in the
  background is visibly telling you how to stop it rather than silently looping. Deliberately did *not* make the
  toolbar button itself "smart" about stopping a different, non-active cell's cine — that would give the same
  button two different meanings depending on hidden state, breaking the one rule every other toolbar control in
  this app follows (acts on the active cell, full stop); a dedicated, unconditional shortcut plus a visible cue
  on the cell itself is simpler and doesn't special-case cine's toolbar semantics.

**Verified** (headless Chromium): disabled with nothing loaded and for a single-image series; enabled for a
24-image CT series; clicking Play advances `currentIndex` (confirmed non-zero after a short wait at 24fps) and
sets `aria-pressed="true"`; `Space` pauses it, and the index stops changing while paused; playing for enough
ticks to exceed the frame count wraps back into `[0, total)` and keeps playing rather than stopping; switching
the active cell to an empty one disables the button, switching back re-enables it (still reflecting that
specific cell's own play state, not a global one); loading a different series into a playing cell auto-pauses
it; a cell playing in the background (not active) shows the "▶ Playing" overlay hint and is confirmed still
`playing === true` even after the button/Space target a different cell; `Escape` stops it regardless of which
cell is active, and the index freezes immediately after. The full pre-existing `tests/e2e/*.py` suite still
passes.

## Toolbar preferences (declutter, not access control)
Prompted directly by "admin option for toolbar utilities... or does that get too much into fat client stuff?"
— and the honest answer is yes, for the access-control reading of that question. A static, no-backend,
no-auth browser page has no way to actually *enforce* a restriction: anyone using it can reopen devtools and
flip anything back, so a client-side "admin lock" around tools would be decorative, not a real security
boundary — actively worse than nothing if someone mistook it for one, given the PHI context this whole app is
built around. What's genuinely buildable, and what got built instead, is the other reading: **personal
decluttering**, not permissions. `src/prefs.ts` is a tiny `localStorage` wrapper (`loadHiddenTools()`/
`saveHiddenTools()`, key `pacs-viewer:hidden-tools`) — deliberately separate from `persist.ts`'s IndexedDB
image library, since this is UI preference, not patient data, and the two shouldn't be cleared or exported
together.

- **New flyout** (`#prefs-trigger`/`#prefs-panel`, a "sliders" glyph — chosen over a gear specifically because
  `wl`'s existing icon is already a circle-with-radiating-ticks, which a gear would have looked nearly
  identical to) lists all ten `PrimaryTool`s (Navigate: Scroll/W-L/Pan/Zoom/Magnify; Measure: Length/Angle/
  Rect/Ellipse/Probe) as checkboxes, grouped exactly like the two segmented toolbar groups they control.
  Unchecking one sets `[data-tool="…"] .hidden = true` immediately (`applyToolVisibility()` in `main.ts`) and
  persists the change; every other toolbar action (invert, flip, reset, cine, etc.) stays always-visible for
  now — the tool buttons were the obvious first candidate (ten of them, and a given workflow plausibly never
  touches several), extending this to the icon row is a natural follow-up if wanted, not a limitation of the
  approach.
- **`createFlyout()`'s own panel-click handler only closes on a `<button>` click** (`btn.closest('button')` in
  `flyout.ts`) — checkboxes wrapped in `<label>` don't match, so toggling several tools in a row correctly
  keeps the panel open instead of closing after each click. Worth remembering if a future flyout ever needs
  non-button interactive content: the "closes on inside click" behavior is opt-in per element type, not
  universal.
- **Falls back gracefully if the hidden tool was the selected one**: hiding the currently-active primary tool
  calls `layout.setPrimaryTool()` on the first still-visible tool button rather than leaving the toolbar with
  nothing highlighted and clicks on the image doing nothing until another tool was manually picked.
- **`.tool-btn[hidden] { display: none }`** is declared explicitly in `style.css` rather than relying on the
  native `[hidden]` UA-stylesheet default alone — defensive, since `.tool-btn { display: inline-flex }` is an
  author-stylesheet rule of comparable specificity and this codebase has already hit exactly this class of bug
  once before (thumbnail canvas sizing, gotcha #6).
- **Known minor cosmetic limitation**: `.segmented .tool-btn:first-child`/`:last-child` (the rounded end-caps
  of a segmented group) key off DOM position, not visual position, so hiding the first or last tool in a group
  leaves the new visual end without its rounded corner. CSS has no clean "first non-hidden sibling" selector to
  fix this without `:has()`-based trickery; accepted as-is rather than restructuring the segmented-group CSS
  for a cosmetic-only edge case.

**Verified** (headless Chromium, persistent context so the localStorage preference survives real reloads):
unchecking Probe and Magnify hides both toolbar buttons immediately while the panel stays open; other tool
buttons (Length) remain visible and unaffected; the hidden state survives a full independent page reload, and
the panel's own checkboxes correctly show unchecked when reopened after that reload (not just the buttons);
re-checking a box makes the button reappear; selecting Zoom as the primary tool and then hiding it falls back
to a different, visible tool (`primaryTool` changes and the new tool's button is confirmed visible) rather than
leaving the toolbar in a stuck state. The full pre-existing `tests/e2e/*.py` suite still passes.

## About dialog
Menu → About… (bottom of the flyout, its own section below Privacy) opens `#about-dialog`, a native HTML
`<dialog>` (`.showModal()`) rather than a hand-rolled overlay — free backdrop, focus handling and Escape-to-close
from the browser instead of reimplementing all three. Shows the app name/mark (same motif as the splash
screen), version, "Created by Jason Abbott" (matching the splash byline), and a one-line reminder of the
local-first/not-for-diagnostic-use rule that's already in the footer — repeated here because About is exactly
where someone would look to double check it.

- **Version comes from `package.json`, not a hand-typed string**: `vite.config.ts` reads `package.json` at
  build time and injects it via `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` (ambient type in
  `src/app-version.d.ts`, alongside the existing `dcmjs.d.ts`/`fflate.d.ts` pattern for untyped/generated
  globals). Bumping the version in one place is enough — nothing to remember to update in the dialog too.
- **Gotcha caught by this feature, not before it**: the global `keydown` handler's Escape case (added for
  cine's "stop all" shortcut) called `e.preventDefault()` unconditionally, which — it turns out — also
  suppresses a native `<dialog>`'s own built-in Escape-to-close behavior (`showModal()` normally closes on
  Escape for free; a `preventDefault()` on that same keydown from anywhere else in the page blocks it). First
  manual test of the About dialog: Close button worked, Escape did nothing, dialog stuck open. Fixed by adding
  one early return at the top of the handler — `if (document.querySelector('dialog[open]')) return;` — before
  any of the app's own shortcut handling runs, so a modal dialog gets native behavior (Escape closes it) and
  every toolbar shortcut (arrow keys, tool letters, Space, etc.) correctly stops reaching the viewport behind
  it while the dialog has the user's attention. Worth remembering for any future `<dialog>` usage in this app:
  the app-wide keydown listener needs this same guard, not just a check local to whatever feature adds the
  dialog.

**Verified** (headless Chromium): About opens on menu click and closes the menu flyout in the same click (same
behavior as every other menu item); version text reads "Version 0.1.0" (matching `package.json`); byline reads
"Created by Jason Abbott"; the dialog closes via its Close button; reopened and closed via Escape (confirming
the fix above); the full pre-existing `tests/e2e/*.py` suite and the cine Escape-stop-all behavior both still
pass after the keydown guard change.

## Label tool
Asked about as "spine labeling" — click each vertebra, type its level (C1, L4, etc.). Built the general-purpose
version rather than a spine-specific one: a sixth Measure tool, "Label", is Cornerstone3D's own built-in
`ArrowAnnotateTool` (`@cornerstonejs/tools`), wired in exactly like Magnify was — registered in `cs.ts`
(`tools.addTool(tools.ArrowAnnotateTool)`), added to `PrimaryTool`/`TOOL_NAMES` in `layout.ts`, a
`data-tool="label"` button in the Measure segmented group. Drag from a point to where the text should sit
(same corner-to-corner-style drag as Length, not the center-outward gesture Ellipse needs), release, and the
tool's own default `getTextCallback` pops a native `prompt('Enter your annotation:')` — typing "L4" and
confirming draws an arrow with that text; **canceling or submitting empty removes the just-drawn annotation
entirely** (`ArrowAnnotateTool`'s own `_endCallback`: `if (!label) { removeAnnotation(...); }`), so an aborted
label never leaves an orphaned arrow behind. Added to `MEASUREMENT_TOOLS` alongside the other five, so
**Clear** removes labels too, and it inherited gotcha #12's fix for free (it plugs into the same generic
`TOOL_NAMES`-keyed `applyBindings()` loop everything else does, so no special-casing was needed — confirmed by
drawing a Length measurement immediately after using Label). `TOOL_HINTS` gets an entry for the same reason
Ellipse/Angle do (gotcha #10) — the drag-then-native-prompt sequence isn't guessable from the button alone.
Also added to the toolbar-preferences checklist (`#prefs-panel`) alongside the other five Measure tools, so it
can be hidden the same way.

**Deliberately not built**: auto-incrementing spine levels (pick a starting level, each subsequent click
labels the next vertebra automatically without retyping). That's genuinely useful for a real spine-reading
workflow but is custom sequencing logic on top of this, not something `ArrowAnnotateTool` provides — flagged
to the user as a bigger, separate follow-on rather than folded into this pass. The icon (`label`, a tag/price-tag
outline with a punched hole) is new and distinct from every other Measure icon, chosen over an arrow glyph
specifically because "Label" is a general-purpose free-text tool, not exclusively an arrow-pointing one, even
though the annotation it draws happens to render as an arrow-plus-text.

**Verified** (headless Chromium, `page.on('dialog', ...)` to drive the native `prompt()`): dragging with Label
selected and confirming the prompt with "L4" draws an annotation whose text includes "L4"; **Clear** removes it;
dragging then dismissing (canceling) the prompt leaves the SVG layer completely unchanged — no orphaned arrow;
the status-bar hint shows on selecting Label; drawing a Length measurement immediately after using Label still
works (gotcha #12 regression check); the Label checkbox is present in the toolbar-preferences panel and hiding
it correctly hides the toolbar button. The full pre-existing `tests/e2e/*.py` suite still passes.

## Windows desktop shell (WPF + WebView2) and Orthanc
On direct request, the plan is a **C#/.NET WPF + WebView2 shell around this viewer, not a native rewrite**. The
Cornerstone3D viewer stays the imaging engine, unchanged. The shell owns:
- the native window and packaging (MSI);
- the Orthanc connection;
- credentials;
- logging.

The user's Orthanc is on their LAN and needs a username and password. It is unreachable from the build sandbox.
User docs, architecture and build steps: `desktop/README.md`. The contract: `desktop/BRIDGE.md`.

**How the pieces meet.** The shell and the viewer share nothing but the BRIDGE.md contract, so either can be
replaced without touching the other.
- **Serving the viewer.** The shell serves `dist/`, copied to `viewer\` next to the exe. It uses WebView2's
  `SetVirtualHostNameToFolderMapping` on `https://app.pacs-viewer.example`, which is worker- and WASM-safe.
- **Sending a study.** It posts `load-study` with opaque URLs on `https://data.pacs-viewer.example/instances/{id}`.
- **Answering image requests.** The shell answers those URLs in `WebResourceRequested` by proxying to Orthanc's
  `/instances/{id}/file` with Basic auth added. **Credentials never enter JavaScript.**
- **Loading in the viewer.** The viewer fetches, ingests with `persist: false` (archive PHI is never copied into
  IndexedDB), opens the series and replies `load-result`.
- **Re-opening a study.** If a study is already open, `IngestReport.alreadyLoaded` lets `loadFiles(..., {open:
  true})` switch the active cell back to it. A study-UID match wasn't enough: the synthetic DX and CT share a
  StudyInstanceUID.

**Layout.**
- `desktop/src/PacsAdminViewer.Core` (net8.0, builds and tests on Linux) contains:
  - `IImageArchive` and `OrthancArchive`, which use Orthanc's core REST API (`/tools/find`, `/studies/{id}/series`,
    `/series/{id}`), not the DICOMweb plugin;
  - `OrthancConnection.TryNormalizeBaseUri`, which accepts a pasted `/app/explorer.html` or `/ui/app/` URL;
  - `BridgeProtocol`, `LoadRequests`, `SettingsStore`, `ICredentialStore` and `FileAppLog`.
- `desktop/src/PacsAdminViewer.Desktop` (WPF, Windows only) contains:
  - `ViewerHost`, the only class that knows the viewer is a web page;
  - `MainWindow`, `ConnectWindow`, `StudyBrowserWindow`;
  - `DpapiCredentialStore`;
  - `Services` / `AppPaths`.
- `desktop/installer`: WiX **5** (`WixToolset.Sdk/5.0.2`; v6+ needs an EULA acceptance step). A per-machine MSI
  with the `<Files>` glob. Never change `UpgradeCode`. **The Start menu shortcut component's KeyPath must be an HKCU registry
  value even though the package is per-machine.** An HKLM key path fails ICE38/ICE43/ICE57, which is what broke
  CI run 1.
- `.github/workflows/desktop.yml` runs on `windows-latest`: npm build → Core tests → self-contained win-x64
  publish → MSI. It uploads the MSI and the portable folder as artifacts. The version is `major.minor` from
  `package.json` plus `github.run_number`.

**Rules and gotchas.**
- **Never log passwords, Authorization headers or PHI** (patient names/IDs, accession). Log counts, status codes
  and the server's scheme://host:port only.
- Settings go in `%APPDATA%\PacsAdminViewer`. The DPAPI password is saved only if "Remember password" is
  ticked. Logs and the WebView2 profile go in `%LOCALAPPDATA%\PacsAdminViewer`.
- **The WebView2 user-data folder must be set explicitly.** Its default is next to the exe, which is
  read-only under Program Files.
- **Use `.example`, not `.local`, for the fake origins.** `.local` is an mDNS name, which Microsoft warns can
  stall WebView2 virtual hosts.
- **WebView2 is a native child window that paints over WPF content (airspace).** `MainWindow.ShowProblem`
  collapses the WebView to show its error panel.
- **Browser accelerator keys (F5/Ctrl+R) are off** outside dev mode, because a reload drops every
  archive-loaded study. For the same reason there are no WPF keyboard shortcuts: the viewer owns the keyboard.
- **The Study browser is owned by the main window, so it floats above it.** It therefore hides after opening a
  study, like a worklist, and its X only hides it. `CloseForGood()` runs on main-window close or reconnect.
- **The build sandbox's Ubuntu .NET SDK has no `Microsoft.NET.Sdk.WindowsDesktop`**, so WPF/XAML only compiles
  in CI, and `builds.dotnet.microsoft.com` is blocked there. The WPF C# was type-checked locally against
  `Microsoft.WindowsDesktop.App.Ref` with stubbed XAML fields. Iterate on real compile errors via the Actions
  logs.
- Dev: `PACS_VIEWER_DEV_URL=http://localhost:5173` loads `npm run dev` inside the shell (DevTools on).
  `PACS_VIEWER_DEVTOOLS=1` enables DevTools in a release build.

**Verified.**
- Core: 64 xUnit tests.
- The viewer half of the bridge, in headless Chromium with a faked `chrome.webview` (`tests/e2e/e2e_bridge.py`).
- The WPF project, MSI and publish build on `windows-latest`.

**Not verified.**
- Running on a real Windows desktop.
- A real Orthanc.
- MSI install/upgrade/uninstall.
- WebView2's real handling of the data-origin proxy and virtual host.

The user needs to try these on their machine.

## Roadmap
**Phase 2 — layouts and measurements. Done**, see above.

**Phase 3 — import/export and header editing. Done**, see above.

**Local library persistence. Done**, see above — added between phases 3 and 4 in response to a direct request,
not part of the original plan.

**Auto-incrementing spine-level labeling** — a faster Label variant for spine reading: pick a starting
vertebral level, then each subsequent click labels the next one automatically (no retyping "L4", "L3", "L2"...
by hand). Not started; the general-purpose Label tool (see above) covers the same clinical need today, just
with a manual type-each-one gesture. Worth building only if the manual version turns out to be too slow for
real spine-reading volume — the general tool was deliberately chosen first since it's immediately useful for
any point+text annotation, not spine-specific.

**Archive connectivity: started, via the Windows desktop shell** (see above). It uses Orthanc's REST API
behind `IImageArchive`. DICOMweb (QIDO-RS/WADO-RS) for other PACS would be a second `IImageArchive`
implementation, with no shell or viewer changes. Sending edited or anonymized objects back (STOW / Orthanc
`POST /instances`) is not built.

**A local PACS server** (disk storage + a real database + a background service, enabling multi-device access
and true C-FIND/C-MOVE-style retrieval) was considered and explicitly deferred in favor of the much lighter
IndexedDB approach above. Revisit only if a real need for multi-device/multi-user access or archival-scale
storage shows up — nothing so far has needed it.

**Phase 4 — hanging protocols.** JSON schema: matching rules (modality, body part, laterality, series description,
prior vs current), a layout, ordered display-set assignments, per-cell defaults (W/L, orientation). A builder that
saves the current arrangement, and a matcher that picks the best protocol when a study loads.

**Volume rendering (MIP, PET/CT-style fusion) — asked about, not started, and a materially bigger lift than
anything else in this file so far.** Every cell today is a Cornerstone3D `StackViewport` (`Enums.ViewportType.STACK`
in `layout.ts`) — a 2D image-by-image stack, which is the right fit for everything built so far but has no
concept of a 3D volume to render through. MIP and fusion both need Cornerstone3D's *volume* pipeline instead:
`cornerstoneStreamingImageVolumeLoader`/`cache.createVolume` to assemble a series' slices into one 3D volume
(only meaningful for a series that's actually a coherent 3D stack — a NucMed/PET series with real geometry, not
an arbitrary pile of 2D images), an `Enums.ViewportType.ORTHOGRAPHIC` or `VOLUME_3D` viewport with a MIP blend
mode (`BlendModes.MAXIMUM_INTENSITY_BLEND`) for the MIP case, and for fusion, two volumes resampled onto the
same grid with a second colormap layered via `viewport.setProperties()`/`addVolumesToViewport` (the actual
"PET-hot-on-grayscale-CT" look) plus a registration/alignment step if the two series weren't already acquired
in the same frame of reference. None of that exists in this codebase yet: no volume loader is wired up, `cs.ts`
only initializes the stack/tools/loader trio, and `LayoutManager` assumes one `StackViewport` per cell
throughout (`ViewportCell` is stack-shaped end to end — `setStack`, `getCurrentImageIdIndex`, etc.). This would
be closer to a new phase than an incremental add: a volume-capable cell type alongside (not replacing) the
stack cells, plus real handling of the PET/CT quantitative correction tags (`RescaleSlope`/`RescaleIntercept`,
Philips/GE private SUV tags) if the output is meant to be clinically meaningful rather than just visually
plausible. Worth doing if NucMed/PET-CT is a real, recurring need — not recommended as a quick add given how far
it sits from the stack-viewport architecture everything else here is built on.

## Conventions
Plain sentence-case UI copy; errors say what happened and how to fix it. The viewport stays true black on purpose.
Overlay text is a near-white light gray (`--overlay`) — an earlier cyan-tinted version read as "highlighted
text" against the black background and was reverted; don't reuse the accent color for overlay text. Keep the UI
keyboard-accessible (visible focus, `aria-*` on toggles).
