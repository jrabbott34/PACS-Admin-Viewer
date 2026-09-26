using System.Globalization;

namespace PacsAdminViewer.Core.Archive;

/// <summary>Display helpers for raw DICOM attribute strings.</summary>
public static class DicomFormat
{
    /// <summary>"DOE^JOHN^^^" → "DOE, JOHN" (same rule the web viewer's series list uses).</summary>
    public static string PersonName(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        var alphabetic = raw.Split('=')[0];
        var parts = alphabetic.Split('^');
        var family = parts[0].Trim();
        var given = string.Join(' ', parts.Skip(1).Select(p => p.Trim()).Where(p => p.Length > 0));
        return given.Length > 0 ? $"{family}, {given}" : family;
    }

    /// <summary>DICOM DA ("20240115") → DateOnly, or null when missing/malformed.</summary>
    public static DateOnly? Date(string? raw) =>
        raw is { Length: 8 } && DateOnly.TryParseExact(raw, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d
            : null;

    public static string ToDicomDate(DateOnly d) => d.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
}
