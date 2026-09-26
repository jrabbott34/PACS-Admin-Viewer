using System.Text.Json;

namespace PacsAdminViewer.Core.Settings;

/// <summary>Non-secret settings. The password is never stored here — see ICredentialStore.</summary>
public sealed record AppSettings
{
    public string ServerUrl { get; init; } = "";
    public string Username { get; init; } = "";
    public bool RememberPassword { get; init; }
    public bool ConnectOnStartup { get; init; }
}

/// <summary>JSON settings file (e.g. %APPDATA%\PacsAdminViewer\settings.json).</summary>
public sealed class SettingsStore(string path)
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public string Path { get; } = path;

    /// <summary>Missing or unreadable settings fall back to defaults rather than blocking startup.</summary>
    public AppSettings Load()
    {
        try
        {
            if (!File.Exists(Path)) return new AppSettings();
            return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(Path), Json) ?? new AppSettings();
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return new AppSettings();
        }
    }

    /// <summary>Write to a temp file then swap, so a crash mid-write can't leave a truncated file.</summary>
    public void Save(AppSettings settings)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var tmp = Path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(settings, Json));
        File.Move(tmp, Path, overwrite: true);
    }
}
