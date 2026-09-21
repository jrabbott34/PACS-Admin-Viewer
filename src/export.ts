/**
 * Export: DICOM (zip of the original Part-10 blobs), a raster image of the
 * active cell's current frame, and an anonymized copy of a series. Everything
 * happens in memory and downloads as a browser file — nothing is uploaded.
 */
import dcmjs from 'dcmjs';
import { zipSync } from 'fflate';
import { resolveInstanceBlob } from './ingest';
import { newUid } from './wrap';
import type { Series } from './types';
import type { ViewportCell } from './viewport-cell';

const { DicomMessage } = dcmjs.data;

function safeName(s: string): string {
  return (s || 'series').replace(/[^A-Za-z0-9 ._-]/g, '_').trim() || 'series';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Zip every instance's original DICOM blob for one series and download it. */
export async function exportSeriesDicomZip(series: Series): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  for (const inst of series.instances) {
    const blob = resolveInstanceBlob(inst.imageId);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    files[`IM-${String(++n).padStart(4, '0')}.dcm`] = bytes;
  }
  if (!n) throw new Error('No DICOM data available for this series');
  const zipped = zipSync(files, { level: 0 });
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${safeName(series.seriesDescription || series.modality)}.zip`);
}

/** Composite the current frame's pixels with any measurement annotations and download it. */
export async function exportCellImage(cell: ViewportCell, format: 'png' | 'jpeg', burnInAnnotations: boolean): Promise<void> {
  const pixelCanvas = cell.getCanvas();
  const out = document.createElement('canvas');
  out.width = pixelCanvas.width;
  out.height = pixelCanvas.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(pixelCanvas, 0, 0);

  const svg = burnInAnnotations ? cell.element.querySelector('svg.svg-layer') : null;
  if (svg instanceof SVGSVGElement) {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(pixelCanvas.width));
    clone.setAttribute('height', String(pixelCanvas.height));
    const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    const svgUrl = URL.createObjectURL(svgBlob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = svgUrl;
      });
      ctx.drawImage(img, 0, 0, pixelCanvas.width, pixelCanvas.height);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }

  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error('Could not render this frame to an image');
  const s = cell.series;
  const base = s ? `${safeName(s.seriesDescription || s.modality)}_${String(cell.currentIndex + 1).padStart(4, '0')}` : 'image';
  downloadBlob(blob, `${base}.${format === 'png' ? 'png' : 'jpg'}`);
}

/** Tags commonly considered direct patient/institution identifiers. LO/PN/SH/ST VRs only. */
const ANON_TAGS: { tag: string; vr: 'PN' | 'LO' | 'SH' | 'ST' | 'DA' }[] = [
  { tag: '00100010', vr: 'PN' }, // PatientName
  { tag: '00100020', vr: 'LO' }, // PatientID
  { tag: '00100030', vr: 'DA' }, // PatientBirthDate
  { tag: '00101040', vr: 'LO' }, // PatientAddress
  { tag: '00101000', vr: 'LO' }, // OtherPatientIDs
  { tag: '00101001', vr: 'PN' }, // OtherPatientNames
  { tag: '00080080', vr: 'LO' }, // InstitutionName
  { tag: '00080081', vr: 'ST' }, // InstitutionAddress
  { tag: '00080090', vr: 'PN' }, // ReferringPhysicianName
  { tag: '00081050', vr: 'PN' }, // PerformingPhysicianName
  { tag: '00081070', vr: 'PN' }, // OperatorsName
  { tag: '00080050', vr: 'SH' }, // AccessionNumber
  { tag: '00200010', vr: 'SH' }, // StudyID
  { tag: '00321032', vr: 'PN' }, // RequestingPhysician
  { tag: '00081010', vr: 'SH' }, // StationName
];

function blankValue(vr: string): unknown[] {
  return vr === 'PN' ? [{ Alphabetic: '' }] : [''];
}

/** Zip an anonymized COPY of every instance in a series (the loaded originals are untouched) and download it. */
export async function anonymizeSeriesAndExport(series: Series): Promise<{ instances: number; tagsChanged: number }> {
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  let tagsChanged = 0;
  for (const inst of series.instances) {
    const blob = resolveInstanceBlob(inst.imageId);
    if (!blob) continue;
    const buffer = await blob.arrayBuffer();
    const dict = DicomMessage.readFile(buffer, { ignoreErrors: true });
    for (const { tag, vr } of ANON_TAGS) {
      if (dict.dict[tag]) {
        dict.upsertTag(tag, vr, blankValue(vr));
        tagsChanged++;
      }
    }
    const sopUid = newUid();
    dict.upsertTag('00080018', 'UI', [sopUid]); // SOPInstanceUID
    if (dict.meta['00020003']) dict.meta['00020003'].Value = [sopUid]; // MediaStorageSOPInstanceUID
    files[`IM-${String(++n).padStart(4, '0')}.dcm`] = new Uint8Array(dict.write());
  }
  if (!n) throw new Error('No DICOM data available for this series');
  const zipped = zipSync(files, { level: 0 });
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${safeName(series.seriesDescription || series.modality)}_anonymized.zip`);
  return { instances: n, tagsChanged };
}
