namespace PacsAdminViewer.Core.Orthanc;

/// <summary>Where Orthanc is and how to authenticate. The password lives only in memory here.</summary>
public sealed record OrthancConnection(Uri BaseUri, string? Username, string? Password)
{
    public bool HasCredentials => !string.IsNullOrEmpty(Username);

    /// <summary>For logs and the status bar: scheme://host:port, never credentials.</summary>
    public string DisplayName => BaseUri.GetLeftPart(UriPartial.Authority);

    /// <summary>
    /// Accepts what people actually paste — including the Orthanc Explorer page they have open
    /// (".../app/explorer.html", Explorer 2's ".../ui/app/...") — and returns the REST base URL.
    /// </summary>
    public static bool TryNormalizeBaseUri(string? input, out Uri? baseUri, out string? error)
    {
        baseUri = null;
        error = null;
        var text = input?.Trim() ?? "";
        if (text.Length == 0)
        {
            error = "Enter the Orthanc server address, for example http://192.168.1.20:8042";
            return false;
        }
        if (!text.Contains("://", StringComparison.Ordinal)) text = "http://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            error = "The server address must be an http:// or https:// URL.";
            return false;
        }
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            error = "Put the username and password in their own fields, not in the address.";
            return false;
        }

        var path = uri.AbsolutePath;
        var cut = new[] { "/app/", "/ui/" }
            .Select(marker => path.IndexOf(marker, StringComparison.OrdinalIgnoreCase))
            .Where(i => i >= 0)
            .DefaultIfEmpty(path.Length)
            .Min();
        path = path[..cut].TrimEnd('/');
        baseUri = new Uri($"{uri.Scheme}://{uri.Authority}{path}/");
        return true;
    }
}
