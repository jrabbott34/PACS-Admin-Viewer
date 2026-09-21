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

## What works today (phase 1)

- Open DICOM (uncompressed, RLE, JPEG, JPEG 2000, JPEG-LS), JPG, PNG, GIF, WebP, BMP and PDF, including whole folders.
- Series list with thumbnails, grouped by study; slices sorted by patient position, then instance number.
- Single viewport: scroll, Window/Level, pan, zoom, invert, flip, rotate, reset.
- CT window presets, typed W/L values, "Default" (from the DICOM tags) and "Full range".
- Searchable DICOM header panel, including nested sequences and private tags (read-only).
- Overlays: patient/study, series, image number, slice location and thickness, W/L, zoom.

## Mouse and keyboard

| Input | Action |
| --- | --- |
| Left drag | Active tool (Scroll, Window/Level, Pan or Zoom) |
| Middle drag | Pan |
| Right drag | Zoom |
| Wheel | Scroll through the stack |
| Arrow keys / Page Up / Page Down | Previous / next image |
| Home / End | First / last image |
| S, W, P, Z | Choose Scroll, Window/Level, Pan or Zoom |
| I, R, H | Invert, reset, toggle the header panel |

## Roadmap

See `CLAUDE.md` for the detailed plan (layouts, measurements, import/export, header editing, hanging protocols).
