"""Web half of the desktop-shell bridge (desktop/BRIDGE.md), with WebView2 faked.

Run from samples/:  python3 ../tests/e2e/e2e_bridge.py http://localhost:5173/
"""
import glob
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
DATA = "https://data.pacs-viewer.example"

FAKE_WEBVIEW = """
window.__hostMessages = [];
const listeners = [];
window.chrome = window.chrome || {};
window.chrome.webview = {
  postMessage: (m) => window.__hostMessages.push(JSON.parse(JSON.stringify(m))),
  addEventListener: (t, l) => { if (t === 'message') listeners.push(l); },
};
window.__hostSend = (data) => listeners.forEach((l) => l({ data }));
"""

ct = sorted(glob.glob("ct/*.dcm"))[:3]
files = {f"/instances/ct-{i}": open(p, "rb").read() for i, p in enumerate(ct)}
fetched = []


def route(r):
    path = r.request.url[len(DATA):]
    fetched.append(path)
    body = files.get(path)
    headers = {"Access-Control-Allow-Origin": "*"}
    if body is None:
        r.fulfill(status=404, body="", headers=headers)
    else:
        r.fulfill(status=200, body=body, headers={**headers, "Content-Type": "application/dicom"})


def wait_result(pg, req):
    pg.wait_for_function(
        "(id) => window.__hostMessages.some((m) => m.type === 'load-result' && m.requestId === id)", arg=req, timeout=20000
    )
    return pg.evaluate("(id) => window.__hostMessages.find((m) => m.type === 'load-result' && m.requestId === id)", req)


def send(pg, msg):
    pg.evaluate("(m) => window.__hostSend(m)", msg)


with sync_playwright() as p:
    b = p.chromium.launch(
        executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
    )
    pg = b.new_page(viewport={"width": 1440, "height": 860})
    errs = []
    pg.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))
    pg.add_init_script(FAKE_WEBVIEW)
    pg.route(f"{DATA}/**", route)
    pg.goto(BASE)
    pg.wait_for_function("window.__hostMessages.some((m) => m.type === 'viewer-ready')", timeout=20000)
    ready = pg.evaluate("window.__hostMessages.find((m) => m.type === 'viewer-ready')")
    print("viewer-ready:", ready)

    # 1. Load a study — splash is still up; the host load should dismiss it by itself.
    send(pg, {"v": 1, "type": "load-study", "requestId": "r1", "label": "Opening test study…",
              "instances": [{"url": f"{DATA}{k}"} for k in files]})
    res = wait_result(pg, "r1")
    print("r1:", res)
    pg.wait_for_timeout(600)
    print("splash dismissed:", pg.evaluate("!document.getElementById('splash') || document.getElementById('splash').classList.contains('hide')"))
    series = pg.evaluate("window.__viewer.activeCell.series && window.__viewer.activeCell.series.seriesDescription")
    print("active cell shows:", series)
    progress = pg.evaluate("window.__hostMessages.filter((m) => m.type === 'load-progress' && m.requestId === 'r1')")
    print("progress messages:", progress)

    # 2. persist:false — nothing written to IndexedDB.
    stored = pg.evaluate("""() => new Promise((res) => {
        const r = indexedDB.open('pacs-admin-viewer');
        r.onsuccess = () => { const db = r.result;
          if (!db.objectStoreNames.contains('blobs')) return res(0);
          const c = db.transaction('blobs').objectStore('blobs').count(); c.onsuccess = () => res(c.result); };
        r.onerror = () => res(-1); })""")
    print("blobs persisted to IndexedDB:", stored)

    # 3. Re-open the same study while another series is showing — duplicates, but it still opens.
    pg.set_input_files("#file-input", ["xr/xr_001.dcm"])
    pg.wait_for_timeout(800)
    pg.click(".series-item >> text=PA chest")
    pg.wait_for_timeout(400)
    send(pg, {"v": 1, "type": "load-study", "requestId": "r2",
              "instances": [{"url": f"{DATA}{k}"} for k in files]})
    print("r2:", wait_result(pg, "r2"))
    pg.wait_for_timeout(400)
    print("active cell after re-open:", pg.evaluate("window.__viewer.activeCell.series.seriesDescription"))

    # 4. URLs off the host's data origin are refused before any fetch.
    n_before = len(fetched)
    send(pg, {"v": 1, "type": "load-study", "requestId": "r3", "instances": [{"url": "https://example.com/x.dcm"}]})
    print("r3:", wait_result(pg, "r3"), "| fetches made:", len(fetched) - n_before)

    # 5. An archive error is reported, not swallowed.
    send(pg, {"v": 1, "type": "load-study", "requestId": "r4", "instances": [{"url": f"{DATA}/instances/missing"}]})
    print("r4:", wait_result(pg, "r4"))

    # 6. Garbage / unknown messages get an error reply, and ping gets pong.
    send(pg, {"hello": 1})
    send(pg, {"v": 1, "type": "ping"})
    pg.wait_for_timeout(200)
    print("error+pong:", pg.evaluate("window.__hostMessages.filter((m) => m.type === 'error' || m.type === 'pong').map((m) => m.type)"))
    b.close()
    print("ERRORS:", errs)
