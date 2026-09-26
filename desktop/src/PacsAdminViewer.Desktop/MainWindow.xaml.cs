using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Media;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Bridge;
using PacsAdminViewer.Core.Logging;
using PacsAdminViewer.Core.Orthanc;
using PacsAdminViewer.Core.Security;

namespace PacsAdminViewer.Desktop;

public partial class MainWindow : Window
{
    private readonly ViewerHost _viewer;
    private OrthancArchive? _archive;
    private StudyBrowserWindow? _browser;

    public MainWindow()
    {
        InitializeComponent();
        _viewer = new ViewerHost(Web, Services.Log, () => _archive, Services.Paths.ViewerFolder, Services.Paths.DevServerUrl);
        _viewer.Status += SetStatus;
        _viewer.LoadFinished += OnLoadFinished;
        _viewer.Crashed += message => ShowProblem("The viewer stopped", message);
        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await _viewer.InitializeAsync(Services.Paths.WebViewData);
        }
        catch (ViewerStartException ex)
        {
            Services.Log.Error("Viewer failed to start", ex);
            ShowProblem("The viewer can't start", ex.Message);
            return;
        }
        catch (Exception ex)
        {
            Services.Log.Error("Viewer failed to start", ex);
            ShowProblem("The viewer can't start", $"{ex.Message}\n\nDetails were written to the log.");
            return;
        }
        await AutoConnectAsync();
    }

    private void OnClosing(object? sender, CancelEventArgs e) => _browser?.CloseForGood();

    // ---- archive connection ----

    /// <summary>
    /// "Connect automatically" with a saved password connects silently; without one, the Connect
    /// dialog opens pre-filled so the user only has to type the password.
    /// </summary>
    private async Task AutoConnectAsync()
    {
        var settings = Services.Settings.Load();
        if (!settings.ConnectOnStartup || !OrthancConnection.TryNormalizeBaseUri(settings.ServerUrl, out var baseUri, out _)) return;

        string? password = null;
        if (settings.Username.Length > 0)
        {
            password = settings.RememberPassword ? Services.Credentials.Load(CredentialKeys.ForArchive(baseUri!, settings.Username)) : null;
            if (password is null)
            {
                OpenConnectDialog();
                return;
            }
        }

        var archive = new OrthancArchive(Services.Http, new OrthancConnection(baseUri!, NullIfEmpty(settings.Username), password));
        SetStatus($"Connecting to {archive.Connection.DisplayName}…");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            var info = await archive.TestConnectionAsync(cts.Token);
            SetArchive(archive, info);
            SetStatus("");
        }
        catch (Exception ex) when (ex is ArchiveException or OperationCanceledException)
        {
            var reason = ex is ArchiveException ? ex.Message : "The server didn't respond in time.";
            Services.Log.Warn($"Automatic connection to {archive.Connection.DisplayName} failed: {reason}");
            SetStatus($"Couldn't connect automatically: {reason} Use Connect… to try again.");
        }
    }

    private void Connect_Click(object sender, RoutedEventArgs e) => OpenConnectDialog();

    private void OpenConnectDialog()
    {
        var dialog = new ConnectWindow { Owner = this };
        if (dialog.ShowDialog() != true || dialog.Archive is null || dialog.Info is null) return;
        SetArchive(dialog.Archive, dialog.Info);
        SetStatus("");
        OpenBrowser();
    }

    private void SetArchive(OrthancArchive archive, ArchiveInfo info)
    {
        _archive = archive;
        // A browser window is bound to the archive it was opened with.
        _browser?.CloseForGood();
        _browser = null;

        var c = archive.Connection;
        ConnectionText.Text = $"{info.Name} {info.Version} · {c.DisplayName}";
        ConnectionText.Foreground = (Brush)FindResource("TextBrush");
        ConnectionDot.Fill = (Brush)FindResource("AccentBrush");
        ConnectButton.Content = "Connection…";
        ConnectButton.Style = (Style)FindResource("ShellButton");
        BrowseButton.IsEnabled = true;
        Services.Log.Info($"Connected to {c.DisplayName} ({info.Name} {info.Version}){(c.HasCredentials ? " with credentials" : "")}");
    }

    // ---- study browser → viewer ----

    private void Browse_Click(object sender, RoutedEventArgs e) => OpenBrowser();

    private void OpenBrowser()
    {
        if (_archive is null) return;
        _browser ??= new StudyBrowserWindow(_archive, SendToViewer) { Owner = this };
        _browser.Show();
        _browser.Activate();
    }

    internal void SendToViewer(LoadRequest request)
    {
        SetStatus($"Retrieving {request.InstanceCount} image{(request.InstanceCount == 1 ? "" : "s")} from the archive…");
        _viewer.Load(request);
        if (!_viewer.IsReady) SetStatus("Waiting for the viewer to start…");
        Activate();
    }

    private void OnLoadFinished(LoadOutcome outcome)
    {
        if (!outcome.Ok)
        {
            SetStatus("Couldn't open the study.");
            MessageBox.Show(this, $"The study couldn't be opened.\n\n{outcome.Error}", "PACS Admin Viewer",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        SetStatus(outcome.Images == 0 && outcome.Duplicates > 0
            ? "That study is already open."
            : $"Opened {outcome.Images} image{(outcome.Images == 1 ? "" : "s")} in {outcome.Series} series.");
    }

    // ---- misc ----

    private void SetStatus(string text) => StatusText.Text = text;

    private void ShowProblem(string title, string text)
    {
        ProblemTitle.Text = title;
        ProblemText.Text = text;
        Web.Visibility = Visibility.Collapsed;
        ProblemPanel.Visibility = Visibility.Visible;
    }

    private void Logs_Click(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(Services.Paths.Logs);
        Process.Start(new ProcessStartInfo(Services.Paths.Logs) { UseShellExecute = true });
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        MessageBox.Show(this,
            $"PACS Admin DICOM Viewer\nVersion {AppInfo.Version}\nCreated by Jason Abbott\n\n" +
            $"Viewer: {_viewer.ViewerVersion ?? "not loaded"} (Cornerstone3D)\n" +
            $"WebView2 runtime: {_viewer.RuntimeVersion ?? "not found"}\n\n" +
            "Not for diagnostic use.",
            "About PACS Admin Viewer", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;
}
