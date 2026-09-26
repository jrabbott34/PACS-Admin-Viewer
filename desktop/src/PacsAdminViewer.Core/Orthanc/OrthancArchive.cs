using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PacsAdminViewer.Core.Archive;

namespace PacsAdminViewer.Core.Orthanc;

/// <summary>
/// Orthanc via its own REST API (/system, /tools/find, /studies, /series, /instances). The core
/// REST API is always present, unlike the DICOMweb plugin, so this works against any Orthanc.
/// </summary>
public sealed class OrthancArchive : IImageArchive
{
    private readonly HttpClient _http;
    private readonly AuthenticationHeaderValue? _auth;

    public OrthancArchive(HttpClient http, OrthancConnection connection)
    {
        _http = http;
        Connection = connection;
        if (connection.HasCredentials)
        {
            var raw = Encoding.UTF8.GetBytes($"{connection.Username}:{connection.Password}");
            _auth = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(raw));
        }
    }

    public OrthancConnection Connection { get; }

    public async Task<ArchiveInfo> TestConnectionAsync(CancellationToken ct = default)
    {
        using var doc = await GetJsonAsync("system", ct);
        var root = doc.RootElement;
        var name = Str(root, "Name");
        return new ArchiveInfo(name.Length > 0 ? name : "Orthanc", Str(root, "Version"));
    }

    public async Task<StudySearchResult> FindStudiesAsync(StudyQuery query, CancellationToken ct = default)
    {
        var match = new Dictionary<string, string>();
        AddWildcard(match, "PatientName", query.PatientName);
        AddWildcard(match, "PatientID", query.PatientId);
        AddWildcard(match, "AccessionNumber", query.AccessionNumber);
        if (DateRange(query.DateFrom, query.DateTo) is { } range) match["StudyDate"] = range;

        var limit = Math.Clamp(query.Limit, 1, 1000);
        var body = new
        {
            Level = "Study",
            Expand = true,
            CaseSensitive = false,
            Limit = limit + 1, // one extra tells us whether the result was cut off
            Query = match,
        };
        using var content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var doc = await SendForJsonAsync(HttpMethod.Post, "tools/find", content, ct);

        var studies = new List<StudySummary>();
        if (doc.RootElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                var main = Obj(e, "MainDicomTags");
                var patient = Obj(e, "PatientMainDicomTags");
                studies.Add(new StudySummary(
                    Id: Str(e, "ID"),
                    PatientName: DicomFormat.PersonName(Str(patient, "PatientName")),
                    PatientId: Str(patient, "PatientID"),
                    StudyDate: DicomFormat.Date(Str(main, "StudyDate")),
                    StudyDescription: Str(main, "StudyDescription"),
                    AccessionNumber: Str(main, "AccessionNumber"),
                    StudyInstanceUid: Str(main, "StudyInstanceUID"),
                    SeriesCount: ArrayLength(e, "Series")));
            }
        }
        var ordered = studies
            .Where(s => ArchiveIds.IsSafe(s.Id))
            .OrderByDescending(s => s.StudyDate)
            .ThenBy(s => s.PatientName, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var truncated = ordered.Count > limit;
        return new StudySearchResult(truncated ? ordered.Take(limit).ToList() : ordered, truncated);
    }

    public async Task<IReadOnlyList<SeriesSummary>> GetSeriesAsync(string studyId, CancellationToken ct = default)
    {
        using var doc = await GetJsonAsync($"studies/{ArchiveIds.Require(studyId)}/series", ct);
        var list = new List<SeriesSummary>();
        if (doc.RootElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                var main = Obj(e, "MainDicomTags");
                list.Add(new SeriesSummary(
                    Id: Str(e, "ID"),
                    Modality: Str(main, "Modality"),
                    SeriesNumber: int.TryParse(Str(main, "SeriesNumber"), out var n) ? n : null,
                    SeriesDescription: Str(main, "SeriesDescription"),
                    InstanceCount: ArrayLength(e, "Instances")));
            }
        }
        return list
            .Where(s => ArchiveIds.IsSafe(s.Id))
            .OrderBy(s => s.SeriesNumber ?? int.MaxValue)
            .ThenBy(s => s.SeriesDescription, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public async Task<IReadOnlyList<string>> GetInstanceIdsAsync(string seriesId, CancellationToken ct = default)
    {
        using var doc = await GetJsonAsync($"series/{ArchiveIds.Require(seriesId)}", ct);
        if (!doc.RootElement.TryGetProperty("Instances", out var arr) || arr.ValueKind != JsonValueKind.Array) return [];
        return arr.EnumerateArray()
            .Where(i => i.ValueKind == JsonValueKind.String)
            .Select(i => i.GetString()!)
            .Where(ArchiveIds.IsSafe)
            .ToList();
    }

    public async Task<byte[]> GetInstanceFileAsync(string instanceId, CancellationToken ct = default)
    {
        using var resp = await SendAsync(HttpMethod.Get, $"instances/{ArchiveIds.Require(instanceId)}/file", null, ct);
        return await resp.Content.ReadAsByteArrayAsync(ct);
    }

    // ---- HTTP plumbing ----

    private Task<JsonDocument> GetJsonAsync(string path, CancellationToken ct) => SendForJsonAsync(HttpMethod.Get, path, null, ct);

    private async Task<JsonDocument> SendForJsonAsync(HttpMethod method, string path, HttpContent? content, CancellationToken ct)
    {
        using var resp = await SendAsync(method, path, content, ct);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        try
        {
            return await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        }
        catch (JsonException ex)
        {
            throw new ArchiveException(
                $"{Connection.DisplayName} answered, but not with Orthanc's JSON. Check the address points at the Orthanc server.",
                (int)resp.StatusCode, ex);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, HttpContent? content, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, new Uri(Connection.BaseUri, path)) { Content = content };
        request.Headers.Authorization = _auth;
        HttpResponseMessage resp;
        try
        {
            resp = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new ArchiveException($"Couldn't reach {Connection.DisplayName}: {ex.Message}", null, ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new ArchiveException($"{Connection.DisplayName} didn't respond in time.", null, ex);
        }

        if (resp.IsSuccessStatusCode) return resp;
        var code = (int)resp.StatusCode;
        resp.Dispose();
        throw new ArchiveException(code switch
        {
            401 => "Orthanc rejected the username or password (401).",
            403 => "This Orthanc account isn't allowed to do that (403).",
            404 => $"Not found on {Connection.DisplayName} (404). Check the address points at Orthanc.",
            _ => $"Orthanc returned an error ({code}).",
        }, code);
    }

    // ---- query + JSON helpers ----

    private static void AddWildcard(Dictionary<string, string> match, string tag, string? value)
    {
        var v = value?.Trim();
        if (string.IsNullOrEmpty(v)) return;
        match[tag] = v.Contains('*') || v.Contains('?') ? v : $"*{v}*";
    }

    internal static string? DateRange(DateOnly? from, DateOnly? to) => (from, to) switch
    {
        (null, null) => null,
        ({ } f, null) => $"{DicomFormat.ToDicomDate(f)}-",
        (null, { } t) => $"-{DicomFormat.ToDicomDate(t)}",
        ({ } f, { } t) => $"{DicomFormat.ToDicomDate(f)}-{DicomFormat.ToDicomDate(t)}",
    };

    private static JsonElement Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;

    private static string Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()!.Trim()
            : "";

    private static int ArrayLength(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.GetArrayLength()
            : 0;
}
