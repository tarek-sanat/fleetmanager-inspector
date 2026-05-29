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
cd fleetmanager-tool
python server.py
```

→ Opens Chrome at `http://localhost:8080`

1. Enter your FleetManager **Account ID** and **Bearer Token** (generate in FleetManager → Team Setup → External API)
2. Click **Test Connection** to verify
3. Click **Fetch All Messages** to load everything at once
4. Use the search box to find specific text in message bodies
5. Click message IDs to copy them; expand cards to see full decoded bodies

## How it works

```
┌────────────┐    POST /api/batch-details     ┌──────────────┐
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

The Python proxy avoids CORS issues and batches requests for performance.

## API Reference

See [FleetManager External API](https://github.com/rebus-org/FleetManager/wiki/External-API) docs.

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /ui/external/failed-messages/active` | List all active failed message IDs |
| `GET /ui/external/failed-messages/details` | Get details for one message |
| `POST /ui/external/failed-messages/send-to-queue` | (optional) Republish messages |

### Message body format

The `body` field in `FailedMessageDetails` is **Base64-encoded**. The app decodes it automatically.

## File layout

```
fleetmanager-tool/
├── server.py          # Python HTTP server + API proxy
├── static/
│   ├── index.html     # Chrome UI
│   ├── style.css      # Dark theme
│   └── app.js         # Frontend logic
├── .gitignore
└── README.md
```