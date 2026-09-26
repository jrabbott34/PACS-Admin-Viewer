using System.Net;
using System.Text;

namespace PacsAdminViewer.Core.Tests;

/// <summary>A stand-in Orthanc: canned responses keyed by "METHOD path", and a record of every request.</summary>
internal sealed class FakeHttp : HttpMessageHandler
{
    private readonly Dictionary<string, Func<HttpResponseMessage>> _routes = [];
    public List<(HttpMethod Method, Uri Uri, string? Auth, string? Body)> Requests { get; } = [];

    public FakeHttp Json(string method, string path, string json, HttpStatusCode status = HttpStatusCode.OK)
    {
        _routes[$"{method} {path}"] = () => new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        return this;
    }

    public FakeHttp Bytes(string method, string path, byte[] body)
    {
        _routes[$"{method} {path}"] = () => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };
        return this;
    }

    public FakeHttp Status(string method, string path, HttpStatusCode status)
    {
        _routes[$"{method} {path}"] = () => new HttpResponseMessage(status) { Content = new StringContent("") };
        return this;
    }

    public FakeHttp Throws(string method, string path, Exception ex)
    {
        _routes[$"{method} {path}"] = () => throw ex;
        return this;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        Requests.Add((request.Method, request.RequestUri!, request.Headers.Authorization?.ToString(), body));
        var key = $"{request.Method} {request.RequestUri!.AbsolutePath}";
        return _routes.TryGetValue(key, out var make) ? make() : new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("") };
    }
}
