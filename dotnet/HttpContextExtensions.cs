using System.Text.Json;

namespace FleetManagerInspector;

/// <summary>Response helpers shared by the endpoint handlers.</summary>
public static class HttpContextExtensions
{
    public static async Task WriteJsonAsync(this HttpContext ctx, int status, JsonElement payload)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync(payload.GetRawText(), ctx.RequestAborted);
    }

    /// <summary>Write the same <c>{"error": "..."}</c> shape the Python server uses.</summary>
    public static Task JsonError(this HttpContext ctx, int status, string message)
        => ctx.WriteJsonAsync(status, Json.Error(message));
}
