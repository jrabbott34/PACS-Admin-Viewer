using System.IO;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Bridge;
using PacsAdminViewer.Core.Logging;

namespace PacsAdminViewer.Desktop;

public sealed record LoadOutcome(string RequestId, bool Ok, int Images, int Duplicates, int Series, string? Error);

/// <summary>Why the viewer couldn't be started, in words fit for the window itself.</summary>
public sealed class ViewerStartException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Hosts the web viewer (the imaging engine) in WebView2 and implements the host side of the
/// bridge (desktop/BRIDGE.md). This is the only class that knows the viewer is a web page:
/// it serves the static build from a virtual host, answers the viewer's image requests from
/// the archive (credentials stay here, never in JavaScript), and exchanges versioned JSON
/// messages. Swapping or upgrading the viewer means keeping to that contract, nothing more.
/// </summary>
internal sealed class ViewerHost
{
    private readonly WebView2 _web;
    private readonly IAppLog _log;
    private readonly Func<IImageArchive?> _archive;
    private readonly string _viewerFolder;
    private readonly string? _devUrl;
    private readonly string? _devOrigin;
    private readonly Queue<LoadRequest> _pending = new();
    private bool _ready;
    private string? _lastProxyError;

    public ViewerHost(WebView2 web, IAppLog log, Func<IImageArchive?> archive, string viewerFolder, string? devUrl)
    {
        _web = web;
        _log = log;
        _archive = archive;
        _viewerFolder = viewerFolder;
        _devUrl = devUrl;
        _devOrigin = devUrl is null ? null : new Uri(devUrl).GetLeftPart(UriPartial.Authority);
    }

    /// <summary>Progress text for the shell's status line.</summary>
    public event Action<string>? Status;

    public event Action<LoadOutcome>? LoadFinished;

    /// <summary>The WebView2 browser process died; the window needs restarting.</summary>
    public event Action<string>? Crashed;

    public string? RuntimeVersion { get; private set; }
    public string? ViewerVersion { get; private set; }
    public bool IsReady => _ready;

    private string StartUrl => _devUrl is not null ? _devUrl + "/" : BridgeProtocol.AppOrigin + "/index.html";

    public async Task InitializeAsync(string userDataFolder)
    {
        try
        {
            RuntimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException ex)
        {
            throw new ViewerStartException(
                "The Microsoft Edge WebView2 Runtime isn't installed. It ships with Windows 11 and current Windows 10; " +
                "otherwise install the \"Evergreen\" runtime from Microsoft (search \"WebView2 Runtime download\") and restart this app.", ex);
        }
        if (_devUrl is null && !File.Exists(Path.Combine(_viewerFolder, "index.html")))
        {
            throw new ViewerStartException($"The viewer files are missing from {_viewerFolder}. Reinstall the app.");
        }

        _web.DefaultBackgroundColor = System.Drawing.Color.Black; // no white flash before the viewer paints
        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;

        var devTools = _devUrl is not null || Environment.GetEnvironmentVariable("PACS_VIEWER_DEVTOOLS") == "1";
#if DEBUG
        devTools = true;
#endif
        var s = core.Settings;
        s.AreDevToolsEnabled = devTools;
        s.AreDefaultContextMenusEnabled = devTools;
        // Off in normal use: F5/Ctrl+R would reload the page and drop every study retrieved
        // from the archive (those deliberately aren't saved to disk).
        s.AreBrowserAcceleratorKeysEnabled = devTools;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;

        core.SetVirtualHostNameToFolderMapping(BridgeProtocol.AppHost, _viewerFolder, CoreWebView2HostResourceAccessKind.DenyCors);
        core.AddWebResourceRequestedFilter(BridgeProtocol.DataOrigin + "/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += (_, e) => e.Handled = true; // the viewer never opens windows; nothing else may
        core.ProcessFailed += OnProcessFailed;

        _log.Info($"WebView2 runtime {RuntimeVersion}; loading viewer from {(_devUrl is null ? "bundled files" : _devUrl)}");
        core.Navigate(StartUrl);
    }

    /// <summary>Queue a study for the viewer; sent as soon as the viewer says it's ready.</summary>
    public void Load(LoadRequest request)
    {
        _lastProxyError = null;
        if (_ready) Post(request);
        else _pending.Enqueue(request);
    }

    private void Post(LoadRequest request)
    {
        _log.Info($"Sending {request.InstanceCount} image(s) to the viewer (request {request.RequestId})");
        _web.CoreWebView2.PostWebMessageAsJson(request.MessageJson);
    }

    private bool IsViewerOrigin(string? origin) => BridgeProtocol.IsAllowedViewerOrigin(origin, _devOrigin);

    private bool IsViewerUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && IsViewerOrigin(u.GetLeftPart(UriPartial.Authority));

    // ---- the data origin: https://data.pacs-viewer.example/instances/{id} ----

    private async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var env = _web.CoreWebView2.Environment;
        // Only the viewer's own pages can reach this (navigation is locked to them), so an
        // absent Origin is the viewer too; a present, foreign one is refused.
        var origin = e.Request.Headers.Contains("Origin") ? e.Request.Headers.GetHeader("Origin") : _devOrigin ?? BridgeProtocol.AppOrigin;
        if (!IsViewerOrigin(origin))
        {
            e.Response = env.CreateWebResourceResponse(null, 403, "Forbidden", "");
            return;
        }
        var cors = $"Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nCache-Control: no-store";
        if (!BridgeProtocol.TryParseInstanceRequest(e.Request.Method, e.Request.Uri, out var instanceId))
        {
            e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", cors);
            return;
        }
        var archive = _archive();
        if (archive is null)
        {
            e.Response = env.CreateWebResourceResponse(null, 503, "Not Connected", cors);
            return;
        }

        var deferral = e.GetDeferral();
        try
        {
            var bytes = await archive.GetInstanceFileAsync(instanceId);
            e.Response = env.CreateWebResourceResponse(new MemoryStream(bytes, writable: false), 200, "OK",
                cors + "\r\nContent-Type: application/dicom");
        }
        catch (ArchiveException ex)
        {
            _lastProxyError = ex.Message;
            _log.Warn($"Instance retrieval failed ({ex.StatusCode?.ToString() ?? "network"}): {ex.Message}");
            e.Response = env.CreateWebResourceResponse(null, 502, "Bad Gateway", cors);
        }
        catch (Exception ex)
        {
            _lastProxyError = "Retrieving an image failed unexpectedly. See the log for details.";
            _log.Error("Instance retrieval failed unexpectedly", ex);
            e.Response = env.CreateWebResourceResponse(null, 500, "Internal Error", cors);
        }
        finally
        {
            deferral.Complete();
        }
    }

    // ---- messages from the viewer ----

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsViewerUrl(e.Source)) return;
        var msg = BridgeProtocol.ParseViewerMessage(e.WebMessageAsJson);
        if (msg is null)
        {
            _log.Warn("Ignored a malformed or unversioned message from the viewer");
            return;
        }

        switch (msg.Type)
        {
            case "viewer-ready":
                ViewerVersion = msg.AppVersion;
                _log.Info($"Viewer {msg.AppVersion} ready (bridge v{msg.BridgeVersion})");
                if (msg.BridgeVersion != BridgeProtocol.Version)
                {
                    _log.Warn($"Viewer speaks bridge v{msg.BridgeVersion}, shell expects v{BridgeProtocol.Version}");
                }
                _ready = true;
                while (_pending.TryDequeue(out var next)) Post(next);
                break;

            case "load-progress":
                Status?.Invoke($"Retrieving images… {msg.Done} / {msg.Total}");
                break;

            case "load-result":
                var ok = msg.Ok == true;
                // The viewer only sees "502 for image 3 of 40"; the host knows the actual reason.
                var error = ok ? null : _lastProxyError ?? msg.Error ?? "The viewer couldn't load the study.";
                if (ok) _log.Info($"Viewer loaded {msg.Images} image(s) in {msg.Series} series ({msg.Duplicates} already open, {msg.Skipped} skipped)");
                else _log.Warn($"Viewer load failed: {msg.Error}");
                LoadFinished?.Invoke(new LoadOutcome(msg.RequestId ?? "", ok, msg.Images ?? 0, msg.Duplicates ?? 0, msg.Series ?? 0, error));
                break;

            case "error":
                _log.Warn($"Viewer reported a bridge error: {msg.Error}");
                break;
        }
    }

    // ---- keep the WebView pointed at the viewer and nothing else ----

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!IsViewerUrl(e.Uri))
        {
            e.Cancel = true;
            var scheme = Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) ? u.Scheme : "?";
            _log.Warn($"Blocked navigation away from the viewer (scheme {scheme})");
            return;
        }
        _ready = false; // (re)loading: wait for a fresh viewer-ready before sending anything
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        _log.Error($"WebView2 process failed: {e.ProcessFailedKind} ({e.Reason}, exit {e.ExitCode})");
        switch (e.ProcessFailedKind)
        {
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                _ready = false;
                Crashed?.Invoke("The viewer stopped unexpectedly. Close and reopen the app to continue.");
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                Status?.Invoke("The viewer stopped responding and was restarted. Reopen the study to continue.");
                _web.CoreWebView2.Reload();
                break;
        }
    }
}
