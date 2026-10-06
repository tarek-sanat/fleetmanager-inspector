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

Two interchangeable servers ship in this repo — a Python one and a .NET 10 one.
Both serve the same `static/` front end and expose the same API, so use whichever
fits your machine.

### .NET 10 (recommended on Windows)

```bash
dotnet run --project dotnet
```

→ Opens at `http://localhost:8080`

### Python 3 (no SDK required)

```bash
python server.py
```

→ Opens Chrome at `http://localhost:8080`

### Then, in either case

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
# .NET (35 tests)
dotnet test FleetManagerInspector.slnx

# Python server + jsdom UI suite (56 checks)
python3 tests/smoke_test.py
node tests/ui_test.js
```

Both suites run offline — no FleetManager account required. The C# and Python
server tests assert the same contract, so a behavioural drift between the two
implementations shows up as a failure.

## File layout

```
fleetmanager-inspector/
├── server.py                     # Python HTTP server + API proxy
├── FleetManagerInspector.slnx    # .NET solution
├── static/                       # Shared front end (used by BOTH servers)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── dotnet/                       # .NET 10 server
│   ├── Program.cs                # Host, routing, startup
│   ├── Config.cs                 # Port, timeouts, allowed hosts
│   ├── ApiUrl.cs                 # URL validation + error hints
│   ├── FleetManagerClient.cs     # Upstream HTTP client, parallel batch fetch
│   ├── Endpoints.cs              # The five /api routes
│   ├── StaticFiles.cs            # Static file serving + traversal guard
│   ├── Json.cs                   # Response shaping
│   └── HttpContextExtensions.cs
├── dotnet-tests/                 # xUnit parity tests
│   ├── ApiUrlTests.cs
│   ├── ServerSmokeTests.cs
│   └── WebApplicationFixture.cs
├── tests/                        # Python-server + UI tests
│   ├── smoke_test.py
│   └── ui_test.js
└── README.md
```

## Choosing between the two servers

They are feature-equivalent and share one front end. Practical differences:

| | .NET 10 | Python 3 |
|---|---|---|
| Runtime needed | .NET 10 SDK | Any Python 3.8+ |
| Startup | ~1s | Instant |
| Concurrency | Native async, `SemaphoreSlim` gate | `ThreadPoolExecutor` |
| Port change | `Config.Port` in `dotnet/Config.cs` | `PORT` in `server.py` |
| Static dir override | `FM_STATIC_DIR` env var | Fixed to `./static` |

If you change the API contract, change it in **both** servers and re-run both test
suites — that's what they're there for.

## Notes / gotchas

- **Token handling** — the bearer token is kept in memory for the session only; it is *not* written to `localStorage`. Clearing browser data clears the cached account ID and API URL.
- **Cloudflare** — FleetManager sits behind Cloudflare, which rejects requests with non-browser User-Agents. The proxy sets a browser-like UA.
- **Port conflicts** — if 8080 is taken, change `PORT` in `server.py`.
- **Python 3.14** — the server deliberately uses `BaseHTTPRequestHandler` (not `SimpleHTTPRequestHandler`, which hangs on 3.14).
