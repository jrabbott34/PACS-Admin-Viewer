using System.Text.Json;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Bridge;
using PacsAdminViewer.Core.Logging;
using PacsAdminViewer.Core.Orthanc;
using PacsAdminViewer.Core.Settings;

namespace PacsAdminViewer.Core.Tests;

public class BridgeProtocolTests
{
    [Fact]
    public void Instance_urls_round_trip_through_the_request_parser()
    {
        var url = BridgeProtocol.InstanceUrl("0a1b2c3d-11111111-22222222-33333333-44444444");
        Assert.Equal("https://data.pacs-viewer.example/instances/0a1b2c3d-11111111-22222222-33333333-44444444", url);
        Assert.True(BridgeProtocol.TryParseInstanceRequest("GET", url, out var id));
        Assert.Equal("0a1b2c3d-11111111-22222222-33333333-44444444", id);
    }

    [Theory]
    [InlineData("POST", "https://data.pacs-viewer.example/instances/abc")]
    [InlineData("DELETE", "https://data.pacs-viewer.example/instances/abc")]
    [InlineData("GET", "https://data.pacs-viewer.example/system")]
    [InlineData("GET", "https://data.pacs-viewer.example/instances/abc/file")]
    [InlineData("GET", "https://data.pacs-viewer.example/instances/../system")]
    [InlineData("GET", "https://data.pacs-viewer.example/instances/a%2Fb")]
    [InlineData("GET", "https://data.pacs-viewer.example/instances/abc?x=1")]
    [InlineData("GET", "https://data.pacs-viewer.example:8443/instances/abc")]
    [InlineData("GET", "http://data.pacs-viewer.example/instances/abc")]
    [InlineData("GET", "https://evil.example/instances/abc")]
    [InlineData("GET", "not a url")]
    public void Anything_but_GET_one_instance_is_refused(string method, string uri) =>
        Assert.False(BridgeProtocol.TryParseInstanceRequest(method, uri, out _));

    [Theory]
    [InlineData("https://app.pacs-viewer.example", null, true)]
    [InlineData("https://evil.example", null, false)]
    [InlineData("http://localhost:5173", null, false)]
    [InlineData("http://localhost:5173", "http://localhost:5173/", true)]
    [InlineData(null, null, false)]
    public void Allowed_origins(string? origin, string? dev, bool allowed) =>
        Assert.Equal(allowed, BridgeProtocol.IsAllowedViewerOrigin(origin, dev));

    [Fact]
    public void Load_message_matches_the_web_contract()
    {
        var json = BridgeProtocol.LoadStudyMessage("r1", "Opening study…", ["https://data.pacs-viewer.example/instances/a"]);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal(1, root.GetProperty("v").GetInt32());
        Assert.Equal("load-study", root.GetProperty("type").GetString());
        Assert.Equal("r1", root.GetProperty("requestId").GetString());
        Assert.Equal("Opening study…", root.GetProperty("label").GetString());
        Assert.Equal("https://data.pacs-viewer.example/instances/a", root.GetProperty("instances")[0].GetProperty("url").GetString());

        var noLabel = BridgeProtocol.LoadStudyMessage("r2", null, []);
        Assert.False(JsonDocument.Parse(noLabel).RootElement.TryGetProperty("label", out _));
    }

    [Fact]
    public void Parses_viewer_messages_and_rejects_junk()
    {
        // Exact shapes the web side (src/host-bridge.ts) posts, as captured by tests/e2e/e2e_bridge.py.
        var ready = BridgeProtocol.ParseViewerMessage("""{"v":1,"type":"viewer-ready","bridgeVersion":1,"app":"pacs-admin-viewer","appVersion":"0.1.0"}""");
        Assert.Equal("viewer-ready", ready!.Type);
        Assert.Equal("0.1.0", ready.AppVersion);

        var result = BridgeProtocol.ParseViewerMessage("""{"v":1,"type":"load-result","requestId":"r1","ok":true,"images":3,"duplicates":0,"series":1,"skipped":0}""");
        Assert.True(result!.Ok);
        Assert.Equal(3, result.Images);

        var failed = BridgeProtocol.ParseViewerMessage("""{"v":1,"type":"load-result","requestId":"r4","ok":false,"error":"Archive returned 404 for image 1 of 1"}""");
        Assert.False(failed!.Ok);
        Assert.Contains("404", failed.Error);

        Assert.Null(BridgeProtocol.ParseViewerMessage("""{"v":2,"type":"viewer-ready"}"""));
        Assert.Null(BridgeProtocol.ParseViewerMessage("""{"type":"viewer-ready"}"""));
        Assert.Null(BridgeProtocol.ParseViewerMessage("not json"));
        Assert.Null(BridgeProtocol.ParseViewerMessage(null));
    }

    [Fact]
    public async Task Study_load_request_collects_every_series_instance()
    {
        var http = new FakeHttp()
            .Json("GET", "/studies/st1/series", """[{"ID":"s1","MainDicomTags":{"SeriesNumber":"1"}},{"ID":"s2","MainDicomTags":{"SeriesNumber":"2"}}]""")
            .Json("GET", "/series/s1", """{"Instances":["i1","i2"]}""")
            .Json("GET", "/series/s2", """{"Instances":["i3"]}""");
        var archive = new OrthancArchive(new HttpClient(http), new OrthancConnection(new Uri("http://h:8042/"), null, null));

        var req = await LoadRequests.ForStudyAsync(archive, "st1", "Opening…");

        Assert.Equal(3, req.InstanceCount);
        using var doc = JsonDocument.Parse(req.MessageJson);
        Assert.Equal(req.RequestId, doc.RootElement.GetProperty("requestId").GetString());
        var urls = doc.RootElement.GetProperty("instances").EnumerateArray().Select(i => i.GetProperty("url").GetString());
        Assert.Equal(new[] { "i1", "i2", "i3" }.Select(BridgeProtocol.InstanceUrl), urls);
    }
}

public class SettingsAndLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "pav-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void Settings_round_trip_and_never_contain_a_password_field()
    {
        var store = new SettingsStore(Path.Combine(_dir, "settings.json"));
        Assert.Equal(new AppSettings(), store.Load()); // missing file → defaults

        store.Save(new AppSettings { ServerUrl = "http://h:8042/", Username = "admin", RememberPassword = true });

        Assert.Equal("admin", store.Load().Username);
        Assert.DoesNotContain("assword\":", File.ReadAllText(store.Path).Replace("RememberPassword", ""));
    }

    [Fact]
    public void Corrupt_settings_fall_back_to_defaults()
    {
        Directory.CreateDirectory(_dir);
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, "{ not json");
        Assert.Equal(new AppSettings(), new SettingsStore(path).Load());
    }

    [Fact]
    public void Log_writes_daily_files_and_prunes_old_ones()
    {
        Directory.CreateDirectory(_dir);
        var stale = Path.Combine(_dir, "app-20200101.log");
        File.WriteAllText(stale, "old");
        var now = new DateTime(2026, 9, 26, 12, 0, 0);

        var log = new FileAppLog(_dir, () => now);
        log.Info("Connected to http://h:8042");
        log.Error("Load failed", new InvalidOperationException("boom"));

        Assert.False(File.Exists(stale));
        var text = File.ReadAllText(Path.Combine(_dir, "app-20260926.log"));
        Assert.Contains("INFO  Connected to http://h:8042", text);
        Assert.Contains("ERROR Load failed | InvalidOperationException: boom", text);
    }
}
