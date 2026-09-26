namespace PacsAdminViewer.Core.Archive;

/// <summary>
/// A searchable image archive. The shell only talks to this interface, so Orthanc's REST API
/// (today) could be swapped for DICOMweb or another PACS without touching the UI or the viewer.
/// </summary>
public interface IImageArchive
{
    Task<ArchiveInfo> TestConnectionAsync(CancellationToken ct = default);

    Task<StudySearchResult> FindStudiesAsync(StudyQuery query, CancellationToken ct = default);

    Task<IReadOnlyList<SeriesSummary>> GetSeriesAsync(string studyId, CancellationToken ct = default);

    Task<IReadOnlyList<string>> GetInstanceIdsAsync(string seriesId, CancellationToken ct = default);

    /// <summary>One instance as a DICOM Part-10 file.</summary>
    Task<byte[]> GetInstanceFileAsync(string instanceId, CancellationToken ct = default);
}

public sealed record ArchiveInfo(string Name, string Version);

public sealed record StudyQuery
{
    public string? PatientName { get; init; }
    public string? PatientId { get; init; }
    public string? AccessionNumber { get; init; }
    public DateOnly? DateFrom { get; init; }
    public DateOnly? DateTo { get; init; }
    public int Limit { get; init; } = 200;
}

public sealed record StudySummary(
    string Id,
    string PatientName,
    string PatientId,
    DateOnly? StudyDate,
    string StudyDescription,
    string AccessionNumber,
    string StudyInstanceUid,
    int SeriesCount);

public sealed record StudySearchResult(IReadOnlyList<StudySummary> Studies, bool Truncated);

public sealed record SeriesSummary(
    string Id,
    string Modality,
    int? SeriesNumber,
    string SeriesDescription,
    int InstanceCount);

/// <summary>A failure talking to the archive, with a message fit to show the user as-is.</summary>
public sealed class ArchiveException : Exception
{
    public ArchiveException(string message, int? statusCode = null, Exception? inner = null)
        : base(message, inner) => StatusCode = statusCode;

    public int? StatusCode { get; }
}
