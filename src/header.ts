import dcmjs from 'dcmjs';

interface Row {
  depth: number;
  tag: string; // "0010,0010"
  name: string;
  vr: string;
  value: string;
  kind: 'element' | 'item' | 'meta-divider';
}

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);
const MAX_VALUE_CHARS = 240;

function fmtTag(key: string): string {
  return `${key.slice(0, 4)},${key.slice(4, 8)}`.toUpperCase();
}

function tagName(key: string): string {
  const entry = DicomMetaDictionary.dictionary[`(${fmtTag(key)})`] as { name?: string } | undefined;
  if (entry?.name) return entry.name;
  const group = parseInt(key.slice(0, 4), 16);
  if (key.slice(4, 8) === '0000') return 'Group Length';
  return group % 2 === 1 ? 'Private tag' : 'Unknown tag';
}

function bytesOf(v: unknown): number {
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  return 0;
}

function fmtValue(vr: string, values: unknown[] | undefined): string {
  if (!values || values.length === 0) return '';
  if (BINARY_VRS.has(vr) || values.some((v) => bytesOf(v) > 0)) {
    const n = values.reduce<number>((s, v) => s + bytesOf(v), 0);
    return n ? `(binary, ${n.toLocaleString()} bytes${values.length > 1 ? `, ${values.length} fragments` : ''})` : '';
  }
  const parts = values.map((v) => {
    if (v === null || v === undefined) return '';
    if (vr === 'PN' && typeof v === 'object') return (v as { Alphabetic?: string }).Alphabetic ?? JSON.stringify(v);
    if (vr === 'AT' && typeof v === 'number') return fmtTag(v.toString(16).padStart(8, '0'));
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
  const joined = parts.join('\\');
  return joined.length > MAX_VALUE_CHARS ? `${joined.slice(0, MAX_VALUE_CHARS)}…` : joined;
}

type DictLike = Record<string, { vr?: string; Value?: unknown[] }>;

function walk(dict: DictLike, depth: number, out: Row[]): void {
  const keys = Object.keys(dict)
    .filter((k) => /^[0-9A-Fa-f]{8}$/.test(k))
    .sort();
  for (const key of keys) {
    const el = dict[key];
    const vr = el.vr ?? '';
    if (vr === 'SQ') {
      const items = (el.Value ?? []) as DictLike[];
      out.push({
        depth,
        tag: fmtTag(key),
        name: tagName(key),
        vr,
        value: `${items.length} item${items.length === 1 ? '' : 's'}`,
        kind: 'element',
      });
      items.forEach((item, i) => {
        out.push({ depth: depth + 1, tag: '', name: `Item ${i + 1}`, vr: '', value: '', kind: 'item' });
        walk(item, depth + 2, out);
      });
    } else {
      out.push({ depth, tag: fmtTag(key), name: tagName(key), vr, value: fmtValue(vr, el.Value), kind: 'element' });
    }
  }
}

/** Read every element of a DICOM Part-10 blob into a flat, indented row list. */
export async function readRows(blob: Blob): Promise<Row[]> {
  const buffer = await blob.arrayBuffer();
  const msg = DicomMessage.readFile(buffer, { ignoreErrors: true });
  const rows: Row[] = [];
  walk(msg.meta as DictLike, 0, rows);
  if (rows.length) rows.push({ depth: 0, tag: '', name: 'Dataset', vr: '', value: '', kind: 'meta-divider' });
  walk(msg.dict as DictLike, 0, rows);
  return rows;
}

export type { Row };

/** Header side panel: searchable tag table for the image currently on screen. */
export class HeaderPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private search: HTMLInputElement;
  private count: HTMLElement;
  private rows: Row[] = [];
  private token = 0;
  private lastKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="hp-head">
        <input type="search" class="hp-search" placeholder="Filter by tag, name or value" aria-label="Filter DICOM tags" />
        <span class="hp-count" aria-live="polite"></span>
      </div>
      <div class="hp-scroll"><table class="hp-table"><tbody></tbody></table></div>`;
    this.search = root.querySelector('.hp-search')!;
    this.count = root.querySelector('.hp-count')!;
    this.body = root.querySelector('tbody')!;
    this.search.addEventListener('input', () => this.render());
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  /** Load the header for a blob. `key` de-duplicates repeated calls for the same image. */
  async show(blob: Blob | undefined, key: string): Promise<void> {
    if (!blob || key === this.lastKey) return;
    this.lastKey = key;
    const mine = ++this.token;
    try {
      const rows = await readRows(blob);
      if (mine !== this.token) return;
      this.rows = rows;
    } catch (e) {
      if (mine !== this.token) return;
      this.rows = [];
      this.count.textContent = `Could not read header: ${e instanceof Error ? e.message : e}`;
      this.body.replaceChildren();
      return;
    }
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;
    let total = 0;
    for (const r of this.rows) {
      if (r.kind === 'element') total++;
      if (q && r.kind === 'element' && !`${r.tag} ${r.name} ${r.value}`.toLowerCase().includes(q)) continue;
      if (q && r.kind !== 'element') continue;
      const tr = document.createElement('tr');
      tr.className = r.kind === 'element' ? '' : r.kind;
      if (r.kind === 'meta-divider') {
        tr.innerHTML = `<td colspan="3">${r.name}</td>`;
      } else if (r.kind === 'item') {
        tr.innerHTML = `<td colspan="3" style="padding-left:${r.depth * 14 + 8}px"></td>`;
        tr.firstElementChild!.textContent = r.name;
      } else {
        shown++;
        const tag = document.createElement('td');
        tag.className = 'hp-tag';
        tag.textContent = r.tag;
        const name = document.createElement('td');
        name.className = 'hp-name';
        name.style.paddingLeft = `${r.depth * 14 + 8}px`;
        name.textContent = r.name;
        name.title = r.vr ? `${r.name} (${r.vr})` : r.name;
        const val = document.createElement('td');
        val.className = 'hp-value';
        val.textContent = r.value;
        val.title = r.value;
        tr.append(tag, name, val);
      }
      frag.append(tr);
    }
    this.body.replaceChildren(frag);
    this.count.textContent = q ? `${shown} of ${total} elements` : `${total} elements`;
  }
}
