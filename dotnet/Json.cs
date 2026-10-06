using System.Text.Json;

namespace FleetManagerInspector;

/// <summary>
/// Helpers for building the JSON responses the front end expects.
/// XmlDocument/Utf8JsonWriter rather than source-generated DTOs keeps the proxy
/// transparent: payloads pass through unchanged.
/// </summary>
public static class Json
{
    public static JsonElement Object() => Parse("{}");

    public static JsonElement Parse(string s) => JsonDocument.Parse(s).RootElement.Clone();

    public static JsonElement Error(string message, string? detail = null)
    {
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("error", message);
            if (detail is not null)
            {
                writer.WriteString("detail", detail);
            }
            writer.WriteEndObject();
        }
        return Parse(System.Text.Encoding.UTF8.GetString(buffer.ToArray()));
    }

    /// <summary>
    /// Build the batch-details response shape:
    /// <c>{ results: {id: detail}, errors: [...], total: N, fetched: M }</c>
    /// </summary>
    public static byte[] BatchPayload(BatchResult batch)
    {
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();

            writer.WritePropertyName("results");
            writer.WriteStartObject();
            foreach (var (id, detail) in batch.Results)
            {
                writer.WritePropertyName(id);
                detail.WriteTo(writer);
            }
            writer.WriteEndObject();

            writer.WritePropertyName("errors");
            writer.WriteStartArray();
            foreach (var err in batch.Errors)
            {
                writer.WriteStartObject();
                writer.WriteString("id", err.Id);
                writer.WriteNumber("status", err.Status);
                // Match the Python server: the error field may be a JSON object or a
                // plain string. The front end's _errorText() handles both.
                try
                {
                    using var doc = JsonDocument.Parse(err.Error);
                    writer.WritePropertyName("error");
                    doc.RootElement.WriteTo(writer);
                }
                catch (JsonException)
                {
                    writer.WriteString("error", err.Error);
                }
                writer.WriteEndObject();
            }
            writer.WriteEndArray();

            writer.WriteNumber("total", batch.Total);
            writer.WriteNumber("fetched", batch.Fetched);
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }
}
