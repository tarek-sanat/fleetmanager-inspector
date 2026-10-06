namespace FleetManagerInspector;

/// <summary>
/// Validates and normalizes the user-supplied FleetManager base URL.
/// Port of <c>_normalize_api_url</c> in server.py.
/// </summary>
public static class ApiUrl
{
    /// <summary>
    /// Returns the cleaned base URL (no trailing slash), or <c>null</c> if the input
    /// is missing, malformed, or points somewhere other than FleetManager.
    /// </summary>
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var url = raw.Trim().TrimEnd('/');
        if (url.Length == 0)
        {
            return null;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed))
        {
            return null;
        }

        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
        {
            return null;
        }

        var host = parsed.Host.ToLowerInvariant();
        if (host.Length == 0)
        {
            return null;
        }

        // Compare the *parsed* host, never the raw string — a substring check would
        // accept https://evil.example/?x=.rebus.fm.
        var allowed = Config.AllowedHosts.Contains(host) || host.EndsWith(".rebus.fm", StringComparison.Ordinal);
        return allowed ? url : null;
    }

    /// <summary>Resolve the effective API URL for a request, falling back to the default.</summary>
    public static string Resolve(string? headerValue) => Normalize(headerValue) ?? Config.DefaultApiUrl;

    /// <summary>
    /// Map an upstream HTTP status to an actionable message.
    /// Port of <c>_describe_http_error</c>.
    /// </summary>
    public static string DescribeHttpError(int statusCode) => statusCode switch
    {
        401 => "Unauthorized — the bearer token is missing, expired, or wrong.",
        403 => "Forbidden — token lacks access, or Cloudflare blocked the request.",
        404 => "Not found — check the account ID and API URL.",
        429 => "Rate limited by FleetManager. Retry in a moment.",
        _ => $"FleetManager returned HTTP {statusCode}",
    };
}
