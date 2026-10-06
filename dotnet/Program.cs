using FleetManagerInspector;

// FleetManager Batch Inspector — .NET 10 equivalent of server.py.
//
// Serves the shared ../static front end and proxies FleetManager API calls so the
// browser never has to deal with CORS or Cloudflare's User-Agent filtering.

var builder = WebApplication.CreateBuilder(args);

builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.WebHost.UseUrls($"http://0.0.0.0:{Config.Port}");

builder.Services.AddHttpClient<FleetManagerClient>(http =>
{
    http.Timeout = Config.UpstreamTimeout;
});

var app = builder.Build();

// Both this server and server.py serve the same static/ directory.
var staticDir = StaticFiles.ResolveDirectory();

// ── API proxy routes ────────────────────────────────────────────────────────
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

// CORS: the page is same-origin, but keep parity with the Python server.
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
    ctx.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    ctx.Response.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Fm-Api-Url";
    if (HttpMethods.IsOptions(ctx.Request.Method))
    {
        ctx.Response.StatusCode = StatusCodes.Status204NoContent;
        return;
    }
    await next();
});

// ── Static files ────────────────────────────────────────────────────────────
app.MapGet("/", (HttpContext ctx) => StaticFiles.Serve(ctx, staticDir, "index.html"));

app.MapGet("/static/{**path}", (HttpContext ctx, string path)
    => StaticFiles.Serve(ctx, staticDir, path));

Console.WriteLine();
Console.WriteLine("  FleetManager Batch Inspector (.NET)");
Console.WriteLine("  ──────────────────────────────────");
Console.WriteLine($"  Open in Chrome: http://localhost:{Config.Port}");
Console.WriteLine($"  Serving static files from: {staticDir}");
Console.WriteLine("  Press Ctrl+C to stop");
Console.WriteLine();

app.Run();
