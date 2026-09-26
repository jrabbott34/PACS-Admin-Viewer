using System.Net;
using System.Text;
using System.Text.Json;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Orthanc;

namespace PacsAdminViewer.Core.Tests;

public class OrthancArchiveTests
{
    private const string StudyA = "27f7126f-4f66f19a-a4a2a64c-4b0ef4bd-8e4fb22c";
    private const string StudyB = "6a3c2b11-9f1e2d3c-4b5a6978-8e9f0a1b-2c3d4e5f";

    private static (OrthancArchive archive, FakeHttp http) Make(string baseUrl = "http://192.168.10.148:8042", string? user = "admin", string? pass = "s3cret")
    {
        var http = new FakeHttp();
        Assert.True(OrthancConnection.TryNormalizeBaseUri(baseUrl, out var uri, out _));
        return (new OrthancArchive(new HttpClient(http), new OrthancConnection(uri!, user, pass)), http);
    }

    [Fact]
    public async Task TestConnection_sends_basic_auth_and_reads_name_and_version()
    {
        var (archive, http) = Make();
        http.Json("GET", "/system", """{"Name":"MyOrthanc","Version":"1.12.4","ApiVersion":22}""");

        var info = await archive.TestConnectionAsync();

        Assert.Equal(new ArchiveInfo("MyOrthanc", "1.12.4"), info);
        var expected = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("admin:s3cret"));
        Assert.Equal(expected, http.Requests.Single().Auth);
    }

    [Fact]
    public async Task No_username_means_no_auth_header()
    {
        var (archive, http) = Make(user: null, pass: null);
        http.Json("GET", "/system", """{"Version":"1.12.4"}""");

        var info = await archive.TestConnectionAsync();

        Assert.Null(http.Requests.Single().Auth);
        Assert.Equal("Orthanc", info.Name);
    }

    [Fact]
    public async Task Base_path_is_preserved_behind_a_reverse_proxy()
    {
        var (archive, http) = Make("https://pacs.example.org/orthanc/app/explorer.html");
        http.Json("GET", "/orthanc/system", """{"Version":"1.12.4"}""");

        await archive.TestConnectionAsync();

        Assert.Equal("https://pacs.example.org/orthanc/system", http.Requests.Single().Uri.ToString());
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "username or password")]
    [InlineData(HttpStatusCode.Forbidden, "403")]
    [InlineData(HttpStatusCode.NotFound, "404")]
    [InlineData(HttpStatusCode.InternalServerError, "500")]
    public async Task Http_errors_become_readable_ArchiveExceptions(HttpStatusCode status, string mentions)
    {
        var (archive, http) = Make();
        http.Status("GET", "/system", status);

        var ex = await Assert.ThrowsAsync<ArchiveException>(() => archive.TestConnectionAsync());

        Assert.Contains(mentions, ex.Message);
        Assert.Equal((int)status, ex.StatusCode);
    }

    [Fact]
    public async Task Network_failure_names_the_server_but_not_the_credentials()
    {
        var (archive, http) = Make();
        http.Throws("GET", "/system", new HttpRequestException("No route to host"));

        var ex = await Assert.ThrowsAsync<ArchiveException>(() => archive.TestConnectionAsync());

        Assert.Contains("192.168.10.148:8042", ex.Message);
        Assert.DoesNotContain("s3cret", ex.Message);
        Assert.DoesNotContain("admin", ex.Message);
    }

    [Fact]
    public async Task Non_json_answer_is_reported_as_not_orthanc()
    {
        var (archive, http) = Make();
        http.Json("GET", "/system", "<html>router login</html>");

        var ex = await Assert.ThrowsAsync<ArchiveException>(() => archive.TestConnectionAsync());

        Assert.Contains("not with Orthanc's JSON", ex.Message);
    }

    [Fact]
    public async Task FindStudies_builds_a_wildcard_query_and_parses_expanded_studies()
    {
        var (archive, http) = Make();
        http.Json("POST", "/tools/find", """
            [
              {"ID":"STUDY_A","Type":"Study","Series":["s1","s2"],
               "MainDicomTags":{"StudyDate":"20240115","StudyDescription":"CT CHEST","AccessionNumber":"ACC1","StudyInstanceUID":"1.2.3"},
               "PatientMainDicomTags":{"PatientName":"DOE^JANE","PatientID":"PID1"}},
              {"ID":"STUDY_B","Type":"Study","Series":["s3"],
               "MainDicomTags":{"StudyDate":"20240301"},
               "PatientMainDicomTags":{"PatientName":"ROE^RICHARD^Q","PatientID":"PID2"}}
            ]
            """.Replace("STUDY_A", StudyA).Replace("STUDY_B", StudyB));

        var result = await archive.FindStudiesAsync(new StudyQuery
        {
            PatientName = "doe",
            AccessionNumber = "ACC*",
            DateFrom = new DateOnly(2024, 1, 1),
            DateTo = new DateOnly(2024, 12, 31),
            Limit = 50,
        });

        using var body = JsonDocument.Parse(http.Requests.Single().Body!);
        var root = body.RootElement;
        Assert.Equal("Study", root.GetProperty("Level").GetString());
        Assert.True(root.GetProperty("Expand").GetBoolean());
        Assert.False(root.GetProperty("CaseSensitive").GetBoolean());
        Assert.Equal(51, root.GetProperty("Limit").GetInt32());
        var q = root.GetProperty("Query");
        Assert.Equal("*doe*", q.GetProperty("PatientName").GetString());
        Assert.Equal("ACC*", q.GetProperty("AccessionNumber").GetString()); // user's own wildcard kept
        Assert.Equal("20240101-20241231", q.GetProperty("StudyDate").GetString());
        Assert.False(q.TryGetProperty("PatientID", out _)); // blank fields aren't sent

        Assert.False(result.Truncated);
        Assert.Equal([StudyB, StudyA], result.Studies.Select(s => s.Id)); // newest first
        var jane = result.Studies[1];
        Assert.Equal("DOE, JANE", jane.PatientName);
        Assert.Equal("PID1", jane.PatientId);
        Assert.Equal(new DateOnly(2024, 1, 15), jane.StudyDate);
        Assert.Equal("CT CHEST", jane.StudyDescription);
        Assert.Equal(2, jane.SeriesCount);
        Assert.Equal("ROE, RICHARD Q", result.Studies[0].PatientName);
    }

    [Fact]
    public async Task FindStudies_flags_truncation_using_the_extra_result()
    {
        var (archive, http) = Make();
        var many = string.Join(",", Enumerable.Range(0, 3).Select(i => "{\"ID\":\"" + i.ToString("D8") + "-aaaaaaaa-bbbbbbbb-cccccccc-dddddddd\"}"));
        http.Json("POST", "/tools/find", $"[{many}]");

        var result = await archive.FindStudiesAsync(new StudyQuery { Limit = 2 });

        Assert.True(result.Truncated);
        Assert.Equal(2, result.Studies.Count);
    }

    [Fact]
    public async Task Empty_search_sends_an_empty_query_object()
    {
        var (archive, http) = Make();
        http.Json("POST", "/tools/find", "[]");

        var result = await archive.FindStudiesAsync(new StudyQuery());

        using var body = JsonDocument.Parse(http.Requests.Single().Body!);
        Assert.Equal(JsonValueKind.Object, body.RootElement.GetProperty("Query").ValueKind);
        Assert.Empty(body.RootElement.GetProperty("Query").EnumerateObject());
        Assert.Empty(result.Studies);
    }

    [Fact]
    public async Task GetSeries_parses_and_orders_by_series_number()
    {
        var (archive, http) = Make();
        http.Json("GET", $"/studies/{StudyA}/series", """
            [
              {"ID":"s2","MainDicomTags":{"Modality":"CT","SeriesNumber":"3","SeriesDescription":"Coronal"},"Instances":["a","b"]},
              {"ID":"s1","MainDicomTags":{"Modality":"CT","SeriesNumber":"2","SeriesDescription":"Axial"},"Instances":["c","d","e"]},
              {"ID":"s3","MainDicomTags":{"Modality":"SR"},"Instances":["f"]}
            ]
            """);

        var series = await archive.GetSeriesAsync(StudyA);

        Assert.Equal(["s1", "s2", "s3"], series.Select(s => s.Id));
        Assert.Equal(new SeriesSummary("s1", "CT", 2, "Axial", 3), series[0]);
        Assert.Null(series[2].SeriesNumber);
    }

    [Fact]
    public async Task GetInstanceIds_and_file_download()
    {
        var (archive, http) = Make();
        http.Json("GET", "/series/s1", """{"ID":"s1","Instances":["i1","i2"]}""");
        http.Bytes("GET", "/instances/i1/file", [0x44, 0x49, 0x43, 0x4D]);

        Assert.Equal(["i1", "i2"], await archive.GetInstanceIdsAsync("s1"));
        Assert.Equal([0x44, 0x49, 0x43, 0x4D], await archive.GetInstanceFileAsync("i1"));
    }

    [Theory]
    [InlineData("../system")]
    [InlineData("a/b")]
    [InlineData("..")]
    [InlineData("")]
    [InlineData("i1?x=1")]
    public async Task Unsafe_ids_never_reach_the_network(string id)
    {
        var (archive, http) = Make();

        await Assert.ThrowsAsync<ArgumentException>(() => archive.GetInstanceFileAsync(id));
        await Assert.ThrowsAsync<ArgumentException>(() => archive.GetSeriesAsync(id));
        Assert.Empty(http.Requests);
    }
}
