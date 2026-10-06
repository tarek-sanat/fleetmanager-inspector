using System.Text.Json;

namespace FleetManagerInspector;

/// <summary>
/// The four proxy endpoints plus the static-file handler. Port of the
/// <c>_handle_*</c> methods in server.py.
/// </summary>
public static class Endpoints
{
    /// <summary>Pull required query params, or report which are missing.</summary>
    private static async Task<(bool Ok, Dictionary<string, string> Values)> TryRequireAsync(
        HttpContext ctx, string[] names)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var missing = new List<string>();

        foreach (var name in names)
        {
            var value = ctx.Request.Query[name].ToString();
            if (string.IsNullOrEmpty(value))
            {
                missing.Add(name);
            }
            else
            {
                values[name] = value;
            }
        }

        if (missing.Count > 0)
        {
            await ctx.JsonError(400, $"{string.Join(", ", names)} are required");
            return (false, values);
        }
        return (true, values);
    }

    /// <summary>The API URL the client asked for, validated. Header: X-Fm-Api-Url.</summary>
    private static string ApiUrlFor(HttpContext ctx)
        => ApiUrl.Resolve(ctx.Request.Headers["X-Fm-Api-Url"].ToString());

    // ── GET /api/active ──────────────────────────────────────────────────────
    public static async Task Active(HttpContext ctx, FleetManagerClient client, CancellationToken ct)
    {
        var (ok, p) = await TryRequireAsync(ctx, ["accountId", "token"]);
        if (!ok) return;

        var result = await client.GetAsync(
            ApiUrlFor(ctx),
            "/ui/external/failed-messages/active",
            new Dictionary<string, string> { ["accountId"] = p["accountId"] },
            p["token"],
            ct);

        await ctx.WriteJsonAsync(result.Status, result.Payload);
    }

    // ── GET /api/details ─────────────────────────────────────────────────────
    public static async Task Details(HttpContext ctx, FleetManagerClient client, CancellationToken ct)
    {
        var (ok, p) = await TryRequireAsync(ctx, ["accountId", "id", "token"]);
        if (!ok) return;

        var result = await client.GetAsync(
            ApiUrlFor(ctx),
            "/ui/external/failed-messages/details",
            new Dictionary<string, string> { ["accountId"] = p["accountId"], ["id"] = p["id"] },
            p["token"],
            ct);

        await ctx.WriteJsonAsync(result.Status, result.Payload);
    }

    // ── GET /api/ping ────────────────────────────────────────────────────────
    public static async Task Ping(HttpContext ctx, FleetManagerClient client, CancellationToken ct)
    {
        var (ok, p) = await TryRequireAsync(ctx, ["accountId", "token"]);
        if (!ok) return;

        var result = await client.GetAsync(
            ApiUrlFor(ctx),
            "/ui/external/failed-messages/counts",
            new Dictionary<string, string> { ["accountId"] = p["accountId"] },
            p["token"],
            ct);

        await ctx.WriteJsonAsync(result.Status, result.Payload);
    }

    // ── GET /api/batch-details ───────────────────────────────────────────────
    public static async Task BatchDetails(HttpContext ctx, FleetManagerClient client, CancellationToken ct)
    {
        var (ok, p) = await TryRequireAsync(ctx, ["accountId", "ids", "token"]);
        if (!ok) return;

        // De-duplicate while preserving order; ignore blanks.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ids = new List<string>();
        foreach (var rawId in p["ids"].Split(','))
        {
            var id = rawId.Trim();
            if (id.Length > 0 && seen.Add(id))
            {
                ids.Add(id);
            }
        }

        if (ids.Count == 0)
        {
            await ctx.JsonError(400, "No valid IDs provided");
            return;
        }

        var batch = await client.GetBatchDetailsAsync(
            ApiUrlFor(ctx), p["accountId"], p["token"], ids, ct);

        ctx.Response.StatusCode = 200;
        ctx.Response.ContentType = "application/json";
        await ctx.Response.Body.WriteAsync(Json.BatchPayload(batch), ct);
    }

    // ── POST /api/proxy ──────────────────────────────────────────────────────
    public static async Task ProxyPost(HttpContext ctx, FleetManagerClient client, CancellationToken ct)
    {
        JsonElement payload;
        try
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct);
            payload = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            await ctx.JsonError(400, "Malformed JSON body");
            return;
        }

        var endpoint = payload.TryGetProperty("endpoint", out var e) ? e.GetString() ?? "" : "";
        var token = payload.TryGetProperty("token", out var t) ? t.GetString() ?? "" : "";
        var data = payload.TryGetProperty("data", out var d) ? d : Json.Object();
        var apiUrl = ApiUrl.Resolve(payload.TryGetProperty("apiUrl", out var a) ? a.GetString() : null);

        if (endpoint.Length == 0 || token.Length == 0)
        {
            await ctx.JsonError(400, "endpoint and token are required");
            return;
        }
        if (!endpoint.StartsWith('/'))
        {
            await ctx.JsonError(400, "endpoint must be an absolute API path");
            return;
        }

        var result = await client.PostAsync(apiUrl, endpoint, token, data, ct);
        await ctx.WriteJsonAsync(result.Status, result.Payload);
    }
}
