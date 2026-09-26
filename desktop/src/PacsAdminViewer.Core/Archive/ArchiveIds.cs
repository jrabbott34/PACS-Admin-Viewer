using System.Text.RegularExpressions;

namespace PacsAdminViewer.Core.Archive;

public static partial class ArchiveIds
{
    /// <summary>
    /// Archive resource IDs end up in URL paths (both upstream to the archive and in the
    /// viewer's data URLs), so only a conservative charset is accepted — no slashes, dots-only
    /// segments or escapes that could turn "one instance" into "some other endpoint".
    /// Orthanc IDs ("0a1b2c3d-...") fit comfortably.
    /// </summary>
    public static bool IsSafe(string? id) => id is not null && SafeId().IsMatch(id) && id.Trim('.').Length > 0;

    [GeneratedRegex("^[0-9A-Za-z._-]{1,128}$")]
    private static partial Regex SafeId();

    public static string Require(string? id) =>
        IsSafe(id) ? id! : throw new ArgumentException($"Not a valid archive resource ID: '{id}'.", nameof(id));
}
