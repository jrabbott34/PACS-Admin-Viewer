using PacsAdminViewer.Core.Archive;

namespace PacsAdminViewer.Core.Bridge;

public sealed record LoadRequest(string RequestId, int InstanceCount, string MessageJson);

/// <summary>Turns "open this study/series" into the one message the viewer needs.</summary>
public static class LoadRequests
{
    public static async Task<LoadRequest> ForStudyAsync(IImageArchive archive, string studyId, string? label, CancellationToken ct = default)
    {
        var series = await archive.GetSeriesAsync(studyId, ct);
        return await ForSeriesAsync(archive, series.Select(s => s.Id), label, ct);
    }

    public static async Task<LoadRequest> ForSeriesAsync(IImageArchive archive, IEnumerable<string> seriesIds, string? label, CancellationToken ct = default)
    {
        var instanceIds = new List<string>();
        foreach (var seriesId in seriesIds)
        {
            instanceIds.AddRange(await archive.GetInstanceIdsAsync(seriesId, ct));
        }
        var requestId = Guid.NewGuid().ToString("N");
        var json = BridgeProtocol.LoadStudyMessage(requestId, label, instanceIds.Distinct().Select(BridgeProtocol.InstanceUrl));
        return new LoadRequest(requestId, instanceIds.Distinct().Count(), json);
    }
}
