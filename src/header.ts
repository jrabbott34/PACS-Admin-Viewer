import dcmjs from 'dcmjs';
import { newUid } from './wrap';

interface Row {
  depth: number;
  key: string; // raw 8-hex tag, e.g. "00100010" — empty for non-element rows
  tag: string; // "0010,0010"
  name: string;
  vr: string;
  value: string;
  editable: boolean;
  kind: 'element' | 'item' | 'meta-divider';
}

interface LogEntry {
  time: string;
  tag: string;
  name: string;
  oldValue: string;
  newValue: string;
}

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);
const MAX_VALUE_CHARS = 240;
const SOP_INSTANCE_UID_TAG = '00080018';
const MEDIA_SOP_INSTANCE_UID_TAG = '00020003';
/**
 * VRs safe for a free-text editor: administrative/demographic text and dates.
 * Deliberately excludes UI (UIDs are structural — StudyInstanceUID and
 * SeriesInstanceUID changes aren't supported here, and SOPInstanceUID only
 * changes via "Regenerate UIDs"), sequences, and binary/numeric VRs where a
 * wrong-shaped value could make the file unreadable elsewhere.
 */
const EDITABLE_VRS = new Set(['PN', 'LO', 'SH', 'ST', 'LT', 'UT', 'CS', 'DA', 'TM', 'DT', 'AS']);

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

/** Wraps a typed replacement string in the Value shape the given VR expects. */
function toValue(vr: string, text: string): unknown[] {
  return vr === 'PN' ? [{ Alphabetic: text }] : [text];
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
        key,
        tag: fmtTag(key),
        name: tagName(key),
        vr,
        value: `${items.length} item${items.length === 1 ? '' : 's'}`,
        editable: false,
        kind: 'element',
      });
      items.forEach((item, i) => {
        out.push({ depth: depth + 1, key: '', tag: '', name: `Item ${i + 1}`, vr: '', value: '', editable: false, kind: 'item' });
        walk(item, depth + 2, out);
      });
    } else {
      out.push({
        depth,
        key,
        tag: fmtTag(key),
        name: tagName(key),
        vr,
        value: fmtValue(vr, el.Value),
        editable: EDITABLE_VRS.has(vr),
        kind: 'element',
      });
    }
  }
}

function buildRows(msg: { meta: DictLike; dict: DictLike }): Row[] {
  const rows: Row[] = [];
  walk(msg.meta, 0, rows);
  if (rows.length) rows.push({ depth: 0, key: '', tag: '', name: 'Dataset', vr: '', value: '', editable: false, kind: 'meta-divider' });
  walk(msg.dict, 0, rows);
  return rows;
}

/** Header side panel: searchable tag table for the image currently on screen, with an admin edit mode. */
export class HeaderPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private search: HTMLInputElement;
  private count: HTMLElement;
  private editBtn: HTMLButtonElement;
  private regenBtn: HTMLButtonElement;
  private logBtn: HTMLButtonElement;
  private logPanel: HTMLElement;
  private rows: Row[] = [];
  private msg: { meta: DictLike; dict: DictLike; write: (opts?: unknown) => ArrayBuffer } | null = null;
  private lastKey = '';
  private token = 0;
  private editing = false;
  private log: LogEntry[] = [];
  private commitCb: ((blob: Blob, sourceKey: string) => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="hp-head">
        <input type="search" class="hp-search" placeholder="Filter by tag, name or value" aria-label="Filter DICOM tags" />
        <span class="hp-count" aria-live="polite"></span>
        <button type="button" class="hp-edit" aria-pressed="false" title="Admin mode: edit text and date tags">Edit</button>
        <button type="button" class="hp-regen" disabled title="Assign a new SOPInstanceUID to this object">Regen UID</button>
        <button type="button" class="hp-log" title="Change log">Log</button>
      </div>
      <div class="hp-scroll"><table class="hp-table"><tbody></tbody></table></div>
      <div class="hp-log-panel" hidden></div>`;
    this.search = root.querySelector('.hp-search')!;
    this.count = root.querySelector('.hp-count')!;
    this.editBtn = root.querySelector('.hp-edit')!;
    this.regenBtn = root.querySelector('.hp-regen')!;
    this.logBtn = root.querySelector('.hp-log')!;
    this.logPanel = root.querySelector('.hp-log-panel')!;
    this.body = root.querySelector('tbody')!;
    this.search.addEventListener('input', () => this.render());
    this.editBtn.addEventListener('click', () => this.setEditing(!this.editing));
    this.regenBtn.addEventListener('click', () => this.regenerateSopUid());
    this.logBtn.addEventListener('click', () => this.toggleLog());
    this.body.addEventListener('click', (e) => this.onCellClick(e));
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  /** Called with the edited blob and the imageId it was shown under, every time an edit commits. */
  onCommit(cb: (blob: Blob, sourceKey: string) => void): void {
    this.commitCb = cb;
  }

  /** Load the header for a blob. `key` de-duplicates repeated calls for the same image. */
  async show(blob: Blob | undefined, key: string): Promise<void> {
    if (!blob || key === this.lastKey) return;
    this.lastKey = key;
    const mine = ++this.token;
    try {
      const buffer = await blob.arrayBuffer();
      const msg = DicomMessage.readFile(buffer, { ignoreErrors: true });
      if (mine !== this.token) return;
      this.msg = msg;
      this.rows = buildRows(msg);
    } catch (e) {
      if (mine !== this.token) return;
      this.msg = null;
      this.rows = [];
      this.count.textContent = `Could not read header: ${e instanceof Error ? e.message : e}`;
      this.body.replaceChildren();
      return;
    }
    this.regenBtn.disabled = !this.editing;
    this.render();
  }

  private setEditing(v: boolean): void {
    this.editing = v;
    this.root.classList.toggle('editing', v);
    this.editBtn.setAttribute('aria-pressed', String(v));
    this.regenBtn.disabled = !v || !this.msg;
    this.render();
  }

  private toggleLog(): void {
    this.logPanel.hidden = !this.logPanel.hidden;
    this.logBtn.setAttribute('aria-pressed', String(!this.logPanel.hidden));
    this.renderLog();
  }

  private onCellClick(e: MouseEvent): void {
    if (!this.editing) return;
    const td = (e.target as HTMLElement).closest<HTMLTableCellElement>('td.hp-editable');
    if (!td || td.querySelector('input')) return;
    this.beginEdit(td);
  }

  private beginEdit(td: HTMLTableCellElement): void {
    const key = td.dataset.key!;
    const vr = td.dataset.vr!;
    const original = td.textContent ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original;
    input.className = 'hp-edit-input';
    td.textContent = '';
    td.append(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      if (commit && input.value !== original) this.commitEdit(key, vr, tagName(key), original, input.value);
      else this.render();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    };
    const onBlur = () => finish(true);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  private commitEdit(key: string, vr: string, name: string, oldValue: string, newValue: string): void {
    if (!this.msg) return;
    (this.msg as unknown as { upsertTag: (t: string, vr: string, v: unknown[]) => void }).upsertTag(key, vr, toValue(vr, newValue));
    this.afterMutate({ time: new Date().toLocaleTimeString(), tag: fmtTag(key), name, oldValue, newValue });
  }

  private regenerateSopUid(): void {
    if (!this.msg) return;
    const uid = newUid();
    const dict = this.msg as unknown as { upsertTag: (t: string, vr: string, v: unknown[]) => void };
    const oldValue = fmtValue('UI', this.msg.dict[SOP_INSTANCE_UID_TAG]?.Value);
    dict.upsertTag(SOP_INSTANCE_UID_TAG, 'UI', [uid]);
    if (this.msg.meta[MEDIA_SOP_INSTANCE_UID_TAG]) this.msg.meta[MEDIA_SOP_INSTANCE_UID_TAG].Value = [uid];
    this.afterMutate({ time: new Date().toLocaleTimeString(), tag: fmtTag(SOP_INSTANCE_UID_TAG), name: 'SOPInstanceUID', oldValue, newValue: uid });
  }

  private afterMutate(entry: LogEntry): void {
    if (!this.msg) return;
    this.log.unshift(entry);
    this.rows = buildRows(this.msg);
    this.render();
    this.renderLog();
    const bytes = this.msg.write();
    const blob = new Blob([bytes], { type: 'application/dicom' });
    this.commitCb?.(blob, this.lastKey);
  }

  private renderLog(): void {
    if (this.logPanel.hidden) {
      this.logBtn.textContent = this.log.length ? `Log (${this.log.length})` : 'Log';
      return;
    }
    this.logBtn.textContent = `Log (${this.log.length})`;
    if (!this.log.length) {
      this.logPanel.innerHTML = '<div class="hp-log-empty">No edits yet this session.</div>';
      return;
    }
    this.logPanel.innerHTML = this.log
      .map(
        (e) =>
          `<div class="hp-log-row"><span class="hp-log-time">${e.time}</span><span class="hp-log-tag">${e.tag}</span><span class="hp-log-name">${e.name}</span><span class="hp-log-change">"${e.oldValue}" → "${e.newValue}"</span></div>`,
      )
      .join('');
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
        val.className = r.editable && this.editing ? 'hp-value hp-editable' : 'hp-value';
        val.textContent = r.value;
        val.title = r.editable && this.editing ? `${r.value} — click to edit` : r.value;
        if (r.editable && this.editing) {
          val.dataset.key = r.key;
          val.dataset.vr = r.vr;
          val.tabIndex = 0;
        }
        tr.append(tag, name, val);
      }
      frag.append(tr);
    }
    this.body.replaceChildren(frag);
    this.count.textContent = q ? `${shown} of ${total} elements` : `${total} elements`;
  }
}
