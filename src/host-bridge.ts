/**
 * Bridge to a native host — the Windows desktop shell (WPF + WebView2) in `desktop/`.
 *
 * In a plain browser tab this module does nothing: `initHostBridge` returns immediately
 * when `window.chrome.webview` is absent, so the browser build keeps its "no network
 * calls" guarantee. Inside the shell, the host owns archive access (Orthanc URL,
 * credentials, search) and only ever hands the viewer opaque URLs, each of which returns
 * one DICOM Part-10 file. The viewer never learns what's behind them, which is what lets
 * either side be replaced independently. Contract: desktop/BRIDGE.md.
 */

export const BRIDGE_VERSION = 1;

/** Host-provided URLs must stay on the shell's intercepted fake origins — never the real network. */
const ALLOWED_HOST_SUFFIX = '.pacs-viewer.example';
const FETCH_CONCURRENCY = 6;

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

declare global {
  interface Window {
    chrome?: { webview?: WebViewBridge };
  }
}

export interface LoadStudyMessage {
  v: 1;
  type: 'load-study';
  requestId: string;
  label?: string;
  instances: { url: string }[];
}

export interface LoadResult {
  images: number;
  duplicates: number;
  series: number;
  skipped: number;
}

export interface HostBridgeHandlers {
  appVersion: string;
  status(message: string): void;
  load(files: File[], opts: { label?: string }): Promise<LoadResult>;
}

export function isAllowedHostUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.endsWith(ALLOWED_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function isLoadStudy(msg: unknown): msg is LoadStudyMessage {
  const m = msg as Partial<LoadStudyMessage> | null;
  return (
    !!m &&
    m.v === 1 &&
    m.type === 'load-study' &&
    typeof m.requestId === 'string' &&
    Array.isArray(m.instances) &&
    m.instances.every((i) => i && typeof i.url === 'string')
  );
}

async function fetchAll(
  urls: string[],
  onProgress: (done: number, total: number) => void,
): Promise<File[]> {
  const files: File[] = new Array(urls.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const res = await fetch(urls[i]);
      if (!res.ok) throw new Error(`Archive returned ${res.status} for image ${i + 1} of ${urls.length}`);
      files[i] = new File([await res.blob()], `instance-${i + 1}.dcm`, { type: 'application/dicom' });
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker));
  return files;
}

export function initHostBridge(handlers: HostBridgeHandlers): boolean {
  const webview = window.chrome?.webview;
  if (!webview) return false;
  const post = (message: object) => webview.postMessage({ v: BRIDGE_VERSION, ...message });

  // One load at a time, in the order the host sent them.
  let queue: Promise<void> = Promise.resolve();

  const handleLoad = async (msg: LoadStudyMessage): Promise<void> => {
    const { requestId } = msg;
    const urls = msg.instances.map((i) => i.url);
    const rejected = urls.filter((u) => !isAllowedHostUrl(u));
    if (rejected.length) {
      post({ type: 'load-result', requestId, ok: false, error: `Refused ${rejected.length} URL(s) outside the host's data origin` });
      return;
    }
    if (!urls.length) {
      post({ type: 'load-result', requestId, ok: false, error: 'No images to load' });
      return;
    }
    try {
      handlers.status(`Retrieving ${urls.length} image${urls.length === 1 ? '' : 's'} from the archive…`);
      const files = await fetchAll(urls, (done, total) => {
        if (done % 10 === 0 || done === total) {
          handlers.status(`Retrieving from the archive… ${done} / ${total}`);
          post({ type: 'load-progress', requestId, done, total });
        }
      });
      const result = await handlers.load(files, { label: msg.label });
      post({ type: 'load-result', requestId, ok: true, ...result });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      handlers.status(`Couldn't load from the archive: ${error}`);
      post({ type: 'load-result', requestId, ok: false, error });
    }
  };

  webview.addEventListener('message', (e) => {
    const msg = e.data;
    if (isLoadStudy(msg)) {
      queue = queue.then(() => handleLoad(msg));
    } else if ((msg as { type?: string } | null)?.type === 'ping') {
      post({ type: 'pong' });
    } else {
      post({ type: 'error', error: 'Unrecognized or unsupported message', received: (msg as { type?: string })?.type ?? null });
    }
  });

  post({ type: 'viewer-ready', bridgeVersion: BRIDGE_VERSION, app: 'pacs-admin-viewer', appVersion: handlers.appVersion });
  return true;
}
