using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace FleetManagerInspector.Tests;

/// <summary>
/// Hosts the real application pipeline in-process on an ephemeral port, so tests
/// exercise the same routing and static-file code as the shipped server.
/// </summary>
public sealed class WebApplicationFixture : IAsyncDisposable
{
    private WebApplication _app = null!;

    public HttpClient Client { get; private set; } = null!;

    public static async Task<WebApplicationFixture> StartAsync()
    {
        var fixture = new WebApplicationFixture();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Services.AddHttpClient<FleetManagerClient>(http =>
        {
            http.Timeout = TimeSpan.FromSeconds(5);
        });

        var app = builder.Build();

        // Point at the repo's shared static dir, resolved from the test output folder.
        var staticDir = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "static"));

        app.MapGet("/api/active", (HttpContext ctx, FleetManagerClient c, CancellationToken ct)
            => Endpoints.Active(ctx, c, ct));
        app.MapGet("/api/details", (HttpContext ctx, FleetManagerClient c, CancellationToken ct)
            => Endpoints.Details(ctx, c, ct));
        app.MapGet("/api/ping", (HttpContext ctx, FleetManagerClient c, CancellationToken ct)
            => Endpoints.Ping(ctx, c, ct));
        app.MapGet("/api/batch-details", (HttpContext ctx, FleetManagerClient c, CancellationToken ct)
            => Endpoints.BatchDetails(ctx, c, ct));
        app.MapPost("/api/proxy", (HttpContext ctx, FleetManagerClient c, CancellationToken ct)
            => Endpoints.ProxyPost(ctx, c, ct));

        app.Use(async (ctx, next) =>
        {
            ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
            if (HttpMethods.IsOptions(ctx.Request.Method))
            {
                ctx.Response.StatusCode = 204;
                return;
            }
            await next();
        });

        app.MapGet("/", (HttpContext ctx) => StaticFiles.Serve(ctx, staticDir, "index.html"));
        app.MapGet("/static/{**path}", (HttpContext ctx, string path)
            => StaticFiles.Serve(ctx, staticDir, path));

        await app.StartAsync();
        fixture._app = app;
        fixture.Client = app.GetTestClient();
        return fixture;
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _app.DisposeAsync();
    }
}
