import dicomParser from 'dicom-parser';
import { wadouri } from '@cornerstonejs/dicom-image-loader';
import { unzipSync } from 'fflate';
import type { IngestReport, InstanceInfo, Series, SeriesKind } from './types';
import { wrapPdfFile, wrapRasterFile } from './wrap';

/** Everything loaded so far, keyed by SeriesInstanceUID. */
export const library = {
  series: new Map<string, Series>(),
  sops: new Set<string>(),
  /**
   * Header-edited replacement blobs, keyed by base imageId (no `?frame=` suffix,
   * so every frame of a multi-frame object shares one edited blob). Never fed
   * back into the Cornerstone stack — a pure metadata edit doesn't change pixel
   * data, so there is nothing to re-render. Consulted by `resolveInstanceBlob`
   * for the header panel and for export.
   */
  edited: new Map<string, Blob>(),
};

/** Strips the `?frame=N` suffix multi-frame imageIds carry. */
export function baseImageId(imageId: string): string {
  return imageId.split('?')[0];
}

/** The blob for an instance: its header-edited replacement if one exists, else the original. */
export function resolveInstanceBlob(imageId: string): Blob | undefined {
  const edited = library.edited.get(baseImageId(imageId));
  if (edited) return edited;
  const m = /^dicomfile:(\d+)/.exec(imageId);
  return m ? wadouri.fileManager.get(Number(m[1])) : undefined;
}

/** Finds which series/instance an imageId (any frame) belongs to. */
export function findInstanceByImageId(imageId: string): { series: Series; instance: InstanceInfo } | undefined {
  const base = baseImageId(imageId);
  for (const series of library.series.values()) {
    const instance = series.instances.find((i) => baseImageId(i.imageId) === base);
    if (instance) return { series, instance };
  }
  return undefined;
}

/** Re-derives a series' summary fields (patient/study/series text) from an edited blob. */
export async function refreshSeriesSummary(series: Series, blob: Blob): Promise<void> {
  const ds = await readHeader(blob);
  if (!ds) return;
  series.patientName = pn(ds.string('x00100010'));
  series.patientId = ds.string('x00100020') ?? '';
  series.studyDescription = ds.string('x00081030') ?? '';
  series.seriesDescription = ds.string('x0008103e') ?? '';
  series.studyDate = dicomDate(ds.string('x00080020'));
  series.institution = ds.string('x00080080') ?? '';
}

type Sniffed = 'dicom' | 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'pdf' | 'unknown';

const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
// MPEG-2 / MPEG-4 / HEVC video transfer syntaxes are not still images.
const VIDEO_TS = /^1\.2\.840\.10008\.1\.2\.4\.(10[0-9])$/;

async function isZip(file: File): Promise<boolean> {
  if (/\.zip$/i.test(file.name)) return true;
  const h = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07);
}

/**
 * Expand any .zip files in the list into their contained files (recursively, for a
 * zip inside a zip). DICOMDIR entries need no special handling: they carry no pixel
 * data, so `ingest` naturally reports them as skipped while every referenced DICOM
 * file — found loose in the same archive — is read and grouped from its own header.
 */
export async function expandArchives(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (!(await isZip(file))) {
      out.push(file);
      continue;
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      out.push(file); // not a real/valid zip; let the normal pipeline report it as unreadable
      continue;
    }
    const extracted: File[] = [];
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || !data.length) continue; // directory entry
      const name = path.split('/').pop() || path;
      if (path.includes('__MACOSX/') || name.startsWith('._') || IGNORED_NAMES.has(name.toLowerCase())) continue;
      extracted.push(new File([new Uint8Array(data)], name));
    }
    out.push(...(await expandArchives(extracted)));
  }
  return out;
}

async function sniff(file: File): Promise<Sniffed> {
  const h = new Uint8Array(await file.slice(0, 132).arrayBuffer());
  const at = (i: number, s: string) => [...s].every((c, k) => h[i + k] === c.charCodeAt(0));
  if (h.length >= 132 && at(128, 'DICM')) return 'dicom';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (h[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (at(0, '%PDF')) return 'pdf';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'BM') && /\.bmp$/i.test(file.name)) return 'bmp';
  return 'unknown';
}

async function readHeader(blob: Blob): Promise<dicomParser.DataSet | null> {
  const sizes = blob.size > 262144 ? [262144, blob.size] : [blob.size];
  for (let i = 0; i < sizes.length; i++) {
    const bytes = new Uint8Array(await blob.slice(0, sizes[i]).arrayBuffer());
    try {
      return dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });
    } catch (e) {
      const last = i === sizes.length - 1;
      if (last) {
        const partial = (e as { dataSet?: dicomParser.DataSet }).dataSet;
        return partial && partial.elements.x00080018 ? partial : null;
      }
    }
  }
  return null;
}

function pn(raw: string | undefined): string {
  if (!raw) return '';
  const [family, ...rest] = raw.split('=')[0].split('^');
  const given = rest.filter(Boolean).join(' ');
  return given ? `${family}, ${given}` : family;
}

function dicomDate(raw: string | undefined): string {
  return raw && /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw ?? '';
}

function numArray(ds: dicomParser.DataSet, tag: string, n: number): number[] | undefined {
  if (!ds.elements[tag]) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = ds.floatString(tag, i);
    if (v === undefined || Number.isNaN(v)) return undefined;
    out.push(v);
  }
  return out;
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

interface Candidate {
  blob: Blob;
  name: string;
  kind: SeriesKind;
}

/** Parse one DICOM object and register it (and each of its frames) in the library. */
async function register(
  c: Candidate,
  touched: Set<Series>,
  report: IngestReport,
): Promise<void> {
  const ds = await readHeader(c.blob);
  if (!ds || (!ds.elements.x00080018 && !ds.elements.x00080016)) {
    report.skipped.push({ name: c.name, reason: 'not a readable DICOM, image or PDF file' });
    return;
  }
  if (!ds.elements.x7fe00010) {
    const sopClass = ds.string('x00080016') ?? 'unknown SOP class';
    report.skipped.push({ name: c.name, reason: `DICOM object without pixel data (${ds.string('x00080060') ?? sopClass})` });
    return;
  }
  const ts = ds.string('x00020010') ?? '';
  if (VIDEO_TS.test(ts)) {
    report.skipped.push({ name: c.name, reason: 'video transfer syntax is not supported' });
    return;
  }

  const sop = ds.string('x00080018') ?? `${c.name}:${c.blob.size}`;
  if (library.sops.has(sop)) {
    report.duplicates++;
    return;
  }
  library.sops.add(sop);

  const seriesUid = ds.string('x0020000e') ?? `no-series-uid:${c.name}`;
  const photometric = ds.string('x00280004') ?? 'MONOCHROME2';
  let series = library.series.get(seriesUid);
  if (!series) {
    series = {
      uid: seriesUid,
      studyUid: ds.string('x0020000d') ?? 'no-study-uid',
      kind: c.kind,
      modality: ds.string('x00080060') ?? '',
      seriesNumber: ds.intString('x00200011'),
      seriesDescription: ds.string('x0008103e') ?? '',
      studyDescription: ds.string('x00081030') ?? '',
      studyDate: dicomDate(ds.string('x00080020')),
      patientName: pn(ds.string('x00100010')),
      patientId: ds.string('x00100020') ?? '',
      institution: ds.string('x00080080') ?? '',
      isColor: !photometric.startsWith('MONOCHROME'),
      instances: [],
    };
    library.series.set(seriesUid, series);
  }
  touched.add(series);

  const iop = numArray(ds, 'x00200037', 6);
  const normal = iop ? cross(iop.slice(0, 3), iop.slice(3, 6)) : undefined;
  const base = wadouri.fileManager.add(c.blob);
  const frames = Math.max(1, ds.intString('x00280008') ?? 1);
  const info = {
    sop,
    fileName: c.name,
    instanceNumber: ds.intString('x00200013'),
    sliceLocation: ds.floatString('x00201041'),
    thickness: ds.floatString('x00180050'),
    position: numArray(ds, 'x00200032', 3),
    normal,
  };
  for (let f = 1; f <= frames; f++) {
    series.instances.push({
      ...info,
      imageId: frames > 1 ? `${base}?frame=${f}` : base,
      frame: frames > 1 ? f : undefined,
    });
    report.instancesAdded++;
  }
}

function sortInstances(list: InstanceInfo[]): void {
  const dist = (i: InstanceInfo) =>
    i.position && i.normal ? i.position.reduce((s, v, k) => s + v * i.normal![k], 0) : undefined;
  const dists = list.map(dist);
  const usable = dists.every((d) => d !== undefined) && new Set(dists.map((d) => d!.toFixed(3))).size > 1;
  const collator = new Intl.Collator(undefined, { numeric: true });
  const order = new Map(list.map((i, k) => [i, dists[k]]));
  list.sort((a, b) => {
    if (usable) {
      const d = order.get(a)! - order.get(b)!;
      if (Math.abs(d) > 1e-3) return d;
    }
    const n = (a.instanceNumber ?? Infinity) - (b.instanceNumber ?? Infinity);
    if (n !== 0 && !Number.isNaN(n)) return n;
    return collator.compare(a.fileName, b.fileName) || (a.frame ?? 0) - (b.frame ?? 0);
  });
}

/**
 * Load a batch of files. DICOM is registered directly; JPG/PNG/etc. and PDF are
 * wrapped as DICOM Secondary Capture first so they behave like everything else.
 */
export async function ingest(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<IngestReport> {
  const report: IngestReport = { touched: [], instancesAdded: 0, duplicates: 0, skipped: [] };
  const touched = new Set<Series>();
  const expanded = await expandArchives(files);
  const candidates = expanded.filter((f) => !IGNORED_NAMES.has(f.name.toLowerCase()));
  let done = 0;

  const handle = async (file: File) => {
    try {
      const kind = await sniff(file);
      if (kind === 'dicom' || kind === 'unknown') {
        await register({ blob: file, name: file.name, kind: 'dicom' }, touched, report);
      } else if (kind === 'pdf') {
        const { blobs, truncated } = await wrapPdfFile(file);
        if (truncated) report.skipped.push({ name: file.name, reason: 'only the first 100 pages were loaded' });
        for (const b of blobs) await register({ blob: b, name: file.name, kind: 'pdf' }, touched, report);
      } else {
        for (const b of await wrapRasterFile(file)) await register({ blob: b, name: file.name, kind: 'image' }, touched, report);
      }
    } catch (e) {
      report.skipped.push({ name: file.name, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      onProgress?.(++done, candidates.length);
    }
  };

  const CONCURRENCY = 8;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
      while (next < candidates.length) await handle(candidates[next++]);
    }),
  );

  for (const s of touched) sortInstances(s.instances);
  report.touched = [...touched];
  return report;
}

/** Sorted view of the library for the series list. */
export function orderedSeries(): Series[] {
  return [...library.series.values()].sort(
    (a, b) =>
      a.studyDate.localeCompare(b.studyDate) ||
      a.studyUid.localeCompare(b.studyUid) ||
      (a.seriesNumber ?? 1e9) - (b.seriesNumber ?? 1e9) ||
      a.seriesDescription.localeCompare(b.seriesDescription),
  );
}

// ---------- drag-and-drop helpers (folders included) ----------

export function entriesFromDataTransfer(dt: DataTransfer): FileSystemEntry[] {
  // Must run synchronously inside the drop event.
  return [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
}

export async function filesFromEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}
