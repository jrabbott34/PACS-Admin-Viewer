namespace PacsAdminViewer.Core.Security;

/// <summary>
/// Somewhere to keep an archive password between sessions, only when the user asks to.
/// Windows implementation: DPAPI (per Windows user) in PacsAdminViewer.Desktop.
/// </summary>
public interface ICredentialStore
{
    string? Load(string key);
    void Save(string key, string secret);
    void Delete(string key);
}

public static class CredentialKeys
{
    /// <summary>One saved password per server + user, so switching servers never reuses the wrong one.</summary>
    public static string ForArchive(Uri baseUri, string username) =>
        $"archive|{baseUri.GetLeftPart(UriPartial.Path).TrimEnd('/').ToLowerInvariant()}|{username}";
}

public sealed class InMemoryCredentialStore : ICredentialStore
{
    private readonly Dictionary<string, string> _secrets = [];

    public string? Load(string key) => _secrets.GetValueOrDefault(key);
    public void Save(string key, string secret) => _secrets[key] = secret;
    public void Delete(string key) => _secrets.Remove(key);
}
