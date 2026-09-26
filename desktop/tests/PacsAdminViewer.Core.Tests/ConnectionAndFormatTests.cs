using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Orthanc;
using PacsAdminViewer.Core.Security;

namespace PacsAdminViewer.Core.Tests;

public class ConnectionAndFormatTests
{
    [Theory]
    [InlineData("http://192.168.10.148:8042/app/explorer.html", "http://192.168.10.148:8042/")]
    [InlineData("http://192.168.10.148:8042", "http://192.168.10.148:8042/")]
    [InlineData("  192.168.10.148:8042/  ", "http://192.168.10.148:8042/")]
    [InlineData("http://host:8042/ui/app/#/", "http://host:8042/")]
    [InlineData("https://pacs.example.org/orthanc/", "https://pacs.example.org/orthanc/")]
    [InlineData("https://pacs.example.org/orthanc/app/explorer.html#study?uuid=x", "https://pacs.example.org/orthanc/")]
    public void Normalizes_what_people_paste(string input, string expected)
    {
        Assert.True(OrthancConnection.TryNormalizeBaseUri(input, out var uri, out var error), error);
        Assert.Equal(expected, uri!.ToString());
    }

    [Theory]
    [InlineData("", "Enter the Orthanc server address")]
    [InlineData("ftp://host/", "http:// or https://")]
    [InlineData("http://admin:pw@host:8042/", "own fields")]
    public void Rejects_bad_addresses_with_a_reason(string input, string mentions)
    {
        Assert.False(OrthancConnection.TryNormalizeBaseUri(input, out _, out var error));
        Assert.Contains(mentions, error);
    }

    [Fact]
    public void Display_name_never_includes_path_or_credentials()
    {
        var c = new OrthancConnection(new Uri("https://pacs.example.org/orthanc/"), "admin", "pw");
        Assert.Equal("https://pacs.example.org", c.DisplayName);
    }

    [Theory]
    [InlineData("DOE^JANE", "DOE, JANE")]
    [InlineData("DOE^JANE^M^DR^", "DOE, JANE M DR")]
    [InlineData("DOE", "DOE")]
    [InlineData("Yamada^Tarou=山田^太郎", "Yamada, Tarou")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void Person_names(string? raw, string expected) => Assert.Equal(expected, DicomFormat.PersonName(raw));

    [Theory]
    [InlineData("20240115", 2024, 1, 15)]
    [InlineData("2024011", null, null, null)]
    [InlineData("20241399", null, null, null)]
    [InlineData(null, null, null, null)]
    public void Dates(string? raw, int? y, int? m, int? d) =>
        Assert.Equal(y is null ? null : new DateOnly(y.Value, m!.Value, d!.Value), DicomFormat.Date(raw));

    [Fact]
    public void Date_ranges()
    {
        var a = new DateOnly(2024, 1, 1);
        var b = new DateOnly(2024, 2, 1);
        Assert.Null(OrthancArchive.DateRange(null, null));
        Assert.Equal("20240101-", OrthancArchive.DateRange(a, null));
        Assert.Equal("-20240201", OrthancArchive.DateRange(null, b));
        Assert.Equal("20240101-20240201", OrthancArchive.DateRange(a, b));
    }

    [Fact]
    public void Credential_keys_are_per_server_and_user()
    {
        var k1 = CredentialKeys.ForArchive(new Uri("http://Host:8042/"), "admin");
        var k2 = CredentialKeys.ForArchive(new Uri("http://host:8042"), "admin");
        var k3 = CredentialKeys.ForArchive(new Uri("http://host:8042/"), "other");
        var k4 = CredentialKeys.ForArchive(new Uri("http://host2:8042/"), "admin");
        Assert.Equal(k1, k2);
        Assert.NotEqual(k1, k3);
        Assert.NotEqual(k1, k4);
    }
}
