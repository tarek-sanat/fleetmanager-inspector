#!/usr/bin/env python3
"""
FleetManager Batch Inspector
----------------------------
Local web server that proxies requests to the FleetManager (rebus.fm) External API
and serves a Chrome UI for batch-inspecting failed messages.

Usage:
    python server.py
    -> Open http://localhost:8080 in Chrome

Credentials:
    The FleetManager API URL, bearer token and account ID are entered in the UI and
    sent to this proxy per-request (URL as the ``X-Fm-Api-Url`` header, token as a
    query parameter). Nothing is hardcoded and nothing is written to disk.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

PORT = 8080
DEFAULT_API_URL = "https://manager.rebus.fm"

# Concurrency / batching knobs for the parallel detail fetcher.
MAX_WORKERS = 20
BATCH_SIZE = 50

# Per-request timeout against FleetManager (seconds).
UPSTREAM_TIMEOUT = 30

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Only these hosts are accepted as a proxy target. Prevents the "editable API URL"
# feature from being turned into an open SSRF relay by anyone who can reach the port.
ALLOWED_API_HOSTS = {
    "manager.rebus.fm",
    "localhost",
    "127.0.0.1",
}


def _normalize_api_url(raw):
    """Validate and normalize a user-supplied FleetManager base URL.

    Returns the cleaned base URL (no trailing slash), or ``None`` if the input is
    missing/invalid/disallowed.
    """
    if not raw:
        return None
    url = raw.strip().rstrip("/")
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if host not in ALLOWED_API_HOSTS and not host.endswith(".rebus.fm"):
        return None
    return url


class ProxyHandler(BaseHTTPRequestHandler):
    """Serves static files and proxies API calls to FleetManager."""

    server_version = "FleetManagerInspector/1.1"

    MIME_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
    }

    protocol_version = "HTTP/1.1"

    # ── Static file serving ──────────────────────────────────────────────
    def _serve_file(self, rel_path):
        """Read a file from STATIC_DIR and serve it."""
        filepath = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not filepath.startswith(STATIC_DIR):
            self.send_error(403, "Forbidden")
            return
        if not os.path.isfile(filepath):
            self.send_error(404, "File not found")
            return
        ext = os.path.splitext(filepath)[1].lower()
        ctype = self.MIME_TYPES.get(ext, "application/octet-stream")
        try:
            with open(filepath, "rb") as f:
                data = f.read()
        except OSError as e:
            self.send_error(500, f"Error reading file: {e}")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ── CORS ─────────────────────────────────────────────────────────────
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, Authorization, X-Fm-Api-Url"
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── Routing ──────────────────────────────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        routes = {
            "/api/batch-details": self._handle_batch_details,
            "/api/active": self._handle_active,
            "/api/details": self._handle_details,
            "/api/ping": self._handle_ping,
        }
        if path in routes:
            return routes[path](query)

        if path in ("/", ""):
            return self._serve_file("index.html")
        if path.startswith("/static/"):
            return self._serve_file(path[7:].lstrip("/"))

        self.send_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/proxy":
            return self._handle_proxy_post()
        self.send_error(404, "Not Found")

    # ── Upstream helpers ─────────────────────────────────────────────────
    def _get_api_url(self):
        """Resolve the FleetManager base URL for this request.

        The UI sends the configured URL in the ``X-Fm-Api-Url`` header so that a
        self-hosted FleetManager instance works without editing the server.
        """
        raw = self.headers.get("X-Fm-Api-Url")
        return _normalize_api_url(raw) or DEFAULT_API_URL

    def _proxy_get(self, endpoint, params, auth_token, api_url):
        """Proxy a GET request to the FleetManager API.

        Returns ``(payload, status)``. On a non-2xx upstream response, ``payload``
        is ``{"error": ..., "detail": ...}`` and ``status`` carries the real upstream
        status code so the UI can distinguish 401 / 404 / 429 / 403(Cloudflare 1010).
        """
        url = f"{api_url}{endpoint}"
        if params:
            url = f"{url}?{urlencode(params)}"

        req = urllib.request.Request(url)
        req.add_header("Accept", "application/json")
        # FleetManager sits behind Cloudflare, which rejects requests without a
        # browser-ish UA (error 1010). Present as a normal client.
        req.add_header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FleetManagerInspector/1.1",
        )
        if auth_token:
            req.add_header("Authorization", f"Bearer {auth_token}")

        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                try:
                    payload = json.loads(body) if body else {}
                except json.JSONDecodeError:
                    payload = {"error": "Upstream returned non-JSON", "detail": body[:2000]}
                return payload, resp.status
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:2000]
            return self._describe_http_error(e.code, detail), e.code
        except urllib.error.URLError as e:
            return {"error": f"Connection failed: {e.reason}"}, 502
        except TimeoutError:
            return {"error": f"Upstream timed out after {UPSTREAM_TIMEOUT}s"}, 504

    @staticmethod
    def _describe_http_error(code, detail):
        """Turn an HTTP status into a human-readable error payload."""
        hints = {
            401: "Unauthorized \u2014 the bearer token is missing, expired, or wrong.",
            403: "Forbidden \u2014 token lacks access, or Cloudflare blocked the request.",
            404: "Not found \u2014 check the account ID and API URL.",
            429: "Rate limited by FleetManager. Retry in a moment.",
        }
        return {"error": hints.get(code, f"FleetManager returned HTTP {code}"), "detail": detail}

    # ── Route handlers ───────────────────────────────────────────────────
    def _require(self, query, *names):
        """Pull required query params. Returns dict, or None after sending a 400."""
        values = {}
        for name in names:
            value = query.get(name, [""])[0]
            if not value:
                self._send_json(400, {"error": f"{', '.join(names)} are required"})
                return None
            values[name] = value
        return values

    def _handle_active(self, query):
        """GET /api/active?accountId=xxx&token=xxx"""
        params = self._require(query, "accountId", "token")
        if params is None:
            return
        data, status = self._proxy_get(
            "/ui/external/failed-messages/active",
            {"accountId": params["accountId"]},
            params["token"],
            self._get_api_url(),
        )
        self._send_json(status, data)

    def _handle_details(self, query):
        """GET /api/details?accountId=xxx&id=yyy&token=xxx"""
        params = self._require(query, "accountId", "id", "token")
        if params is None:
            return
        data, status = self._proxy_get(
            "/ui/external/failed-messages/details",
            {"accountId": params["accountId"], "id": params["id"]},
            params["token"],
            self._get_api_url(),
        )
        self._send_json(status, data)

    def _handle_batch_details(self, query):
        """GET /api/batch-details?accountId=xxx&ids=id1,id2,id3&token=xxx

        Fetches details for multiple message IDs in parallel and returns a dict
        mapping each ID to its details (or an error entry).
        """
        params = self._require(query, "accountId", "ids", "token")
        if params is None:
            return

        # De-duplicate while preserving order; ignore blanks.
        seen = set()
        ids = []
        for raw_id in params["ids"].split(","):
            raw_id = raw_id.strip()
            if raw_id and raw_id not in seen:
                seen.add(raw_id)
                ids.append(raw_id)

        if not ids:
            self._send_json(400, {"error": "No valid IDs provided"})
            return

        api_url = self._get_api_url()
        token = params["token"]
        account_id = params["accountId"]

        def fetch_one(msg_id):
            data, status = self._proxy_get(
                "/ui/external/failed-messages/details",
                {"accountId": account_id, "id": msg_id},
                token,
                api_url,
            )
            return msg_id, data, status

        results = {}
        errors = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(fetch_one, msg_id): msg_id for msg_id in ids}
            for future in as_completed(futures):
                msg_id = futures[future]
                try:
                    mid, data, status = future.result()
                    if status == 200:
                        results[mid] = data
                    else:
                        errors.append({"id": mid, "status": status, "error": data})
                except Exception as e:  # defensive: a worker must never kill the batch
                    errors.append({"id": msg_id, "status": 0, "error": str(e)})

        self._send_json(
            200,
            {
                "results": results,
                "errors": errors,
                "total": len(ids),
                "fetched": len(results),
            },
        )

    def _handle_ping(self, query):
        """GET /api/ping?token=xxx&accountId=yyy — test connectivity + auth."""
        params = self._require(query, "accountId", "token")
        if params is None:
            return
        data, status = self._proxy_get(
            "/ui/external/failed-messages/counts",
            {"accountId": params["accountId"]},
            params["token"],
            self._get_api_url(),
        )
        self._send_json(status, data)

    def _handle_proxy_post(self):
        """POST /api/proxy — generic proxy for any FleetManager POST endpoint."""
        payload = self._read_json_body()
        if payload is None:
            return

        endpoint = payload.get("endpoint", "")
        auth_token = payload.get("token", "")
        data = payload.get("data", {})

        if not endpoint or not auth_token:
            self._send_json(400, {"error": "endpoint and token are required"})
            return
        if not endpoint.startswith("/"):
            self._send_json(400, {"error": "endpoint must be an absolute API path"})
            return

        api_url = _normalize_api_url(payload.get("apiUrl")) or DEFAULT_API_URL
        url = f"{api_url}{endpoint}"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {auth_token}",
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FleetManagerInspector/1.1",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                result = json.loads(body) if body else {}
                self._send_json(resp.status, result)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:2000]
            self._send_json(e.code, self._describe_http_error(e.code, detail))
        except urllib.error.URLError as e:
            self._send_json(502, {"error": f"Connection failed: {e.reason}"})
        except TimeoutError:
            self._send_json(504, {"error": f"Upstream timed out after {UPSTREAM_TIMEOUT}s"})

    # ── Response helpers ─────────────────────────────────────────────────
    def _read_json_body(self):
        """Read + parse a JSON request body. Returns None after sending a 400."""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            self._send_json(400, {"error": "Empty request body"})
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "Malformed JSON body"})
            return None

    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - matches base signature
        """Only log API traffic; keep static-file noise out of the console."""
        msg = format % args
        if "/api/" in msg:
            sys.stderr.write(f"[FleetManager] {msg}\n")


def main():
    try:
        server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    except OSError as e:
        print(f"\n  Could not bind port {PORT}: {e}")
        print(f"  Is another copy already running? Change PORT in {__file__}.\n")
        raise SystemExit(1)

    url = f"http://localhost:{PORT}"

    # Auto-open Chrome on Windows / WSL (best-effort).
    try:
        import subprocess

        if os.name == "nt":
            subprocess.Popen(["cmd", "/c", "start", "chrome", url], shell=False)
        elif os.path.exists("/mnt/c/Windows"):
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "chrome", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception:
        pass

    print("")
    print("  FleetManager Batch Inspector")
    print("  \u2500" * 27)
    print(f"  Open in Chrome: {url}")
    print("  Press Ctrl+C to stop")
    print("")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
