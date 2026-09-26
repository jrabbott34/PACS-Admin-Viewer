using System.Windows;
using System.Windows.Media;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Logging;
using PacsAdminViewer.Core.Orthanc;
using PacsAdminViewer.Core.Security;
using PacsAdminViewer.Core.Settings;

namespace PacsAdminViewer.Desktop;

/// <summary>
/// Orthanc address and credentials. Connect always tests first, so a saved configuration is
/// one that worked. The password is kept only in memory unless "Remember password" is ticked,
/// and then only DPAPI-encrypted (see DpapiCredentialStore) — never in settings.json or the log.
/// </summary>
public partial class ConnectWindow : Window
{
    private CancellationTokenSource? _cts;

    public ConnectWindow()
    {
        InitializeComponent();
        var s = Services.Settings.Load();
        ServerBox.Text = s.ServerUrl;
        UserBox.Text = s.Username;
        RememberBox.IsChecked = s.RememberPassword;
        AutoBox.IsChecked = s.ConnectOnStartup;
        if (s.RememberPassword && s.Username.Length > 0 && OrthancConnection.TryNormalizeBaseUri(s.ServerUrl, out var uri, out _))
        {
            PasswordInput.Password = Services.Credentials.Load(CredentialKeys.ForArchive(uri!, s.Username)) ?? "";
        }

        Loaded += (_, _) =>
        {
            UIElement first = ServerBox.Text.Length == 0 ? ServerBox
                : UserBox.Text.Length > 0 && PasswordInput.Password.Length == 0 ? PasswordInput
                : ConnectButton;
            first.Focus();
        };
        Closed += (_, _) => _cts?.Cancel();
    }

    /// <summary>Set when the dialog closes with a working connection.</summary>
    internal OrthancArchive? Archive { get; private set; }

    internal ArchiveInfo? Info { get; private set; }

    private async void Test_Click(object sender, RoutedEventArgs e)
    {
        if (TryBuild() is { } archive) await TestAsync(archive);
    }

    private async void Connect_Click(object sender, RoutedEventArgs e)
    {
        if (TryBuild() is not { } archive) return;
        var info = await TestAsync(archive);
        if (info is null || !IsVisible) return;

        var c = archive.Connection;
        var remember = RememberBox.IsChecked == true && c.HasCredentials && !string.IsNullOrEmpty(c.Password);
        try
        {
            Services.Settings.Save(new AppSettings
            {
                ServerUrl = c.BaseUri.ToString(),
                Username = c.Username ?? "",
                RememberPassword = remember,
                ConnectOnStartup = AutoBox.IsChecked == true,
            });
            if (c.HasCredentials)
            {
                var key = CredentialKeys.ForArchive(c.BaseUri, c.Username!);
                if (remember) Services.Credentials.Save(key, c.Password!);
                else Services.Credentials.Delete(key);
            }
        }
        catch (Exception ex)
        {
            // Still connect: failing to remember settings shouldn't block this session.
            Services.Log.Warn("Couldn't save connection settings", ex);
            MessageBox.Show(this, $"Connected, but the settings couldn't be saved: {ex.Message}", Title,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        Archive = archive;
        Info = info;
        DialogResult = true;
    }

    private OrthancArchive? TryBuild()
    {
        if (!OrthancConnection.TryNormalizeBaseUri(ServerBox.Text, out var baseUri, out var error))
        {
            ShowResult(error!, Outcome.Bad);
            ServerBox.Focus();
            return null;
        }
        var user = UserBox.Text.Trim();
        if (user.Length == 0 && PasswordInput.Password.Length > 0)
        {
            ShowResult("Enter the username that goes with this password.", Outcome.Bad);
            UserBox.Focus();
            return null;
        }
        return new OrthancArchive(Services.Http, new OrthancConnection(baseUri!, user.Length > 0 ? user : null, PasswordInput.Password));
    }

    private async Task<ArchiveInfo?> TestAsync(OrthancArchive archive)
    {
        _cts?.Cancel();
        var cts = _cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        SetBusy(true);
        ShowResult($"Connecting to {archive.Connection.DisplayName}…", Outcome.Neutral);
        try
        {
            var info = await archive.TestConnectionAsync(cts.Token);
            ShowResult($"Connected to {info.Name} (Orthanc {info.Version}).", Outcome.Good);
            return info;
        }
        catch (Exception ex) when (ex is ArchiveException or OperationCanceledException)
        {
            var reason = ex is ArchiveException ? ex.Message : $"{archive.Connection.DisplayName} didn't respond in time.";
            Services.Log.Warn($"Connection test to {archive.Connection.DisplayName} failed: {reason}");
            if (IsLoaded) ShowResult(reason, Outcome.Bad);
            return null;
        }
        finally
        {
            if (IsLoaded) SetBusy(false);
        }
    }

    private enum Outcome { Neutral, Good, Bad }

    private void ShowResult(string text, Outcome outcome)
    {
        ResultText.Text = text;
        ResultText.Foreground = outcome switch
        {
            Outcome.Good => Brushes.ForestGreen,
            Outcome.Bad => Brushes.Firebrick,
            _ => SystemColors.ControlTextBrush,
        };
    }

    private void SetBusy(bool busy)
    {
        TestButton.IsEnabled = !busy;
        ConnectButton.IsEnabled = !busy;
        Cursor = busy ? System.Windows.Input.Cursors.AppStarting : null;
    }
}
