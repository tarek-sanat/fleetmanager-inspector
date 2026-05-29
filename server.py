#!/usr/bin/env python3
"""
FleetManager Batch Inspector
----------------------------
Local web server that proxies requests to the FleetManager (rebus.fm) External API
and serves a Chrome UI for batch-inspecting failed messages.

Usage:
    python server.py
    -> Open http://localhost:8080 in Chrome

Placeholders:
    - FleetManager API URL, token, and account ID are entered in the UI
    - No credentials are hardcoded or stored on disk
"""

import json
import os
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode

PORT = 8080
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


class ProxyHandler(BaseHTTPRequestHandler):
    """Serves static files and proxies API calls to FleetManager."""

    MIME_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
    }

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
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
        except OSError as e:
            self.send_error(500, f"Error reading file: {e}")

    def do_OPTIONS(self):
        self._cors_headers()
        self.send_response(200)
        self.end_headers()

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Proxy: batch fetch details for multiple message IDs
        if path == "/api/batch-details":
            return self._handle_batch_details(parse_qs(parsed.query))

        # Proxy: fetch active message IDs
        if path == "/api/active":
            return self._handle_active(parse_qs(parsed.query))

        # Proxy: fetch single message details
        if path == "/api/details":
            return self._handle_details(parse_qs(parsed.query))

        # Proxy: test connection
        if path == "/api/ping":
            return self._handle_ping(parse_qs(parsed.query))

        # Serve static files
        if path == "/" or path == "":
            return self._serve_file("index.html")
        if path.startswith("/static/"):
            return self._serve_file(path[7:].lstrip("/"))  # strip "/static/" prefix

        self.send_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/proxy":
            return self._handle_proxy_post()

        self.send_error(404, "Not Found")

    def _get_base_url(self):
        """Read FleetManager base URL from request headers or use default."""
        # The frontend sends the base URL as a custom header
        return "https://manager.rebus.fm"

    def _proxy_get(self, endpoint, params, auth_token):
        """Proxies a GET request to FleetManager API."""
        url = f"https://manager.rebus.fm{endpoint}"
        if params:
            qs = urlencode(params)
            url = f"{url}?{qs}"

        req = urllib.request.Request(url)
        req.add_header("Accept", "application/json")
        if auth_token:
            req.add_header("Authorization", f"Bearer {auth_token}")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body), resp.status
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="replace")
            return {"error": str(e), "detail": error_body}, e.code
        except urllib.error.URLError as e:
            return {"error": f"Connection failed: {e.reason}"}, 502

    def _handle_active(self, query):
        """GET /api/active?accountId=xxx&token=xxx"""
        account_id = query.get("accountId", [""])[0]
        auth_token = query.get("token", [""])[0]

        if not account_id or not auth_token:
            self._send_json(400, {"error": "accountId and token are required"})
            return

        data, status = self._proxy_get(
            "/ui/external/failed-messages/active",
            {"accountId": account_id},
            auth_token,
        )
        self._send_json(status, data)

    def _handle_details(self, query):
        """GET /api/details?accountId=xxx&id=yyy&token=xxx"""
        account_id = query.get("accountId", [""])[0]
        msg_id = query.get("id", [""])[0]
        auth_token = query.get("token", [""])[0]

        if not account_id or not msg_id or not auth_token:
            self._send_json(400, {"error": "accountId, id, and token are required"})
            return

        data, status = self._proxy_get(
            "/ui/external/failed-messages/details",
            {"accountId": account_id, "id": msg_id},
            auth_token,
        )
        self._send_json(status, data)

    def _handle_batch_details(self, query):
        """GET /api/batch-details?accountId=xxx&ids=id1,id2,id3&token=xxx

        Fetches details for multiple message IDs in parallel.
        Returns a dict mapping each ID to its details (or error).
        """
        account_id = query.get("accountId", [""])[0]
        ids_param = query.get("ids", [""])[0]
        auth_token = query.get("token", [""])[0]

        if not account_id or not ids_param or not auth_token:
            self._send_json(400, {"error": "accountId, ids, and token are required"})
            return

        ids = [i.strip() for i in ids_param.split(",") if i.strip()]

        if not ids:
            self._send_json(400, {"error": "No valid IDs provided"})
            return

        import concurrent.futures

        def fetch_one(msg_id):
            data, status = self._proxy_get(
                "/ui/external/failed-messages/details",
                {"accountId": account_id, "id": msg_id},
                auth_token,
            )
            return msg_id, (data, status)

        results = {}
        errors = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            futures = {executor.submit(fetch_one, msg_id): msg_id for msg_id in ids}
            for future in concurrent.futures.as_completed(futures):
                msg_id = futures[future]
                try:
                    mid, (data, status) = future.result()
                    if status == 200:
                        results[mid] = data
                    else:
                        errors.append({"id": mid, "error": data})
                except Exception as e:
                    errors.append({"id": msg_id, "error": str(e)})

        self._send_json(200, {"results": results, "errors": errors, "total": len(ids), "fetched": len(results)})

    def _handle_ping(self, query):
        """GET /api/ping?token=xxx — test if the API is reachable."""
        auth_token = query.get("token", [""])[0]
        account_id = query.get("accountId", [""])[0]

        if not account_id or not auth_token:
            self._send_json(400, {"error": "accountId and token are required"})
            return

        data, status = self._proxy_get(
            "/ui/external/failed-messages/counts",
            {"accountId": account_id},
            auth_token,
        )
        self._send_json(status, data)

    def _handle_proxy_post(self):
        """POST /api/proxy — generic proxy for any FleetManager POST endpoint."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        payload = json.loads(body.decode("utf-8"))

        endpoint = payload.get("endpoint", "")
        auth_token = payload.get("token", "")
        data = payload.get("data", {})

        if not endpoint or not auth_token:
            self._send_json(400, {"error": "endpoint and token are required"})
            return

        url = f"https://manager.rebus.fm{endpoint}"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {auth_token}",
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_body = resp.read().decode("utf-8")
                result = json.loads(resp_body) if resp_body else {}
                self._send_json(resp.status, result)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="replace")
            self._send_json(e.code, {"error": str(e), "detail": error_body})
        except urllib.error.URLError as e:
            self._send_json(502, {"error": f"Connection failed: {e.reason}"})

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def log_message(self, format, *args):
        """Quieter logging."""
        msg = format % args
        if "api/" in msg:
            print(f"[FleetManager] {msg}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), ProxyHandler)
    url = f"http://localhost:{PORT}"

    # Auto-open Chrome on Windows / WSL
    try:
        import subprocess
        if os.name == "nt":
            subprocess.Popen(["cmd", "/c", "start", "chrome", url], shell=True)
        else:
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "chrome", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception:
        pass  # Chrome auto-open is best-effort

    print("")
    print("  FleetManager Batch Inspector")
    print("  ───────────────────────────")
    print(f"  Open in Chrome: {url}")
    print("  Press Ctrl+C to stop")
    print("")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        server.server_close()