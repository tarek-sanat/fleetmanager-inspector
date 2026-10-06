using FleetManagerInspector;
using Xunit;

namespace FleetManagerInspector.Tests;

/// <summary>
/// Parity tests for <see cref="ApiUrl"/>. These mirror the assertions in
/// tests/smoke_test.py so both server implementations are held to one contract.
/// </summary>
public class ApiUrlTests
{
    [Theory]
    [InlineData("https://manager.rebus.fm", "https://manager.rebus.fm")]
    [InlineData("https://manager.rebus.fm/", "https://manager.rebus.fm")]
    [InlineData("https://myco.rebus.fm", "https://myco.rebus.fm")]
    [InlineData("http://localhost:9000", "http://localhost:9000")]
    [InlineData("  https://manager.rebus.fm  ", "https://manager.rebus.fm")]
    public void AcceptsAllowedHosts(string input, string expected)
    {
        Assert.Equal(expected, ApiUrl.Normalize(input));
    }

    [Theory]
    [InlineData("https://example.com")]          // arbitrary host
    [InlineData("http://169.254.169.254/")]      // cloud metadata endpoint
    [InlineData("file:///etc/passwd")]           // non-http scheme
    [InlineData("ftp://manager.rebus.fm")]       // non-http scheme
    [InlineData("")]                             // empty
    [InlineData("   ")]                          // whitespace
    [InlineData("not a url")]                    // relative / malformed
    public void RejectsDisallowedInput(string input)
    {
        Assert.Null(ApiUrl.Normalize(input));
    }

    [Fact]
    public void RejectsNull() => Assert.Null(ApiUrl.Normalize(null));

    [Fact]
    public void SubstringTrickIsRejected()
    {
        // A naive Contains("rebus.fm") check would accept this. We compare the
        // parsed host instead, so the query string can't smuggle a host in.
        Assert.Null(ApiUrl.Normalize("https://evil.example/?x=.rebus.fm"));
    }

    [Fact]
    public void LookalikeDomainIsRejected()
    {
        // "notrebus.fm" must not pass an endswith(".rebus.fm") test.
        Assert.Null(ApiUrl.Normalize("https://notrebus.fm"));
    }

    [Fact]
    public void ResolveFallsBackToDefault()
    {
        Assert.Equal(Config.DefaultApiUrl, ApiUrl.Resolve(null));
        Assert.Equal(Config.DefaultApiUrl, ApiUrl.Resolve("https://example.com"));
        Assert.Equal("https://myco.rebus.fm", ApiUrl.Resolve("https://myco.rebus.fm"));
    }

    [Theory]
    [InlineData(401, "Unauthorized")]
    [InlineData(403, "Forbidden")]
    [InlineData(404, "Not found")]
    [InlineData(429, "Rate limited")]
    public void DescribeErrorGivesActionableHints(int code, string expectedFragment)
    {
        Assert.Contains(expectedFragment, ApiUrl.DescribeHttpError(code));
    }

    [Fact]
    public void DescribeErrorFallsBackForUnknownCodes()
    {
        Assert.Contains("HTTP 500", ApiUrl.DescribeHttpError(500));
    }
}
