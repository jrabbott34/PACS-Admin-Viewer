# Shell ↔ viewer bridge, v1

The contract between the Windows shell (`desktop/`, WPF + WebView2) and the web viewer (`src/`,
Cornerstone3D). Each side depends on this document and not on the other side's code. A different
viewer could replace the current one, or a different shell (another OS, another archive) could
replace this one, provided it follows this contract.

Host side: `desktop/src/PacsAdminViewer.Core/Bridge/BridgeProtocol.cs` and
`desktop/src/PacsAdminViewer.Desktop/ViewerHost.cs`. Viewer side: `src/host-bridge.ts`.

## Origins

| Origin | Served by | Purpose |
| --- | --- | --- |
| `https://app.pacs-viewer.example` | WebView2 virtual host mapped to the shell's `viewer\` folder (the `npm run build` output) | The viewer itself |
| `https://data.pacs-viewer.example` | The shell, via `WebResourceRequested`; never the network | DICOM files for the viewer |

`.example` is a reserved top-level domain, so neither name can ever resolve to a real server.
Microsoft recommends it for WebView2 virtual hosts. A `.local` name would go through mDNS.

The data origin answers exactly one request: `GET /instances/{id}`, where `{id}` matches
`[0-9A-Za-z._-]{1,128}` and has no query string. The response is one DICOM Part-10 file
(`application/dicom`, `Cache-Control: no-store`). Everything else is refused:

| Condition | Status |
| --- | --- |
| Any other request | 404 |
| No archive connected | 503 |
| The archive failed | 502 |
| Request from a foreign `Origin` | 403 |

The shell adds the archive's credentials to its own upstream request. They never reach the page.

The viewer refuses any `load-study` URL that isn't `https:` on a `*.pacs-viewer.example` host.
A compromised or confused host message therefore can't make the viewer contact the real network.

## Messages

All messages are JSON objects with `v: 1` and a `type`. The host sends them with
`PostWebMessageAsJson`, and the viewer uses `chrome.webview.postMessage`. Either side ignores
messages from the other side that don't carry its version, and the host logs a warning.

### Host → viewer

**`load-study`**: retrieve and display a set of instances. Loads run one at a time, in the order
they were received.

```json
{ "v": 1, "type": "load-study", "requestId": "3f2a…", "label": "Opening study from the archive…",
  "instances": [ { "url": "https://data.pacs-viewer.example/instances/0a1b…" } ] }
```

- `label` is optional status text. It must not contain patient details.
- The viewer fetches six instances at a time and ingests them without saving to its local
  library (`persist: false`), so archive images are never written into IndexedDB.
- It then opens the first loaded series in the active cell. If every instance was already open, it
  switches the active cell back to that series instead.

**`ping`**: the viewer replies `pong`.

### Viewer → host

| type | fields | when |
| --- | --- | --- |
| `viewer-ready` | `bridgeVersion`, `app` (`"pacs-admin-viewer"`), `appVersion` | Once per page load. The host queues `load-study` until it has seen this. |
| `load-progress` | `requestId`, `done`, `total` | Every 10 files and at the end |
| `load-result` | `requestId`, `ok: true`, `images` (newly added), `duplicates`, `series`, `skipped` | Load finished |
| `load-result` | `requestId`, `ok: false`, `error` | Load failed. The host substitutes its own, more specific archive error when it has one. |
| `pong` | | Reply to `ping` |
| `error` | `error`, `received` | Unrecognized message |

## Versioning

A breaking change (renamed fields, a changed meaning, a new required field) bumps `v`. Additive
optional fields don't. Each side must ignore fields it doesn't know.

## Outside the shell

In a normal browser tab `window.chrome.webview` doesn't exist, so `initHostBridge` returns
immediately. The browser build keeps its no-network-calls behavior.
