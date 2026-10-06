using System.Collections.Frozen;

namespace FleetManagerInspector;

/// <summary>
/// Serves the shared <c>static/</c> directory with a path-traversal guard.
/// Extracted from Program.cs so tests exercise the identical code path.
/// </summary>
public static class StaticFiles
{
    public static readonly FrozenDictionary<string, string> MimeTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".css"] = "text/css; charset=utf-8",
            [".js"] = "application/javascript; charset=utf-8",
            [".json"] = "application/json",
            [".png"] = "image/png",
            [".svg"] = "image/svg+xml",
            [".ico"] = "image/x-icon",
        }.ToFrozenDictionary(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Serve <paramref name="relativePath"/> from <paramref name="staticDir"/>,
    /// refusing anything that resolves outside it.
    /// </summary>
    public static async Task Serve(HttpContext ctx, string staticDir, string relativePath)
    {
        var candidate = Path.GetFullPath(Path.Combine(staticDir, relativePath));

        // Traversal guard: the resolved path must stay inside staticDir. Compare
        // against a trailing separator so a sibling like /static-evil can't pass a
        // plain prefix check.
        var root = staticDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                   + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(root, StringComparison.Ordinal))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsync("Forbidden", ctx.RequestAborted);
            return;
        }

        if (!File.Exists(candidate))
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            await ctx.Response.WriteAsync("File not found", ctx.RequestAborted);
            return;
        }

        var ext = Path.GetExtension(candidate);
        ctx.Response.ContentType = MimeTypes.TryGetValue(ext, out var type)
            ? type
            : "application/octet-stream";
        ctx.Response.Headers.CacheControl = "no-cache";

        await ctx.Response.SendFileAsync(candidate, ctx.RequestAborted);
    }

    /// <summary>
    /// Locate the shared static directory. <c>FM_STATIC_DIR</c> overrides; otherwise
    /// walk up from the running assembly looking for a sibling <c>static/</c> folder,
    /// which works both from the repo layout and from bin/Debug output.
    /// </summary>
    public static string ResolveDirectory()
    {
        var overridden = Environment.GetEnvironmentVariable("FM_STATIC_DIR");
        if (!string.IsNullOrWhiteSpace(overridden) && Directory.Exists(overridden))
        {
            return Path.GetFullPath(overridden);
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "static");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(candidate, "index.html")))
            {
                return candidate;
            }
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the shared 'static' directory. Set FM_STATIC_DIR to its path.");
    }
}
