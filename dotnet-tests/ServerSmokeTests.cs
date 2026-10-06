using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace FleetManagerInspector.Tests;

/// <summary>
/// Boots the real Kestrel pipeline (same routes/static handler as Program.cs) and
/// exercises it over HTTP. Mirrors tests/smoke_test.py so the C# server is verified
/// against the identical contract.
/// </summary>
public class ServerSmokeTests : IAsyncLifetime
{
    private WebApplicationFixture _fixture = null!;

    public async Task InitializeAsync() => _fixture = await WebApplicationFixture.StartAsync();
    public async Task DisposeAsync() => await _fixture.DisposeAsync();

    [Theory]
    [InlineData("/")]
    [InlineData("/static/app.js")]
    [InlineData("/static/style.css")]
    public async Task StaticFilesAreServed(string path)
    {
        var response = await _fixture.Client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.False(string.IsNullOrWhiteSpace(body), $"{path} returned an empty body");
    }

    [Fact]
    public async Task UnknownPathIs404()
    {
        var response = await _fixture.Client.GetAsync("/nope");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task PathTraversalIsRejected()
    {
        var response = await _fixture.Client.GetAsync("/static/../Program.cs");
        Assert.True(
            response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.NotFound,
            $"expected 403/404, got {(int)response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("FleetManager Batch Inspector", body);
    }

    [Theory]
    [InlineData("/api/ping")]
    [InlineData("/api/active")]
    [InlineData("/api/batch-details?accountId=x&token=y")]
    [InlineData("/api/details?accountId=x&token=y")]
    public async Task MissingParamsReturn400Json(string path)
    {
        var response = await _fixture.Client.GetAsync(path);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.TryGetProperty("error", out _), "error body must carry an `error` field");
    }

    [Fact]
    public async Task MalformedProxyBodyReturns400()
    {
        var content = new StringContent("not-json", System.Text.Encoding.UTF8, "application/json");
        var response = await _fixture.Client.PostAsync("/api/proxy", content);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.TryGetProperty("error", out _));
    }

    [Fact]
    public async Task ProxyBodyMissingFieldsReturns400()
    {
        var response = await _fixture.Client.PostAsync(
            "/api/proxy", JsonContent.Create(new { endpoint = "/x" }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task OptionsReturns204WithCorsHeaders()
    {
        var request = new HttpRequestMessage(HttpMethod.Options, "/api/ping");
        var response = await _fixture.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.True(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task BatchDeduplicatesIds()
    {
        // Two identical IDs must collapse to one. The upstream call will fail
        // (no real FleetManager, and a disallowed host falls back to the default),
        // but `total` reflects post-dedupe input.
        var response = await _fixture.Client.GetAsync(
            "/api/batch-details?accountId=x&token=y&ids=aaa,aaa,bbb");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, json.GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task BatchWithOnlyBlanksReturns400()
    {
        var response = await _fixture.Client.GetAsync(
            "/api/batch-details?accountId=x&token=y&ids=,,,");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
