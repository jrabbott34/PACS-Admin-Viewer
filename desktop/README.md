# PACS Admin Viewer for Windows

A native Windows app around the web viewer. The Cornerstone3D viewer in `../src` is the imaging
engine and stays exactly as it is: every tool, layout, shortcut and export works the same.
The Windows shell adds what a browser tab can't:

- **Connect to Orthanc** (Connect…) with an address, username and password. You can paste the
  Orthanc Explorer URL you already use, e.g. `http://192.168.1.20:8042/app/explorer.html`. The
  app always tests the connection before saving it.
- **Study browser.** Search by patient name, patient ID, accession number and date range, then
  open a whole study or selected series in the viewer. Double-click or Enter also opens.
- **Credentials handled natively.**
  - The password never touches JavaScript, the settings file or the log.
  - It's only saved if you tick *Remember password*. It is then encrypted with Windows DPAPI for
    your Windows account.
  - Nothing is hard-coded.
- **Logs** (Logs button), kept for 14 days under `%LOCALAPPDATA%\PacsAdminViewer\logs`. They
  never contain passwords or patient details.
- **An MSI** that installs to Program Files with a Start menu shortcut and upgrades in place.

Not for diagnostic use.

## Install

1. Download the latest build from GitHub: **Actions → Desktop (Windows) → the newest green run →
   Artifacts**.
   - `PacsAdminViewer-<version>-msi` contains the installer. Run it.
   - `PacsAdminViewer-<version>-portable-x64` is the same app as a folder. Run
     `PacsAdminViewer.exe` from it, with no install.
2. The builds aren't code-signed yet, so SmartScreen may say "Windows protected your PC". Choose
   **More info → Run anyway**.
3. The app needs the Microsoft Edge **WebView2 Runtime**, which Windows 11 and current Windows 10
   already have. If it's missing, the window says so and explains where to get it.

## Where things live

| What | Where |
| --- | --- |
| App | `C:\Program Files\PACS Admin Viewer\` (MSI) or wherever you unzipped it |
| Settings: server, username, options | `%APPDATA%\PacsAdminViewer\settings.json` |
| Saved password (only if remembered, DPAPI-encrypted) | `%APPDATA%\PacsAdminViewer\credentials.json` |
| Logs | `%LOCALAPPDATA%\PacsAdminViewer\logs\app-YYYYMMDD.log` |
| Viewer profile (local library of *imported files*, cache) | `%LOCALAPPDATA%\PacsAdminViewer\WebView2\` |

Studies opened **from Orthanc aren't saved** to the local library. They stay in memory until you
close the app, and the archive remains the copy of record. Files you import yourself (Menu →
Open files/folder) are saved to the local library, the same as in the browser version.

Uninstalling leaves the per-user folders above in place. Delete them by hand to remove
everything.

## Architecture

```
┌─────────────── PacsAdminViewer.exe (WPF, .NET 8) ───────────────┐
│ Shell bar: Connect… · Study browser · status · Logs · About     │
│ ┌─────────────────────────── WebView2 ────────────────────────┐ │
│ │  https://app.pacs-viewer.example  →  viewer\ (npm build)    │ │
│ │  Cornerstone3D viewer, unchanged: tools, layouts, export…   │ │
│ │     ▲ load-study {urls}          │ fetch data.pacs-viewer…  │ │
│ └─────┼────────────────────────────┼──────────────────────────┘ │
│   ViewerHost ◄── viewer-ready / load-result ── WebResourceRequested
│       │                                          │ + Basic auth │
│   IImageArchive (OrthancArchive) ────────────────┘              │
└──────────────────────────────────┬──────────────────────────────┘
                                   ▼  Orthanc REST: /tools/find, /studies, /series, /instances/{id}/file
```

| Project | Role |
| --- | --- |
| `src/PacsAdminViewer.Core` | Platform-neutral `net8.0`, unit-tested on any OS: the `IImageArchive` interface and its Orthanc REST implementation, address normalization, the bridge protocol, settings, the credential-store interface, and the file log |
| `src/PacsAdminViewer.Desktop` | WPF on Windows only: the windows, `ViewerHost` (WebView2 + bridge + data proxy), `DpapiCredentialStore`, and app paths |
| `tests/PacsAdminViewer.Core.Tests` | xUnit tests for Core against a fake HTTP handler |
| `installer` | WiX 5 MSI |

**Separation.** The shell and the viewer only meet at the [bridge contract](BRIDGE.md): a static
folder served on one origin, DICOM files on another, and a handful of versioned JSON messages.
- **Upgrading the viewer** means rebuilding `dist/`; the shell doesn't change.
- **Replacing the viewer** means shipping something that follows BRIDGE.md.
- **Supporting a different archive** (DICOMweb, another PACS) means a new `IImageArchive`
  implementation. The windows and the viewer don't change.

Orthanc is reached through its core REST API rather than the DICOMweb plugin, so the app works
against any Orthanc install.

## Build

Visual Studio isn't required. You need the .NET 8 SDK and Node 22.

```powershell
# from the repository root
npm ci
npm run build                                  # the viewer -> dist\
dotnet test desktop\tests\PacsAdminViewer.Core.Tests\PacsAdminViewer.Core.Tests.csproj
dotnet run --project desktop\src\PacsAdminViewer.Desktop      # Debug build, runs the app

# the same release build CI makes
dotnet publish desktop\src\PacsAdminViewer.Desktop\PacsAdminViewer.Desktop.csproj -c Release -r win-x64 --self-contained -o desktop\artifacts\publish
dotnet build desktop\installer\PacsAdminViewer.Installer.wixproj -c Release -o desktop\artifacts\msi
```

A Release build stops with an error if `dist\index.html` is missing. This is deliberate, so you
can't ship an empty window.

The Core library and its tests build on Linux and macOS too. The WPF project and the MSI only
build on Windows (CI uses `windows-latest`).

**Viewer development inside the shell.** Run `npm run dev` in the repo root, then start the app with
`PACS_VIEWER_DEV_URL=http://localhost:5173`. The shell loads the dev server, with hot reload,
instead of the bundled files, and turns on DevTools (F12). To get DevTools in an installed build
for troubleshooting, set `PACS_VIEWER_DEVTOOLS=1`.

**CI** is `.github/workflows/desktop.yml`, which runs on every push. It:
1. builds the viewer;
2. tests Core;
3. publishes a self-contained win-x64 app;
4. checks that the viewer was bundled;
5. builds the MSI;
6. uploads both.

The version is `major.minor` from `package.json` plus the run number, so each MSI upgrades the
last.

## Verified / not verified

**Verified**
- Core has 64 unit tests: Orthanc queries, errors and paths; address normalization; bridge
  parsing and refusal rules; settings and credential keys; log retention.
- The viewer's half of the bridge runs in headless Chromium with WebView2 faked
  (`tests/e2e/e2e_bridge.py`). It checks:
  - `viewer-ready`, then a load that opens the series and dismisses the splash;
  - nothing is persisted to IndexedDB;
  - re-opening a study switches back to it;
  - foreign URLs are refused without being fetched;
  - archive errors are reported.

The WPF code was type-checked against the Windows reference assemblies and compiles on
`windows-latest` in CI.

**Not verified yet**
- Running the app on a real Windows desktop.
- A real Orthanc server. The sandbox these were built in can't reach one, so the Orthanc client is
  tested against recorded response shapes.
- Installing, upgrading and uninstalling the MSI.
- WebView2's actual handling of the data-origin proxy (CORS headers, deferrals) and of the
  virtual host serving the viewer's workers and WASM codecs.

These need a first run on Windows against your Orthanc.

## Not built yet / next

- Code signing, which would remove the SmartScreen warning. It needs a certificate.
- An auto-update check.
- Remembering the window size and position.
- Custom installer UI; the MSI currently installs with the default progress dialog.
- Sending edited or anonymized DICOM back to Orthanc (STOW / `POST /instances`).
- DICOMweb as a second `IImageArchive` for other PACS.
- Retrieving very large studies (hundreds of MB) streams through memory one instance at a time.
  This is fine for typical studies, untested at scale.
