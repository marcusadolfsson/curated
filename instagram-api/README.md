# Instagram API

A small REST API for your connected Instagram account, covering **DMs**, **posts**, and **reels**.
Built with FastAPI; it shells out to `instagram-cli` and `instagram-messages-cli` under the hood,
so it works with whatever account is already connected in this environment.

## Quick start

```bash
cd ~/workspace/instagram-api
./start.sh
```

On first run it creates `.env` with a generated API key. The server listens on
`http://127.0.0.1:8000` and interactive docs are at `/docs`.

Every request except `GET /health` needs the header:

```
X-API-Key: <the key in .env>
```

Example:

```bash
KEY=$(grep IG_API_KEY .env | cut -d= -f2)

# Inbox preview
curl -s -H "X-API-Key: $KEY" "http://127.0.0.1:8000/dms/inbox?first=10" | head -c 600

# Your latest posts
curl -s -H "X-API-Key: $KEY" "http://127.0.0.1:8000/posts?limit=5" | head -c 600

# Your latest reels
curl -s -H "X-API-Key: $KEY" "http://127.0.0.1:8000/reels?limit=5" | head -c 600
```

## Endpoints

### Health
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Status, account id, DM connection state (no key needed) |
| GET | `/accounts` | Connected Instagram accounts |

### DMs
| Method | Path | Description |
|---|---|---|
| GET | `/dms/inbox?folder=&first=&message_count=&after=` | Inbox threads (`folder`: inbox, pending, spam) |
| GET | `/dms/inbox/filtered?filter=&thread_limit=&message_count=` | unread, unanswered, starred, groups, verified, ... (professional accounts) |
| GET | `/dms/threads/{thread_fbid}?first=&after=` | Messages in one thread |
| GET | `/dms/top-recipients?count=` | People you message most |
| GET | `/dms/search?keyword=&start_date=&end_date=&max_results=` | Keyword search across DMs |
| GET | `/dms/search?contact=...` | Search DMs by contact name |
| GET | `/dms/temporal?start_date=&end_date=&max_results=` | DMs in a date range |
| POST | `/dms/send` | Send a DM — JSON `{thread_fbid}` or `{recipient_user_fbids:[...]}`, plus `text`, `media_fbid`, `reply_to_message_id` |
| POST | `/dms/send-file` | Send a DM with a file (multipart; 40 MB max) |
| POST | `/dms/react` | React to a message — JSON `{"thread_fbid":"...","message_id":"mid.$...","emoji":"❤️"}`. Visible to the other person; new, not yet live-tested |
| POST | `/dms/react/queue` | Queue a reaction for the sender task — same body as `/dms/react`. Returns immediately, no approval card. Limited to 9 emoji + `REACT_QUEUE_THREADS` |
| POST | `/dms/send/queue` | Queue a text DM — JSON `{"thread_fbid":"...","text":"..."}`. Returns immediately, no approval card |
| GET | `/dms/queue` | Outbound queue status (queued / sent / failed) |
| GET | `/dms/updates?since=&wait=` | New-message event feed (see below) — poll this instead of `/dms/inbox` |

### DM live updates (`GET /dms/updates`)

A background thread polls the Instagram inbox every `DM_POLL_SECONDS`
(20 threads × 20 messages per poll, so share bursts aren't truncated) and
caches the snapshot, so Mac-side polling is cheap and never hammers
Instagram. Recommended loop:

```bash
# long-poll up to 45s for messages newer than the last seen one
curl -s -H "X-API-Key: $KEY" \
  "http://127.0.0.1:8000/dms/updates?since=2026-10-01T17:00:00Z&wait=45"
```

- `since` — ISO8601 timestamp; returns messages sent strictly after it.
  Omit it (with `wait=0`) to get the messages from the most recent poll cycle.
- `wait` — 0–120 seconds. Holds the request until new messages arrive or the
  timeout expires. With no `since`, waits for messages arriving after the
  request time.
- Response: `{"messages":[...],"count":n,"checked_at":"...","poll_interval_s":180,
  "poller_failures":0,"warming_up":false}`. Each message carries
  `thread_fbid`, `thread_title`, `message_id`, `sender_fbid`, `sent_at` (UTC
  ISO), `content_type`, `text`, and `share_url` (for post/reel shares).
- Pass the newest message's `sent_at` back as `since` on the next call.
- Do not poll `/dms/inbox?first=20&message_count=3` in a tight loop yourself —
  every call is a real Instagram request and the provider rate-limits
  persistent polling. Use `/dms/updates` instead.

### Outbound queue (`POST /dms/react/queue`, `POST /dms/send/queue`)

Direct `POST /dms/react` and `POST /dms/send` trigger a per-action approval
card on the phone (the runtime gates the CLI write itself, no matter who
called the API). The queue endpoints avoid that: they validate, append to
`agent_msgs/outbound_queue.json`, and return immediately — no CLI call, no
card, no blocking.

A scheduled task, `outbound-queue-sender` (every 30s), drains the queue by
running `drain_outbound_queue.py`, which invokes the CLIs directly. That
task carries the standing Allow for sending — enable it in the task's Allow
setting, then enable the task. `GET /dms/queue` shows queued / sent / failed
items with timestamps.

Narrowing (enforced at enqueue time):
- Reactions: only ❤️ 😍 🤤 🔥 👏 💡 😂 😮 👍, and only threads listed in
  `REACT_QUEUE_THREADS` (comma-separated thread_fbids in `.env`).
- Sends: text-only DMs to a thread, 1000 chars max (no attachments in v1).
- Identical pending reactions are deduped, not double-queued.

### Posts & reels
| Method | Path | Description |
|---|---|---|
| GET | `/profile` | Profile bio and follower counts |
| GET | `/posts?username=&limit=&post_types=&since=&until=&sort_order=&after=` | Posts (omit `username` for your own) |
| GET | `/reels?limit=&since=&until=&sort_order=&after=` | Your reels |
| GET | `/posts/{media_id}` | Single post — works for other accounts' posts too (see notes) |
| GET | `/posts/by-url?url=` | Resolve a /p/ or /reel/ share URL to metadata (see below) |
| GET | `/posts/video?url=` | Direct MP4 URL for a shared reel/video post (see below) |
| GET | `/posts/images?url=` | Every image for a shared post/carousel, largest CDN URLs (see below) |
| GET | `/posts/{media_id}/comments?limit=&after=` | Comments |
| GET | `/posts/{media_id}/likers?limit=&after=` | Likers |
| GET | `/insights?start_time=&end_time=` | Account insights (unix seconds; professional accounts) |
| POST | `/posts/publish` | Publish: 1 image = post, 1 video = reel, 2+ files = carousel (multipart `files`, `covers` per video, `caption`, `mentions` JSON) |
| POST | `/reels/publish` | Publish a reel (multipart `video`, `cover`, `caption`) |

### Agent message bridge (Mac agent <-> Muse)
| Method | Path | Description |
|---|---|---|
| POST | `/agent/inbox` | Send Muse a message — JSON `{"sender":"mac-agent","text":"..."}` |
| GET | `/agent/inbox?unread_only=true` | List queued messages |
| POST | `/agent/outbox` | Muse replies here — JSON `{"text":"..."}` |
| GET | `/agent/outbox?unread_only=true&mark_read=true` | Poll for replies (fetch-and-clear) |

A scheduled check (`agent-inbox-watch`, every 1 min) picks up unread inbox
messages and surfaces them in chat. The tunnel must be up for the Mac to reach
these: `~/workspace/instagram-api/mac-tunnel.sh start`.

## Publishing notes

- Sends, reactions, and publishes are real and cannot be undone. The API never
  retries a publish, because a retry could create a duplicate.
- Media is uploaded to a local `uploads/` staging folder and deleted after the
  CLI finishes, so never put secrets or unrelated files there.
- Video files need one cover image each. Images: JPEG/PNG/WebP. Videos: MP4/MOV.
- Instagram enforces a per-account daily publish limit; the API returns the
  provider's error if you hit it.

## Post lookup notes (`GET /posts/{media_id}`)

- Works for other accounts' posts, not just your own — caption, owner
  (`username`, `author_name`, `author_id`), permalink `url`, `media_type`,
  like/comment counts, and `thumbnail_url` (not always present).
- There is **no direct video/mp4 or full-size image URL** in the response —
  only the thumbnail and the permalink.
- `media_id` must be the provider's numeric ID (as returned by `/posts`
  listings). The classic shortcode base64-decode does **not** map to this ID
  space, and neither the shortcode itself nor the `?id=` parameter found in DM
  share URLs resolves via this endpoint.

## Share-URL lookup (`GET /posts/by-url?url=<share_url>`)

For `/p/<code>/` or `/reel/<code>/` links from DMs, where no provider media ID
is available. Resolves via Instagram's public oEmbed endpoint (no login):

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://127.0.0.1:8000/posts/by-url?url=https://www.instagram.com/reel/Dd5HnKTu8Ar/"
```

Returns `source: "oembed"` plus `shortcode`, `url`, `media_id` (classic
`<id>_<userid>` form), `caption`, `author_username`, `author_url`,
`author_id`, `thumbnail_url` (+ width/height), and `embed_html` (Instagram's
embed block, ready to render). Results are cached 24h per shortcode
(`cached: true` on hits). Returns 404 if Instagram can't resolve the URL
(deleted/private post) and 400 for non-Instagram or non-post URLs.

## Direct video lookup (`GET /posts/video?url=<share_url>`)

For reels/video posts shared in DMs — the provider lookup returns no video
URLs. Resolves via yt-dlp (no login) to a short-lived MP4 CDN URL:

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://127.0.0.1:8000/posts/video?url=https://www.instagram.com/reel/Dd5HnKTu8Ar/"
```

Returns `shortcode`, `url`, `video_url`, and `cached`. The CDN URL expires —
download it promptly and re-request if it goes stale. Results are cached 6h
per shortcode (short TTL on purpose, since the URLs expire). Returns 400 for
bad URLs, 422 when the post has no playable video (photo post, or Instagram
withheld it), and 502/504 when extraction fails or times out. Intended for
occasional use (a few lookups a day), not tight loops. Requires yt-dlp
installed for the system python3 (`pip install yt-dlp`); the API venv does
not need it.

## Carousel / photo image lookup (`GET /posts/images?url=<share_url>`)

For carousels and photo posts shared in DMs — the provider lookup returns no
usable image URLs, and yt-dlp itself only emits video. The same logged-out
GraphQL post query yt-dlp uses carries every carousel child with full image
data, so this endpoint captures that raw response (`extract_post_json.py`)
and returns the largest CDN URL per entry, in order:

```bash
curl -s -H "X-API-Key: $KEY" \
  "http://127.0.0.1:8000/posts/images?url=https://www.instagram.com/p/DOL6hKXgPSJ/"
```

Returns `shortcode`, `url`, `cached`, and `items` — each item is
`{type, url, width, height}` with `type` of `image` or `video`. A
single-photo post returns one item; a reel returns one video item (the same
URL `/posts/video` would give). The CDN URLs are short-lived — download them
promptly and re-request if they go stale. Results are cached 6h per shortcode.
Returns 400 for bad URLs, 422 when the post has no accessible media (private
post, or Instagram withheld it), and 502/504 when extraction fails or times
out. Intended for occasional use (a few lookups a day), not tight loops.

## Managing the server

```bash
cd ~/workspace/instagram-api
./manage.sh status    # is it running? includes /health check + tunnel state
./manage.sh start     # start in background
./manage.sh stop      # stop API and tunnel
./manage.sh restart   # restart
./manage.sh logs      # last 50 lines of server.log (add a number for more)
```

You can also just ask me in chat — "is the API running?" — and I'll check.
If the machine reboots, neither the API nor the tunnel auto-starts, but both
self-heal within minutes via their watcher crons (see below) — no manual
restart needed.

Two scheduled supervisors keep the service alive:

- `api-health-watch` (every 5 min) curls `/health` and restarts the API via
  `./manage.sh restart` if it stops responding, so a silent death under
  memory pressure gets recovered automatically. It never touches the tunnel.
- `tunnel-health-watch` (every 2 min) restarts the tunnel supervisor via
  `./mac-tunnel.sh start` if it is fully dead. It never touches the API.

The tunnel supervisor itself retries a dropped SSH connection every 10s, so
brief outages (Mac asleep, Tailscale blip) heal without the cron.

### `/health` semantics

- `/health` is served by the API process itself. If the process is down, there
  is **no JSON response at all** — you get connection refused, not
  `messages_connected: false`.
- `messages_connected` is a snapshot taken once at startup, not a live value.
- `dm_poller` reports the background inbox poll behind `/dms/updates`:
  `checked_at` (last successful cycle), `failures` (consecutive failed polls),
  `cached_messages`. If `failures` keeps climbing, the poller can't reach
  Instagram — `/dms/updates` keeps serving the last good snapshot meanwhile.
- There is no persistent connection to Instagram to "reconnect": every CLI
  call is an independent request, so recovery is just the process coming back.

## Configuration

- `IG_API_KEY` — required; generated automatically on first `./start.sh`.
- `PORT` — default `8000`.
- `IG_ACCOUNT_ID` — optional; defaults to the first connected account.
- `DM_POLL_SECONDS` — inbox poll interval backing `/dms/updates`; default 180,
  minimum 60 (this deployment sets 300 in `.env`). Lower = fresher DMs but more
  Instagram requests; the provider rate-limits persistent polling, so keep it
  at 120+ unless you have a reason.
