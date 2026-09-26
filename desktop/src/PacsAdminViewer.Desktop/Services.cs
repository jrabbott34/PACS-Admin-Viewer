using System.IO;
using System.Net.Http;
using System.Reflection;
using PacsAdminViewer.Core.Logging;
using PacsAdminViewer.Core.Security;
using PacsAdminViewer.Core.Settings;

namespace PacsAdminViewer.Desktop;

/// <summary>Where things live on disk. Nothing is written next to the exe (Program Files is read-only).</summary>
internal sealed class AppPaths
{
    public string Roaming { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PacsAdminViewer");
    public string Local { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PacsAdminViewer");

    public string SettingsFile => Path.Combine(Roaming, "settings.json");
    public string CredentialsFile => Path.Combine(Roaming, "credentials.json");
    public string Logs => Path.Combine(Local, "logs");

    /// <summary>
    /// WebView2's profile (the viewer's IndexedDB library, cache). Must be set explicitly: the
    /// default is a folder next to the exe, which isn't writable once installed.
    /// </summary>
    public string WebViewData => Path.Combine(Local, "WebView2");

    public string ViewerFolder => Path.Combine(AppContext.BaseDirectory, "viewer");

    /// <summary>Development only: point the shell at `npm run dev` instead of the bundled build.</summary>
    public string? DevServerUrl => Environment.GetEnvironmentVariable("PACS_VIEWER_DEV_URL") is { Length: > 0 } url ? url.TrimEnd('/') : null;
}

internal static class AppInfo
{
    public static string Version { get; } = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
}

/// <summary>App-wide services, created once at startup.</summary>
internal static class Services
{
    public static AppPaths Paths { get; } = new();
    public static IAppLog Log { get; private set; } = null!;
    public static SettingsStore Settings { get; private set; } = null!;
    public static ICredentialStore Credentials { get; private set; } = null!;

    /// <summary>One client for the app's lifetime (connection pooling); archives share it.</summary>
    public static HttpClient Http { get; } = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(100),
    };

    public static void Init()
    {
        Directory.CreateDirectory(Paths.Roaming);
        Directory.CreateDirectory(Paths.Local);
        Log = new FileAppLog(Paths.Logs);
        Settings = new SettingsStore(Paths.SettingsFile);
        Credentials = new DpapiCredentialStore(Paths.CredentialsFile);
    }
}
