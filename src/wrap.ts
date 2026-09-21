/**
 * Turns JPG/PNG/GIF/WebP/BMP images and PDF pages into single-frame DICOM
 * Secondary Capture objects (uncompressed, in memory). That lets every input
 * type flow through the same loader, series list, viewport and header viewer.
 */
import dcmjs from 'dcmjs';
// The legacy build polyfills newer JS features, so it works on slightly older browsers too.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SC_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7';
const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
const MAX_EDGE = 8192;
const MAX_PDF_PAGES = 100;
const PDF_SCALE = 2;

export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return `2.25.${n.toString()}`;
}

/** All imported (non-DICOM) files share one study so they group together in the list. */
export const IMPORT_STUDY_UID = newUid();

interface WrapOptions {
  seriesUid: string;
  instanceNumber: number;
  seriesDescription: string;
  comments: string;
}

function rgbaToDicom(rgba: Uint8ClampedArray, width: number, height: number, opt: WrapOptions): Blob {
  const count = width * height;
  // Composite over black and detect greyscale so grey images get Window/Level.
  let gray = true;
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const a = rgba[p + 3];
    if (a !== 255) {
      rgba[p] = (rgba[p] * a) / 255;
      rgba[p + 1] = (rgba[p + 1] * a) / 255;
      rgba[p + 2] = (rgba[p + 2] * a) / 255;
    }
    if (gray && (rgba[p] !== rgba[p + 1] || rgba[p + 1] !== rgba[p + 2])) gray = false;
  }
  const samples = gray ? 1 : 3;
  const pixels = new Uint8Array(count * samples);
  for (let i = 0, p = 0, q = 0; i < count; i++, p += 4) {
    pixels[q++] = rgba[p];
    if (!gray) {
      pixels[q++] = rgba[p + 1];
      pixels[q++] = rgba[p + 2];
    }
  }

  const sopUid = newUid();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const meta = {
    MediaStorageSOPClassUID: SC_SOP_CLASS,
    MediaStorageSOPInstanceUID: sopUid,
    TransferSyntaxUID: EXPLICIT_VR_LE,
    ImplementationClassUID: '2.25.1',
  };
  const dataset: Record<string, unknown> = {
    _vrMap: { PixelData: 'OB' },
    SOPClassUID: SC_SOP_CLASS,
    SOPInstanceUID: sopUid,
    StudyInstanceUID: IMPORT_STUDY_UID,
    SeriesInstanceUID: opt.seriesUid,
    StudyDate: date,
    StudyTime: time,
    StudyDescription: 'Imported files',
    Modality: 'OT',
    ConversionType: 'WSD',
    ImageType: ['DERIVED', 'SECONDARY'],
    SeriesDescription: opt.seriesDescription,
    SeriesNumber: 1,
    InstanceNumber: opt.instanceNumber,
    ImageComments: opt.comments,
    SamplesPerPixel: samples,
    PhotometricInterpretation: gray ? 'MONOCHROME2' : 'RGB',
    Rows: height,
    Columns: width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    PixelData: [pixels.buffer],
  };
  if (!gray) dataset.PlanarConfiguration = 0;

  // Write Part 10 directly (datasetToBlob depends on Node's Buffer).
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  return new Blob([dict.write()], { type: 'application/dicom' });
}

/** Wrap a JPG/PNG/GIF/WebP/BMP file as one Secondary Capture DICOM object. */
export async function wrapRasterFile(file: File): Promise<Blob[]> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return [
      rgbaToDicom(data, w, h, {
        seriesUid: newUid(),
        instanceNumber: 1,
        seriesDescription: file.name,
        comments: `Imported from ${file.name} (${file.type || 'image'}); wrapped as DICOM Secondary Capture by the viewer.`,
      }),
    ];
  } finally {
    bitmap.close();
  }
}

/** Render each PDF page to a Secondary Capture image. One series per PDF. */
export async function wrapPdfFile(file: File): Promise<{ blobs: Blob[]; truncated: boolean }> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const seriesUid = newUid();
  const total = doc.numPages;
  const pages = Math.min(total, MAX_PDF_PAGES);
  const blobs: Blob[] = [];
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: PDF_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      const { data: rgba } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      blobs.push(
        rgbaToDicom(rgba, canvas.width, canvas.height, {
          seriesUid,
          instanceNumber: p,
          seriesDescription: file.name,
          comments: `Page ${p} of ${total} from ${file.name}; rendered by pdf.js and wrapped as DICOM Secondary Capture.`,
        }),
      );
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { blobs, truncated: total > pages };
}
