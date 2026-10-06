namespace FleetManagerInspector;

/// <summary>
/// Configuration knobs mirroring the Python implementation's module-level constants,
/// so the two servers behave identically.
/// </summary>
public static class Config
{
    public const int Port = 8080;

    /// <summary>Default FleetManager base URL when the client supplies none.</summary>
    public const string DefaultApiUrl = "https://manager.rebus.fm";

    /// <summary>Concurrent upstream detail fetches within a single batch call.</summary>
    public const int MaxWorkers = 20;

    /// <summary>IDs the front end sends per /api/batch-details call.</summary>
    public const int BatchSize = 50;

    /// <summary>Per-request timeout against FleetManager.</summary>
    public static readonly TimeSpan UpstreamTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Hosts the proxy will talk to. The API URL is user-supplied, so without this
    /// the proxy would be an open SSRF relay for anyone who can reach the port.
    /// </summary>
    public static readonly string[] AllowedHosts = ["manager.rebus.fm", "localhost", "127.0.0.1"];

    /// <summary>FleetManager sits behind Cloudflare, which 1010-blocks non-browser UAs.</summary>
    public const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FleetManagerInspector/1.1";
}
