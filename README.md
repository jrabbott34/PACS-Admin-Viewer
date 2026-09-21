# PACS-Admin-Viewer

A local-first web DICOM viewer built on Cornerstone3D. Everything runs in the browser tab; files are never uploaded.

**Not for diagnostic use.** This is a learning, demo and internal-tooling project and is not an FDA-cleared device.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Then drop files, folders or **.zip archives** onto the window, or open the **☰ menu** (top left) → **Open files /
Open folder**. Try the synthetic data in `samples/` (CT, MR, MONOCHROME1 X-ray, RLE / JPEG 2000 / JPEG-LS CT
slices, a JPG, a PNG and a 2-page PDF).

## What works today (phases 1-3)

- Open DICOM (uncompressed, RLE, JPEG, JPEG 2000, JPEG-LS), JPG, PNG, GIF, WebP, BMP, PDF and **.zip archives**
  of any of those (dropped or opened), including whole folders.
- Series list with thumbnails, grouped by study; slices sorted by patient position, then instance number.
- Viewport layouts: 1x1, 1x2, 2x1, 2x2, 2x3 and 3x3. Click a cell to make it active, then click a series to load
  it there — or drag a series from the list straight onto any cell. Switching layouts never loses what's loaded.
- Per-cell scroll, Window/Level, pan, zoom, invert, flip, rotate, reset. An optional "Link scroll" keeps every
  cell's slice index in sync.
- Measurement tools: Length, Angle, Rectangle ROI, Ellipse ROI, Probe — calibrated to real-world units from the
  DICOM pixel spacing where available. "Clear" removes all measurements from the active cell.
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
- Icon toolbar with three "explode down" pickers — **☰ Menu**, **Layout**, and **Tools** — plus a compact row of
  icon buttons for invert, flip, rotate, reset, clear measurements and link scroll.

## Mouse and keyboard

| Input | Action |
| --- | --- |
| Click a cell | Make it the active cell (targets toolbar actions, W/L, header, reset, clear) |
| Left drag | Active tool (Scroll, Window/Level, Pan, Zoom, or a measurement tool) |
| Middle drag | Pan |
| Right drag | Zoom |
| Wheel | Scroll through the active cell's stack |
| Drag a series onto a cell | Load that series into that specific cell |
| Arrow keys / Page Up / Page Down | Previous / next image (active cell) |
| Home / End | First / last image (active cell) |
| S, W, P, Z | Choose Scroll, Window/Level, Pan or Zoom |
| I, R, H | Invert, reset, toggle the header panel (active cell) |

## Roadmap

Phases 1-3 are done. See `CLAUDE.md` for the phase 4 plan (hanging protocols).
