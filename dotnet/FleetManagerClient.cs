using System.Text;
using System.Text.Json;

namespace FleetManagerInspector;

/// <summary>Result of one upstream call: a JSON payload plus the HTTP status.</summary>
public sealed record UpstreamResult(JsonElement Payload, int Status);

/// <summary>
/// Talks to the FleetManager External API. Port of the <c>_proxy_get</c> /
/// <c>_handle_batch_details</c> logic in server.py.
/// </summary>
public sealed class FleetManagerClient(HttpClient http)
{
    private readonly HttpClient _http = http;

    /// <summary>
    /// GET an API path. On a non-2xx response the payload is
    /// <c>{"error": ..., "detail": ...}</c> and the real status is preserved so the
    /// UI can tell 401 apart from 404 apart from Cloudflare's 403.
    /// </summary>
    public async Task<UpstreamResult> GetAsync(
        string apiUrl,
        string endpoint,
        IReadOnlyDictionary<string, string>? query,
        string? bearerToken,
        CancellationToken ct = default)
    {
        var url = apiUrl + endpoint;
        if (query is { Count: > 0 })
        {
            url += "?" + string.Join("&", query.Select(kv =>
                $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Headers.TryAddWithoutValidation("User-Agent", Config.UserAgent);
        if (!string.IsNullOrEmpty(bearerToken))
        {
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearerToken}");
        }

        try
        {
            using var response = await _http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            var payload = ParseJsonOrError(body);
            if (!response.IsSuccessStatusCode)
            {
                return new UpstreamResult(ErrorPayload((int)response.StatusCode, body), (int)response.StatusCode);
            }
            return new UpstreamResult(payload, (int)response.StatusCode);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            // HttpClient surfaces its own timeout as TaskCanceledException.
            return new UpstreamResult(Json.Error($"Upstream timed out after {Config.UpstreamTimeout.TotalSeconds:0}s"), 504);
        }
        catch (HttpRequestException ex)
        {
            return new UpstreamResult(Json.Error($"Connection failed: {ex.Message}"), 502);
        }
    }

    /// <summary>
    /// Fetch details for many message IDs concurrently. Mirrors the Python
    /// ThreadPoolExecutor(max_workers=20) + as_completed behaviour: results are keyed
    /// by ID (completion order is irrelevant) and a single failure never kills the batch.
    /// </summary>
    public async Task<BatchResult> GetBatchDetailsAsync(
        string apiUrl,
        string accountId,
        string bearerToken,
        IReadOnlyList<string> ids,
        CancellationToken ct = default)
    {
        var results = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var errors = new List<BatchError>();

        using var gate = new SemaphoreSlim(Config.MaxWorkers);
        var tasks = ids.Select(async id =>
        {
            await gate.WaitAsync(ct);
            try
            {
                var query = new Dictionary<string, string> { ["accountId"] = accountId, ["id"] = id };
                var result = await GetAsync(apiUrl, "/ui/external/failed-messages/details", query, bearerToken, ct);
                return (Id: id, Result: result);
            }
            finally
            {
                gate.Release();
            }
        }).ToList();

        foreach (var task in tasks)
        {
            (string Id, UpstreamResult Result) outcome;
            try
            {
                outcome = await task;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Defensive: surface the failure but keep collecting the rest.
                errors.Add(new BatchError("unknown", 0, ex.Message));
                continue;
            }

            if (outcome.Result.Status == 200)
            {
                results[outcome.Id] = outcome.Result.Payload;
            }
            else
            {
                errors.Add(new BatchError(outcome.Id, outcome.Result.Status, outcome.Result.Payload.GetRawText()));
            }
        }

        return new BatchResult(results, errors, ids.Count);
    }

    /// <summary>POST a JSON body to an API path. Port of <c>_handle_proxy_post</c>.</summary>
    public async Task<UpstreamResult> PostAsync(
        string apiUrl,
        string endpoint,
        string bearerToken,
        JsonElement data,
        CancellationToken ct = default)
    {
        var url = apiUrl + endpoint;
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(data.GetRawText(), Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Headers.TryAddWithoutValidation("User-Agent", Config.UserAgent);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearerToken}");

        try
        {
            using var response = await _http.SendAsync(request, ct);
            var body = await response.Content.ReadAsStringAsync(ct);
            var payload = ParseJsonOrError(body);
            if (!response.IsSuccessStatusCode)
            {
                return new UpstreamResult(ErrorPayload((int)response.StatusCode, body), (int)response.StatusCode);
            }
            return new UpstreamResult(payload, (int)response.StatusCode);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return new UpstreamResult(Json.Error($"Upstream timed out after {Config.UpstreamTimeout.TotalSeconds:0}s"), 504);
        }
        catch (HttpRequestException ex)
        {
            return new UpstreamResult(Json.Error($"Connection failed: {ex.Message}"), 502);
        }
    }

    private static JsonElement ParseJsonOrError(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return Json.Object();
        }
        try
        {
            return JsonDocument.Parse(body).RootElement.Clone();
        }
        catch (JsonException)
        {
            var truncated = body.Length > 2000 ? body[..2000] : body;
            return Json.Error("Upstream returned non-JSON", truncated);
        }
    }

    private static JsonElement ErrorPayload(int statusCode, string body)
    {
        var truncated = body.Length > 2000 ? body[..2000] : body;
        return Json.Error(ApiUrl.DescribeHttpError(statusCode), truncated);
    }
}

/// <summary>Details for one message ID.</summary>
public sealed record BatchError(string Id, int Status, string Error);

/// <summary>Aggregate result of a parallel batch detail fetch.</summary>
public sealed record BatchResult(
    Dictionary<string, JsonElement> Results,
    List<BatchError> Errors,
    int Total)
{
    public int Fetched => Results.Count;
}
