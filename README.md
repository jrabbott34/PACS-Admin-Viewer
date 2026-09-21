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

Then drop files or folders onto the window, or use **Open files / Open folder**. Try the synthetic data in `samples/`
(CT, MR, MONOCHROME1 X-ray, RLE / JPEG 2000 / JPEG-LS CT slices, a JPG, a PNG and a 2-page PDF).

## What works today (phases 1-2)

- Open DICOM (uncompressed, RLE, JPEG, JPEG 2000, JPEG-LS), JPG, PNG, GIF, WebP, BMP and PDF, including whole folders.
- Series list with thumbnails, grouped by study; slices sorted by patient position, then instance number.
- Viewport layouts: 1x1, 1x2, 2x1, 2x2, 2x3 and 3x3. Click a cell to make it active, then click a series to load
  it there — or drag a series from the list straight onto any cell. Switching layouts never loses what's loaded.
- Per-cell scroll, Window/Level, pan, zoom, invert, flip, rotate, reset. An optional "Link scroll" keeps every
  cell's slice index in sync.
- Measurement tools: Length, Angle, Rectangle ROI, Ellipse ROI, Probe — calibrated to real-world units from the
  DICOM pixel spacing where available. "Clear" removes all measurements from the active cell.
- CT window presets, typed W/L values, "Default" (from the DICOM tags) and "Full range".
- Searchable DICOM header panel, including nested sequences and private tags (read-only), for the active cell.
- Per-cell overlays: patient/study, series, image number, slice location and thickness, W/L, zoom.

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

See `CLAUDE.md` for the detailed plan (import/export, header editing, hanging protocols).
