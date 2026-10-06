"""Smoke test for the FleetManager Batch Inspector server.

Runs the real ProxyHandler over a real HTTP connection on an ephemeral port, so it
validates routing, status codes, JSON shapes, the SSRF allowlist and the
path-traversal guard without needing anything external.

    python3 tests/smoke_test.py
"""

import http.client
import importlib.util
import json
import os
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("fm_server", os.path.join(ROOT, "server.py"))
assert spec and spec.loader, "could not load server.py"
mod = importlib.util.module_from_spec(spec)
sys.modules["fm_server"] = mod
spec.loader.exec_module(mod)

failures = []


def check(label, got, want):
    ok = got == want
    if not ok:
        failures.append(label)
    print(f"  {'PASS' if ok else 'FAIL'}  {label:52} -> {got!r}")
    return ok


# ── 1. SSRF guard / URL normalisation ────────────────────────────────────────
print("== _normalize_api_url ==")
for raw, want in [
    ("https://manager.rebus.fm", "https://manager.rebus.fm"),
    ("https://manager.rebus.fm/", "https://manager.rebus.fm"),
    ("https://myco.rebus.fm", "https://myco.rebus.fm"),
    ("http://localhost:9000", "http://localhost:9000"),
    ("https://example.com", None),
    ("http://169.254.169.254/", None),
    ("file:///etc/passwd", None),
    ("", None),
    (None, None),
    ("not a url", None),
]:
    check(f"normalize({raw!r})", mod._normalize_api_url(raw), want)

# ── 2. Real HTTP round-trip ──────────────────────────────────────────────────
srv = mod.HTTPServer(("127.0.0.1", 0), mod.ProxyHandler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
print(f"\n== HTTP round-trip on 127.0.0.1:{port} ==")


def request(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, body=body, headers=headers or {})
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, payload


for method, path, body, headers, want in [
    ("GET", "/", None, None, 200),
    ("GET", "/static/app.js", None, None, 200),
    ("GET", "/static/style.css", None, None, 200),
    ("GET", "/nope", None, None, 404),
    # Path traversal is rejected by the explicit STATIC_DIR guard (403), not 404.
    ("GET", "/static/../server.py", None, None, 403),
    ("GET", "/api/ping", None, None, 400),
    ("GET", "/api/batch-details?accountId=x&token=y", None, None, 400),
    ("POST", "/api/proxy", "not-json", None, 400),
    ("POST", "/api/proxy", json.dumps({"endpoint": "/x"}), None, 400),
    ("OPTIONS", "/api/ping", None, None, 204),
]:
    try:
        status, data = request(method, path, body, headers)
    except Exception as exc:  # pragma: no cover - surfaced as a failure
        status, data = f"EXC {exc}", b""
    check(f"{method} {path}", status, want)
    if status == 200 and path in ("/", "/static/app.js"):
        assert data, f"{path} returned an empty body"
    # Every /api/ response (success or error) must be valid JSON; static 404s
    # legitimately return the stdlib HTML error page.
    if path.startswith("/api/") and data:
        try:
            json.loads(data)
        except json.JSONDecodeError:
            failures.append(f"{method} {path} non-JSON")
            print(f"  FAIL  {method} {path} returned non-JSON body: {data[:120]!r}")

srv.shutdown()

print()
if failures:
    print(f"FAILED ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("All smoke checks passed.")
