# FleetManager Batch Inspector

Batch-inspect and search all failed Rebus messages in FleetManager without clicking each one manually.

## Problem

FleetManager's web UI loads a list of failed message IDs but fetches message **details** (including the decoded body) one-at-a-time as you click each message. With 1000 non-idempotent errors, this means 1000 manual clicks to find the data you need.

## Solution

A local web server that:

1. Fetches all active failed message IDs in one call
2. Fetches **all** message details in parallel (20 concurrent workers, 50-per-batch)
3. Decodes base64 message bodies
4. Displays everything in a searchable, dark-themed UI
5. No credentials stored — enter token + account ID in the browser

## How to use

```bash
cd fleetmanager-inspector
python server.py
```

→ Opens Chrome at `http://localhost:8080`

1. Enter your FleetManager **Account ID** and **Bearer Token** (generate in FleetManager → Team Setup → External API)
2. Click **Test Connection** to verify
3. Click **Fetch All Messages** to load everything at once
4. Use the search box to find specific text in message bodies
5. Click message IDs to copy them; use the detail panel to see full decoded bodies

### Keyboard shortcuts

| Key | Action |
|---|---|
| `↓` / `j` | Next message |
| `↑` / `k` | Previous message |
| `PgDn` / `PgUp` | Jump 10 messages |
| `Home` / `End` | First / last message |
| `Enter` | Copy selected message ID |
| `c` | Copy selected body |
| `Ctrl+F` | Focus search |
| `n` | Load / refresh |

## How it works

```
┌────────────┐    GET /api/batch-details      ┌──────────────┐
│  Chrome    │ ──────────────────────────────> │  Python      │
│  (UI)      │ <────────────────────────────── │  Proxy       │
│            │    JSON (bodies decoded)        │  (local)     │
└────────────┘                                 └──────┬───────┘
                                                       │
                                           GET /ui/external/failed-messages/*
                                                       │
                                               ┌───────┴────────┐
                                               │  FleetManager  │
                                               │  (manager.rebus.fm)
                                               └────────────────┘
```

The Python proxy avoids CORS issues and batches requests for performance. The configured API URL is forwarded per-request via the `X-Fm-Api-Url` header; the proxy only accepts `*.rebus.fm` and localhost targets so it can't be used as a general-purpose relay.

The message list uses virtual scrolling — only the rows currently on screen are in the DOM — so loading 10,000+ messages keeps the UI responsive.

## API Reference

See [FleetManager External API](https://github.com/rebus-org/FleetManager/wiki/External-API) docs.

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /ui/external/failed-messages/active` | List all active failed message IDs |
| `GET /ui/external/failed-messages/details` | Get details for one message |
| `GET /ui/external/failed-messages/counts` | Connection test / counts |
| `POST /ui/external/failed-messages/send-to-queue` | (optional) Republish messages |

### Message body format

The `body` field in `FailedMessageDetails` is **Base64-encoded**. The app decodes it automatically (as UTF-8, so non-ASCII payloads survive).

## Tests

```bash
python3 tests/smoke_test.py          # server: routing, status codes, SSRF guard
node tests/ui_test.js                # UI: virtual scroll, filters, highlighter
```

The UI test needs `jsdom` (`npm install jsdom`). Both suites run offline — no FleetManager account required.

## File layout

```
fleetmanager-inspector/
├── server.py             # Python HTTP server + API proxy
├── static/
│   ├── index.html        # Chrome UI
│   ├── style.css         # Dark theme
│   └── app.js            # Frontend logic
├── tests/
│   ├── smoke_test.py     # Server-side smoke tests
│   └── ui_test.js        # Headless DOM tests (jsdom)
├── .gitignore
└── README.md
```

## Notes / gotchas

- **Token handling** — the bearer token is kept in memory for the session only; it is *not* written to `localStorage`. Clearing browser data clears the cached account ID and API URL.
- **Cloudflare** — FleetManager sits behind Cloudflare, which rejects requests with non-browser User-Agents. The proxy sets a browser-like UA.
- **Port conflicts** — if 8080 is taken, change `PORT` in `server.py`.
- **Python 3.14** — the server deliberately uses `BaseHTTPRequestHandler` (not `SimpleHTTPRequestHandler`, which hangs on 3.14).
