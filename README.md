# PACS-Admin-Viewer

A local-first web DICOM viewer built on Cornerstone3D. Everything runs in the browser tab; files are never uploaded.

**Not for diagnostic use.** This is a learning, demo and internal-tooling project and is not an FDA-cleared device.

## Run it

**Easiest: double-click the launcher.** It installs dependencies the first time, frees port 5173 if a previous
copy is still running, starts the server, and opens your browser to it automatically.

- **Windows:** double-click `launch.bat`. A second window opens and must stay open while you use the viewer —
  that's the server; close it when you're done.
- **Mac:** double-click `launch.command` (first time only: right-click → Open, since it's from an unidentified
  developer). **Linux:** run `./launch.command` from a terminal (or double-click it if your file manager runs
  `.command`/executable scripts).

Both scripts always use `http://localhost:5173/` — if you'd rather have a clickable shortcut to that exact
page instead of running the launcher every time, drag the address bar's icon to your desktop (or use your OS's
"create shortcut to this link") once the server is running. A browser shortcut alone can't start the server,
though — you still need the launcher (or `npm run dev`) running first.

**Manual (if you'd rather use the terminal directly):**

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Then drop files, folders or **.zip archives** onto the window, or open the **☰ menu** (top left) → **Open files /
Open folder**. Try the synthetic data in `samples/` (CT, MR, MONOCHROME1 X-ray, RLE / JPEG 2000 / JPEG-LS CT
slices, a JPG, a PNG and a 2-page PDF).

## What works today (phases 1-3, plus a local library)

- **Everything you import is saved in this browser**, so it's still there next time you open the app — you
  don't need to re-import your files every session. It never leaves your machine (same rule as everything else
  here); Menu → Local library → **Clear local library** deletes it all if you want a clean slate, or click the
  **×** on one study's header in the series list to close just that one and keep everything else loaded.
- Open DICOM (uncompressed, RLE, JPEG, JPEG 2000, JPEG-LS), JPG, PNG, GIF, WebP, BMP, PDF and **.zip archives**
  of any of those (dropped or opened), including whole folders.
- Series list with thumbnails, grouped by study; slices sorted by patient position, then instance number. Drag
  the handle at its right edge to resize the panel, or click the sidebar icon next to the ☰ menu to hide/show it.
- Viewport layouts: 1x1, 1x2, 2x1, 2x2, 2x3 and 3x3. Click a cell to make it active (shown with a teal
  highlight) — its series list entry gets highlighted too — then click a series to load it there, or drag a
  series from the list straight onto any cell. Switching layouts never loses what's loaded. Drag a cell's own
  label text onto another cell to swap their series (or copy, if the target is empty). **Double-click a cell**
  to maximize it to fill the whole grid; double-click again to restore.
- Per-cell scroll, Window/Level, pan, zoom, invert, flip, rotate, reset, and **Magnify** (hold and drag for a
  loupe view). **Cine** ("Space") auto-plays through the active cell's stack on a loop at a chosen frame rate
  (5-30 fps). **Reset all** resets every viewport in the current layout in one click (the plain "Reset" button
  only resets the active cell). An optional "Link scroll" keeps every cell's slice index in sync. The overlay
  toggle button ("O") hides the corner text (patient/series/W-L/zoom) on every cell at once, for an unobstructed
  look or a clean screenshot.
- Measurement tools, always visible in their own toolbar group (no menu-diving): Length, Angle, Rectangle ROI,
  Ellipse ROI, Probe — calibrated to real-world units from the DICOM pixel spacing where available (Probe
  reports Hounsfield units directly on CT). "Clear" removes all measurements from the active cell. Length,
  Rectangle and Probe all drag corner-to-corner or click-to-place. **Ellipse and Angle are different**: for
  Ellipse, click the *center* of what you're measuring and drag outward (not corner-to-corner); for Angle, drag
  the first line, then click once more to place the second — the status bar shows a reminder when you select
  either.
- CT window presets, typed W/L values, "Default" (from the DICOM tags) and "Full range".
- Searchable DICOM header panel for the active cell, including nested sequences and private tags. An **Edit**
  toggle turns on admin mode: click any text/date tag to change it, with every change logged (old value, new
  value, time) in a per-session **Log**, plus a one-click **Regen UID** to assign the current object a fresh
  SOPInstanceUID.
- **Export**, from the ☰ menu, scoped to the active series: **Export DICOM** (zip of the original — or
  header-edited — Part-10 files), **Export image as PNG/JPG** (the active cell's current frame, with
  measurements burned in), and **Anonymize & export** (a zip of de-identified copies — PatientName, PatientID,
  birth date, addresses, physician names, accession/station — with a fresh SOPInstanceUID per file; the loaded
  series itself is never touched).
- Per-cell overlays: patient/study, series, image number, slice location and thickness, W/L, zoom.
- Icon toolbar: a **☰ Menu** and a **Layout** picker that "explode down" from a trigger button, always-visible
  labeled tool buttons (Navigate: Scroll/W-L/Pan/Zoom; Measure: Length/Angle/Rect/Ellipse/Probe — no dropdown
  to find first), and a compact row of icon buttons for invert, flip, rotate, reset, clear measurements and
  link scroll.
- A splash screen ("PACS Admin DICOM Viewer", created by Jason Abbott) on launch — stays up until you click
  **Open Viewer**, rather than flashing past automatically.

## Mouse and keyboard

| Input | Action |
| --- | --- |
| Click a cell | Make it the active cell (targets toolbar actions, W/L, header, reset, clear) |
| Double-click a cell | Maximize it to fill the grid; double-click again to restore |
| Left drag | Active tool (Scroll, Window/Level, Pan, Zoom, or a measurement tool) |
| Middle drag | Pan |
| Right drag | Zoom |
| Wheel | Scroll through the active cell's stack |
| Drag a series onto a cell | Load that series into that specific cell |
| Drag a cell's label onto another cell | Swap their series (or copy, if the target is empty) |
| Arrow keys / Page Up / Page Down | Previous / next image (active cell) |
| Home / End | First / last image (active cell) |
| S, W, P, Z, M | Choose Scroll, Window/Level, Pan, Zoom or Magnify |
| I, R, H, O | Invert, reset, toggle the header panel (active cell); toggle overlays (all cells) |
| Space | Play/pause cine on the active cell |

## Roadmap

Phases 1-3 are done, plus local library persistence. See `CLAUDE.md` for the phase 4 plan (hanging protocols).
Query/Retrieve against a real PACS and a local PACS server (with its own database) were both considered and
deliberately deferred — see `CLAUDE.md` for why.
