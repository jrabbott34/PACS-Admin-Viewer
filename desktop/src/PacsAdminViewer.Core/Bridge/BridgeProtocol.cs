using System.Text.Json;
using System.Text.Json.Serialization;
using PacsAdminViewer.Core.Archive;

namespace PacsAdminViewer.Core.Bridge;

/// <summary>
/// The host side of the shell ↔ viewer contract (desktop/BRIDGE.md; web side: src/host-bridge.ts).
/// Kept deliberately small: the host serves the viewer's static files from one origin, answers
/// "give me instance X" on another, and exchanges a handful of versioned JSON messages.
/// </summary>
public static class BridgeProtocol
{
    public const int Version = 1;

    /// <summary>Virtual host the viewer's static build is served from.</summary>
    public const string AppHost = "app.pacs-viewer.example";

    /// <summary>Fake origin the host intercepts to hand the viewer DICOM files.</summary>
    public const string DataHost = "data.pacs-viewer.example";

    public const string AppOrigin = "https://" + AppHost;
    public const string DataOrigin = "https://" + DataHost;

    public static string InstanceUrl(string archiveInstanceId) =>
        $"{DataOrigin}/instances/{ArchiveIds.Require(archiveInstanceId)}";

    /// <summary>
    /// The only request the data origin answers: GET /instances/{id}. Anything else — other
    /// paths, other methods, query strings, suspicious IDs — is refused, so a page can't use
    /// the host's archive credentials for anything beyond reading instances.
    /// </summary>
    public static bool TryParseInstanceRequest(string method, string uri, out string instanceId)
    {
        instanceId = "";
        if (!string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase)) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttps || !string.Equals(u.Host, DataHost, StringComparison.OrdinalIgnoreCase) || !u.IsDefaultPort) return false;
        if (u.Query.Length > 0 || u.Fragment.Length > 0) return false;
        var segments = u.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 2 || segments[0] != "instances" || !ArchiveIds.IsSafe(segments[1])) return false;
        instanceId = segments[1];
        return true;
    }

    /// <summary>Origins allowed to read from the data origin (the app, plus a dev server if configured).</summary>
    public static bool IsAllowedViewerOrigin(string? origin, string? devServerOrigin) =>
        !string.IsNullOrEmpty(origin) &&
        (string.Equals(origin, AppOrigin, StringComparison.OrdinalIgnoreCase) ||
         (!string.IsNullOrEmpty(devServerOrigin) && string.Equals(origin, devServerOrigin.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)));

    // ---- messages ----

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string LoadStudyMessage(string requestId, string? label, IEnumerable<string> instanceUrls) =>
        JsonSerializer.Serialize(new
        {
            v = Version,
            type = "load-study",
            requestId,
            label,
            instances = instanceUrls.Select(url => new { url }).ToArray(),
        }, Json);

    /// <summary>Parses a message from the viewer; returns null for anything malformed or unversioned.</summary>
    public static ViewerMessage? ParseViewerMessage(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var msg = JsonSerializer.Deserialize<ViewerMessage>(json, Json);
            return msg is { V: Version, Type.Length: > 0 } ? msg : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>Union of every viewer → host message; which fields are set depends on <see cref="Type"/>.</summary>
public sealed record ViewerMessage
{
    public int V { get; init; }
    public string Type { get; init; } = "";
    public string? RequestId { get; init; }

    // viewer-ready
    public int? BridgeVersion { get; init; }
    public string? AppVersion { get; init; }

    // load-progress
    public int? Done { get; init; }
    public int? Total { get; init; }

    // load-result
    public bool? Ok { get; init; }
    public int? Images { get; init; }
    public int? Duplicates { get; init; }
    public int? Series { get; init; }
    public int? Skipped { get; init; }
    public string? Error { get; init; }
}
