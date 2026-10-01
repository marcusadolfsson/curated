# Instagram REST API — replication guide

> Audience: another Muse instance tasked with rebuilding this service.
> Everything below was true of the original as of 2026-10-01 (v1.3.1).

## 1. What it is

A FastAPI REST service that wraps two companion CLIs — `instagram-cli` and
`instagram-messages-cli` — and exposes Instagram DMs, posts, comments, likes,
and publishing over HTTP with API-key auth. It exists because the sandbox VM is
client-only (no inbound connections): a Mac Mini on the same Tailscale network
holds a reverse SSH tunnel so the API lands on the Mac's `localhost:8000`, and
the Mac handles all presentation. The phone never talks to the API directly.

Key architectural facts:

- The CLIs are preinstalled in the Muse VM environment and manage their own
  Instagram session. The API server never sees Instagram credentials, and every
  CLI invocation is independent — there is no persistent Instagram connection,
  so there is nothing to "reconnect".
- Auth to the API is a single shared key (`X-API-Key`), stored in `.env` as
  `IG_API_KEY`.
- Interactive docs at `/docs`.

## 2. Files

All server code lives in `~/workspace/instagram-api/` on the VM — and is
published in this repo under `instagram-api/`, so it can be shared and
replicated directly. (`.env`, logs, pidfiles, and `agent_msgs/` runtime state
are never committed; see `instagram-api/.gitignore`.)

| File              | Purpose                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `app.py`          | The whole API (~1000 lines). FastAPI app, all endpoints, DM poller thread, oEmbed cache. |
| `extract_post_json.py` | Helper for `GET /posts/images`: captures the raw logged-out Instagram post JSON (every carousel child) by reusing yt-dlp's extractor internals. Called as a subprocess; yt-dlp must be installed for the system python3. |
| `start.sh`        | Launches uvicorn on `$PORT` (default 8000) using the venv.              |
| `manage.sh`       | `start` / `stop` / `restart` / `status` / `logs` for the API process (pidfile-based). |
| `.env`            | `IG_API_KEY`, `PORT`, `DM_POLL_SECONDS`. Never commit this.             |
| `mac-tunnel.sh`   | `start` / `stop` / `restart` / `status` / `logs` for the reverse SSH tunnel to the Mac. |
| `tunnel-proxy.py` | `ProxyCommand` helper: the sandbox reaches the outside world through an egress HTTP proxy (`127.0.0.1:3130`); SSH to the Mac is tunneled through it. Without this, outbound SSH is reset by the proxy. |
| `agent_msgs/`     | JSON storage for the agent bridge (`inbox.json`, `outbox.json`) and lookup caches (`oembed_cache.json`, `video_cache.json`, `image_cache.json`). Created at runtime. |
| `README.md`       | Operator-facing reference (endpoints, config, management).              |

Runtime: Python 3.12, venv with `fastapi`, `uvicorn`, `pydantic`. Everything
else is stdlib (`urllib` for the oEmbed fetch — there is deliberately no
`requests` dependency).

## 3. Configuration

`.env`:

- `IG_API_KEY` — the shared secret. Clients send it as `X-API-Key`. Also used
  by the health-watch cron to probe `/health`.
- `PORT` — default `8000`.
- `DM_POLL_SECONDS` — server-side DM inbox poll interval for `/dms/updates`;
  default `300`, minimum `60` (enforced in code). Each poll fetches the 20
  most-recently-active threads × 20 messages.

## 4. API surface

`X-API-Key` header on everything except `/health`.

| Method | Path | Notes |
|--------|------|-------|
| GET  | `/health` | No auth. `{"ok": true, "account_id", "messages_connected": <startup snapshot>, "dm_poller": {checked_at, failures, cached_messages}}`. Served by the API process itself — if the process is dead you get connection refused, not JSON. `messages_connected` is a snapshot taken at startup; there is no live connection to monitor because every CLI call is independent. `dm_poller.failures` climbing means the background inbox poll can't reach Instagram. |
| GET  | `/docs` | Swagger UI. |
| GET  | `/dms/inbox` | Thread list. |
| GET  | `/dms/threads/{thread_fbid}/messages` | Messages in a thread. |
| GET  | `/dms/search?q=` | Search DMs. |
| POST | `/dms/send` | **Write action.** Requires explicit per-action user approval. Never test-send. |
| POST | `/dms/react` | Body: `thread_fbid`, `message_id` (`mid.$…`), `emoji`. **Write action** — same approval rule. Validation was tested, but never live-tested: a test would be a real, visible reaction. |
| GET  | `/dms/updates?since=&wait=` | New-message event feed backed by a server-side poller (see §5). |
| GET  | `/posts/by-url?url=` | Resolves a `/p/<code>/` or `/reel/<code>/` share URL via Instagram's public oEmbed endpoint (no login). Returns caption, author (username/url/id), classic media ID, thumbnail URL + dimensions, embed HTML. Cached 24h per shortcode in `agent_msgs/oembed_cache.json`. Accepts `/reels/` and normalizes it. 400 for non-Instagram or non-post URLs, 404 when Instagram can't resolve the URL (deleted/private post). |
| GET  | `/posts/video?url=` | Direct MP4 URL for a shared reel/video post via yt-dlp (no login). Returns a short-lived CDN URL — download promptly, re-request on expiry. Cached 6h per shortcode in `agent_msgs/video_cache.json` (short TTL, the URLs expire). 400 bad URL, 422 no playable video (photo post or withheld), 502/504 extraction failed. Occasional use only, not loops. Registered before `/posts/{media_id}` so "video" isn't captured as an ID. |
| GET  | `/posts/images?url=` | Every image for a shared post/carousel via the logged-out post JSON (same query yt-dlp uses, but yt-dlp itself ignores photos). Returns entries in order as `{type, url, width, height}` with the largest CDN URL per entry; single photos return one item, reels return one video item (same URL `/posts/video` gives). Cached 6h per shortcode in `agent_msgs/image_cache.json`. 400 bad URL, 422 no accessible media, 502/504 extraction failed. Occasional use only. Registered before `/posts/{media_id}`. |
| GET  | `/posts/{media_id}` | Provider lookup by numeric media ID (caption, owner, permalink, counts, sometimes a thumbnail). Does **not** return video URLs or full-size images. Note: classic shortcode base64-decoding and DM share-URL `?id=` values do **not** resolve here — they are separate ID spaces. |
| GET  | `/posts/{media_id}/comments`, `/likers`, `/insights` | As named. |
| POST | `/posts/publish` | **Write action** — same approval rule. |
| POST | `/agent/inbox` | Mac → Muse: enqueue a message for the agent. |
| GET  | `/agent/inbox?unread_only=true` | Muse reads Mac messages. |
| POST | `/agent/outbox` | Muse → Mac: enqueue a reply. |
| GET  | `/agent/outbox?unread_only=true&mark_read=true` | Mac drains replies. |

## 5. The DM updates poller

`/dms/updates` exists so the Mac can long-poll locally instead of hammering
Instagram. A background thread in the API process polls the real inbox every
`DM_POLL_SECONDS` (300s): 20 most-recently-active threads × 20 messages each,
normalized, sorted newest-first, capped at 300 messages. The `since` parameter
is compared strictly against each item's `sent_at` (derived from
`message_sent_at.utc`). Coverage is the 20 most-recently-active threads only —
a newly active thread normally sorts into that set, but this is not a
whole-inbox scan. Steady-state Instagram traffic ≈ 12 inbox requests/hour;
Mac long-polls hit the API only, not Instagram.

## 6. Reverse tunnel (remote access)

Why: the sandbox accepts no inbound connections, so the Mac cannot reach the
VM. Instead the VM dials out over Tailscale and holds a reverse forward:

```bash
ssh -N -R 8000:127.0.0.1:8000 user@<mac-tailscale-ip>
```

The Mac then uses `http://127.0.0.1:8000`.

Mac-side prerequisites:

- Tailscale up (the VM reaches the Mac at `<MAC-TAILSCALE-IP>`), Remote Login enabled,
  and the VM's SSH public key (`~/.ssh/id_ed25519.pub`) authorized.
- The authorized key is restricted to forwarding-only — therefore SSH **must**
  run with `-N` (no shell); a normal login is rejected by design.
- The Mac must stay awake; the tunnel dies with sleep.

VM side: `mac-tunnel.sh {start|stop|restart|status|logs}` manages the tunnel.
`tunnel-proxy.py` is the `ProxyCommand` carrying that SSH through the
sandbox's egress proxy.

Supervision: `mac-tunnel.sh start` launches a supervisor loop that retries the
SSH connection every 10s on drop, so brief network or Mac-sleep outages heal
themselves. A `tunnel-health-watch` cron (every 2 minutes, goal-owned)
restarts the supervisor itself if it ever dies — e.g. after a VM reboot.
Neither the API nor the tunnel starts on boot, but both self-heal within
minutes via their watcher crons (`api-health-watch` for the API,
`tunnel-health-watch` for the tunnel).

## 7. Agent bridge + scheduled jobs

The bridge lets a Mac-side agent and Muse exchange messages through the API;
storage is plain JSON in `agent_msgs/` (`inbox.json`, `outbox.json`).

Three crons keep it alive:

- `agent-inbox-watch` — every 1 minute; surfaces unread `/agent/inbox`
  messages to the operator.
- `api-health-watch` — every 5 minutes; curls `/health` and restarts the API
  via `manage.sh` if unreachable. It deliberately never touches the tunnel.
- `tunnel-health-watch` — every 2 minutes; restarts the tunnel supervisor via
  `mac-tunnel.sh start` if fully dead. Treats "supervisor running, ssh
  reconnecting" (e.g. Mac asleep) as healthy, and deliberately never touches
  the API process.

## 8. Replication checklist

1. Confirm `instagram-cli` and `instagram-messages-cli` are installed and
   authenticated for the target Instagram account (they manage their own
   session; the API never handles IG credentials).
2. Create `~/workspace/instagram-api/` with `app.py`, `start.sh`, `manage.sh`;
   `python3 -m venv .venv` and `pip install fastapi uvicorn pydantic`.
3. Write `.env` with a generated `IG_API_KEY`, `PORT=8000`,
   `DM_POLL_SECONDS=300`.
4. `./manage.sh start`; verify
   `curl -H "X-API-Key: $KEY" localhost:8000/health` and open `/docs`.
5. Verify `/dms/inbox`, `/posts/by-url?url=<a known share URL>`, and
   `/dms/updates?since=...&wait=...`.
6. On the Mac: enable Remote Login; authorize the VM's `~/.ssh/id_ed25519.pub`
   with a forwarding-only restriction; note the Tailscale IP.
7. Add `tunnel-proxy.py` + `mac-tunnel.sh`; `./mac-tunnel.sh start`; from the
   Mac, `curl http://127.0.0.1:8000/health`.
8. Seed the agent bridge (`agent_msgs/` is created on first use) and install
   the two crons from §7.
9. Never send DMs, reactions, or publishes without explicit per-action user
   approval — this is a standing user rule, not just caution.
