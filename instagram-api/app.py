"""Instagram API — a small FastAPI service wrapping instagram-cli and
instagram-messages-cli for the user's own connected Instagram account.

Endpoints are grouped under: health, dms, posts, reels.
Auth: every request (except /health) requires header `X-API-Key: <IG_API_KEY>`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Security,
    UploadFile,
)
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, model_validator

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)


def _load_dotenv() -> None:
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


_STABLE_PROXY_URL = "http://hatch-egress-proxy:3128"  # no-auth; set below
_FALLBACK_PROXY_URL: Optional[str] = None  # original credentialed URL, if any
_PROXY_NEEDS_AUTH = False  # flipped True once the proxy demands auth (407)


def _pin_stable_egress_proxy() -> None:
    """Pin the sandbox egress proxy to its static credential-free URL.

    The sandbox rotates the proxy credential (~hourly) and this process
    keeps its spawn-time value in os.environ. A stale credentialed URL does
    not fail cleanly: the MITM relay truncates response bodies at exactly
    4064 bytes (IncompleteRead) instead of returning 407. The relay works
    fine without credentials (verified 2026-10-09 for instagram.com,
    graph.facebook.com, cdninstagram.com), and the host itself never
    rotates, so strip any credentials once at startup. This also covers
    child processes (yt-dlp, instagram-cli), which inherit os.environ.

    The original credentialed URL is kept as _FALLBACK_PROXY_URL: no-auth
    may be a proxy misconfiguration rather than a promise, so if the proxy
    ever starts demanding authentication (407), requests fall back to it.
    """
    global _STABLE_PROXY_URL, _FALLBACK_PROXY_URL
    raw = (
        os.environ.get("https_proxy")
        or os.environ.get("HTTPS_PROXY")
        or "http://hatch-egress-proxy:3128"
    )
    try:
        parts = urllib.parse.urlsplit(raw)
        host = parts.hostname or "hatch-egress-proxy"
        port = f":{parts.port}" if parts.port else ""
        if "@" in parts.netloc:
            _FALLBACK_PROXY_URL = raw  # keep the credentialed URL just in case
        _STABLE_PROXY_URL = f"http://{host}{port}"
    except ValueError:
        _STABLE_PROXY_URL = "http://hatch-egress-proxy:3128"
    for key in (
        "http_proxy", "https_proxy", "all_proxy",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    ):
        os.environ[key] = _STABLE_PROXY_URL


_pin_stable_egress_proxy()


def _flag_proxy_needs_auth() -> None:
    """Record that the proxy demands authentication.

    Once set, new requests and subprocesses use the credentialed fallback
    URL instead of the no-auth one. One-way: a 407 is an auth demand, not
    a transient error; a restart resets it.
    """
    global _PROXY_NEEDS_AUTH
    _PROXY_NEEDS_AUTH = True


def _proxy_env_override() -> Optional[dict]:
    """Env override for child processes, or None to inherit.

    Returns the credentialed proxy env once _PROXY_NEEDS_AUTH is set;
    otherwise None (children inherit the pinned no-auth env).
    """
    if not (_PROXY_NEEDS_AUTH and _FALLBACK_PROXY_URL):
        return None
    env = dict(os.environ)
    for key in (
        "http_proxy", "https_proxy", "all_proxy",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    ):
        env[key] = _FALLBACK_PROXY_URL
    return env


def _proxy_urlopen(req: urllib.request.Request, timeout: int):
    """Open an HTTPS request through the pinned no-auth proxy.

    Falls back to the credentialed proxy URL once if the proxy demands
    authentication (407) — the no-auth relay may be a misconfiguration
    rather than a promise. Any other failure propagates unchanged.
    """
    if _PROXY_NEEDS_AUTH and _FALLBACK_PROXY_URL:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(
                {"http": _FALLBACK_PROXY_URL, "https": _FALLBACK_PROXY_URL}
            )
        )
        return opener.open(req, timeout=timeout)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler(
            {"http": _STABLE_PROXY_URL, "https": _STABLE_PROXY_URL}
        )
    )
    try:
        return opener.open(req, timeout=timeout)
    except OSError as exc:
        # Proxy CONNECT rejection surfaces as OSError("Tunnel connection
        # failed: 407 ..."), not HTTPError.
        if "407" not in str(exc) or not _FALLBACK_PROXY_URL:
            raise
        _flag_proxy_needs_auth()
    fallback = urllib.request.build_opener(
        urllib.request.ProxyHandler(
            {"http": _FALLBACK_PROXY_URL, "https": _FALLBACK_PROXY_URL}
        )
    )
    return fallback.open(req, timeout=timeout)

API_KEY = os.environ.get("IG_API_KEY", "")
PORT = int(os.environ.get("PORT", "8000"))

MAX_DM_FILE_BYTES = 40 * 1024 * 1024        # 40 MiB — instagram-messages-cli limit
MAX_POST_FILE_BYTES = 100 * 1024 * 1024    # 100 MB — instagram-cli limit
DM_FILE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov"}
POST_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
POST_VIDEO_EXTS = {".mp4", ".mov"}

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def require_api_key(key: Optional[str] = Security(api_key_header)) -> None:
    if not API_KEY or not key or not secrets.compare_digest(key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# --------------------------------------------------------------------------
# CLI helpers
# --------------------------------------------------------------------------

def _detect_account() -> str:
    explicit = os.environ.get("IG_ACCOUNT_ID")
    if explicit:
        return explicit
    proc = subprocess.run(
        ["instagram-cli", "accounts"], capture_output=True, text=True, timeout=30,
        env=_proxy_env_override(),
    )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Could not read instagram-cli accounts output") from exc
    accounts = data.get("accounts") or []
    if not accounts:
        raise RuntimeError("No Instagram account is connected. Run instagram-cli connect-url.")
    return accounts[0]["user_fbid"]


def _check_messages_connected(account_id: str) -> bool:
    try:
        proc = subprocess.run(
            ["instagram-messages-cli", "accounts"],
            capture_output=True, text=True, timeout=30,
            env=_proxy_env_override(),
        )
        data = json.loads(proc.stdout)
        for acct in data.get("accounts") or []:
            if acct.get("user_fbid") == account_id:
                return bool(acct.get("connected"))
    except Exception:
        pass
    return False


try:
    ACCOUNT_ID = _detect_account()
except RuntimeError as exc:
    raise SystemExit(f"Startup failed: {exc}")

MESSAGES_CONNECTED = _check_messages_connected(ACCOUNT_ID)


def run_cli(cli: str, *args: str, timeout: int = 120) -> Any:
    """Run an instagram CLI command and return its parsed JSON output."""
    cmd = [cli, *args, "--account-id", ACCOUNT_ID]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            env=_proxy_env_override(),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"{cli} timed out") from exc
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise HTTPException(status_code=502, detail=f"{cli} failed: {err[:600]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502, detail=f"{cli} returned non-JSON output"
        ) from exc


def _optional_arg(flag: str, value: Optional[Any]) -> List[str]:
    return [flag, str(value)] if value not in (None, "") else []


def save_upload(upload: UploadFile, allowed_exts: set[str], max_bytes: int) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Allowed: {sorted(allowed_exts)}",
        )
    dest = UPLOAD_DIR / f"{secrets.token_hex(8)}{suffix}"
    size = 0
    with dest.open("wb") as fh:
        for chunk in iter(lambda: upload.file.read(1024 * 1024), b""):
            size += len(chunk)
            if size > max_bytes:
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=400, detail=f"File exceeds {max_bytes // (1024*1024)} MB limit"
                )
            fh.write(chunk)
    return dest


# --------------------------------------------------------------------------
# DM live updates: background inbox poller + cursor/long-poll endpoint
#
# The Mac should NOT poll /dms/inbox directly on a tight loop — every call
# hits Instagram. Instead this service polls the inbox itself every
# DM_POLL_SECONDS (env, default 180, minimum 60) and the Mac long-polls the
# cheap local GET /dms/updates endpoint below.
# --------------------------------------------------------------------------

DM_POLL_SECONDS = max(60, int(os.environ.get("DM_POLL_SECONDS", "180")))
DM_MAX_MESSAGES = 300

_dm_lock = threading.Lock()
_dm_snapshot = {
    "checked_at": None,   # ISO8601 UTC of the last successful Instagram poll
    "messages": [],       # newest-first normalized messages
    "last_cycle_ids": [], # message_ids first seen in the latest poll cycle
    "failures": 0,        # consecutive poll failures
}


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _msg_sent_at(msg: dict) -> Optional[str]:
    """ISO8601 UTC sent time for a raw inbox message, or None."""
    sent = msg.get("message_sent_at") or {}
    if sent.get("utc"):
        return sent["utc"]
    try:
        ts = int(msg.get("timestamp"))
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    except (TypeError, ValueError):
        return None


def _normalize_dm(thread: dict, msg: dict) -> dict:
    content = msg.get("content")
    text: str = ""
    share_url: Optional[str] = None
    if isinstance(content, str):
        text = content
    elif isinstance(content, dict):
        xma = content.get("xma") or {}
        share_url = xma.get("target_url")
        text = content.get("text_body") or content.get("xma_text_body") or ""
        if not text:
            frags = content.get("text_fragments") or []
            text = "".join(
                (f.get("plaintext") or "") for f in frags if isinstance(f, dict)
            )
    return {
        "thread_fbid": thread.get("thread_fbid"),
        "thread_title": thread.get("thread_title"),
        "message_id": msg.get("message_id"),
        "sender_fbid": msg.get("sender_fbid"),
        "sent_at": _msg_sent_at(msg),
        "content_type": msg.get("content_type"),
        "text": text[:500] if isinstance(text, str) else "",
        "share_url": share_url,
    }


def _dm_state_path() -> "Path":
    return AGENT_MSGS_DIR / "dm_poll.json"


def _persist_dm_snapshot() -> None:
    try:
        with _dm_lock:
            payload = {
                "checked_at": _dm_snapshot["checked_at"],
                "messages": _dm_snapshot["messages"],
                "last_cycle_ids": _dm_snapshot["last_cycle_ids"],
            }
        path = _dm_state_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload))
        tmp.replace(path)
    except OSError:
        pass


def _load_dm_snapshot() -> None:
    try:
        data = json.loads(_dm_state_path().read_text())
    except (OSError, json.JSONDecodeError):
        return
    with _dm_lock:
        _dm_snapshot["checked_at"] = data.get("checked_at")
        _dm_snapshot["messages"] = data.get("messages") or []
        _dm_snapshot["last_cycle_ids"] = data.get("last_cycle_ids") or []


def _dm_sort_key(m: dict) -> float:
    dt = _parse_iso(m.get("sent_at"))
    return dt.timestamp() if dt else 0.0


def _dm_poller_loop() -> None:
    """Poll Instagram inbox forever; the endpoint serves the cached snapshot."""
    failures = 0
    while True:
        try:
            data = run_cli(
                "instagram-messages-cli", "inbox",
                "--folder", "inbox", "--first", "20", "--message-count", "20",
                timeout=90,
            )
            with _dm_lock:
                known = {m.get("message_id") for m in _dm_snapshot["messages"]}
            # Re-normalize every fetched message each cycle, not just new
            # ones: a normalization fix must heal already-cached entries
            # instead of leaving them stale until they age out.
            norm_by_id: dict = {}
            new_ids: List[str] = []
            for thread in data.get("threads") or []:
                for msg in thread.get("messages") or []:
                    norm = _normalize_dm(thread, msg)
                    mid = norm.get("message_id")
                    if not mid:
                        continue
                    norm_by_id[mid] = norm
                    if mid not in known:
                        known.add(mid)
                        new_ids.append(mid)
            with _dm_lock:
                merged = list(norm_by_id.values()) + [
                    m for m in _dm_snapshot["messages"]
                    if m.get("message_id") not in norm_by_id
                ]
                # Newest-first so the cap below always drops the oldest, and
                # burst messages stay in chronological order for consumers.
                merged.sort(key=_dm_sort_key, reverse=True)
                _dm_snapshot["messages"] = merged[:DM_MAX_MESSAGES]
                _dm_snapshot["last_cycle_ids"] = new_ids
                _dm_snapshot["checked_at"] = _utcnow()
                _dm_snapshot["failures"] = 0
            _persist_dm_snapshot()
            failures = 0
            time.sleep(DM_POLL_SECONDS)
        except Exception as exc:  # keep serving the last good snapshot
            failures += 1
            with _dm_lock:
                _dm_snapshot["failures"] = failures
            print(f"[dm-poller] poll failed ({failures} consecutive): {exc}", flush=True)
            time.sleep(min(DM_POLL_SECONDS * (2 ** min(failures, 3)), 900))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_dm_snapshot()
    threading.Thread(target=_dm_poller_loop, name="dm-poller", daemon=True).start()
    yield


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = FastAPI(
    title="Instagram API",
    description=(
        "REST API for your connected Instagram account: DMs, posts, and reels. "
        "Send `X-API-Key` header with every request except /health."
    ),
    version="1.6.7",
    lifespan=lifespan,
)


@app.get("/health", tags=["health"])
def health() -> dict:
    with _dm_lock:
        poller = {
            "checked_at": _dm_snapshot.get("checked_at"),
            "failures": _dm_snapshot.get("failures", 0),
            "cached_messages": len(_dm_snapshot.get("messages", [])),
        }
    return {
        "ok": True,
        "account_id": ACCOUNT_ID,
        "messages_connected": MESSAGES_CONNECTED,
        "dm_poller": poller,
    }


@app.get("/accounts", tags=["health"], dependencies=[Depends(require_api_key)])
def accounts() -> Any:
    proc = subprocess.run(
        ["instagram-cli", "accounts"], capture_output=True, text=True, timeout=30,
        env=_proxy_env_override(),
    )
    return json.loads(proc.stdout)


# --------------------------------------------------------------------------
# DMs
# --------------------------------------------------------------------------

class SendMessageRequest(BaseModel):
    thread_fbid: Optional[str] = None
    recipient_user_fbids: Optional[List[str]] = None
    text: Optional[str] = None
    media_fbid: Optional[str] = None
    reply_to_message_id: Optional[str] = None

    @model_validator(mode="after")
    def _validate(self) -> "SendMessageRequest":
        if bool(self.thread_fbid) == bool(self.recipient_user_fbids):
            raise ValueError("Provide exactly one of thread_fbid or recipient_user_fbids")
        if not self.text and not self.media_fbid:
            raise ValueError("Provide at least one of text or media_fbid")
        return self


def _dm_args(req: SendMessageRequest) -> List[str]:
    args: List[str] = []
    if req.thread_fbid:
        args += ["--thread-fbid", req.thread_fbid]
    else:
        args += ["--recipient-user-fbids", ",".join(req.recipient_user_fbids or [])]
    if req.text:
        args += ["--text", req.text]
    if req.media_fbid:
        args += ["--media-fbid", req.media_fbid]
    if req.reply_to_message_id:
        args += ["--reply-to-message-id", req.reply_to_message_id]
    return args


@app.get("/dms/inbox", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_inbox(
    folder: str = Query("inbox", pattern="^(inbox|pending|spam)$"),
    first: int = Query(20, ge=1, le=100),
    message_count: int = Query(3, ge=0, le=25),
    after: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-messages-cli", "inbox",
        "--folder", folder, "--first", str(first),
        "--message-count", str(message_count),
        *_optional_arg("--after", after),
    )


@app.get("/dms/inbox/filtered", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_filtered_inbox(
    filter: str = Query(
        ..., pattern="^(unread|unanswered|starred|groups|verified|followers|creators|other-participant-followers100k-plus)$"
    ),
    thread_limit: int = Query(10, ge=1, le=100),
    message_count: int = Query(3, ge=0, le=25),
    folder: str = Query("inbox", pattern="^(inbox|pending|spam)$"),
) -> Any:
    """Filtered inbox views. Requires a professional (creator/business) account."""
    return run_cli(
        "instagram-messages-cli", "filtered-inbox",
        "--selected-filter", filter,
        "--thread-limit", str(thread_limit),
        "--message-count", str(message_count),
        "--folder", folder,
    )


@app.get("/dms/threads/{thread_fbid}", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_thread(
    thread_fbid: str,
    first: int = Query(20, ge=1, le=100),
    after: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-messages-cli", "thread",
        "--thread-fbid", thread_fbid, "--first", str(first),
        *_optional_arg("--after", after),
    )


@app.get("/dms/top-recipients", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_top_recipients(
    count: int = Query(10, ge=1, le=100),
    page_max_id: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-messages-cli", "top-recipients",
        "--count", str(count),
        *_optional_arg("--page-max-id", page_max_id),
    )


@app.get("/dms/search", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_search(
    keyword: Optional[str] = None,
    contact: Optional[str] = None,
    start_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    max_results: int = Query(20, ge=1, le=100),
) -> Any:
    if bool(keyword) == bool(contact):
        raise HTTPException(
            status_code=400, detail="Provide exactly one of keyword or contact"
        )
    args = ["--max-results", str(max_results)] + _optional_arg(
        "--start-date", start_date
    ) + _optional_arg("--end-date", end_date)
    if keyword:
        return run_cli("instagram-messages-cli", "keyword-search",
                       "--query-text", keyword, *args)
    return run_cli("instagram-messages-cli", "contact-search",
                   "--query-text", contact, *args)


@app.get("/dms/temporal", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_temporal(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    max_results: int = Query(15, ge=1, le=100),
) -> Any:
    return run_cli(
        "instagram-messages-cli", "temporal-search",
        "--start-date", start_date, "--end-date", end_date,
        "--max-results", str(max_results),
    )


@app.post("/dms/send", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_send(req: SendMessageRequest) -> Any:
    """Send a text/media DM. Delivers a real message — use deliberately."""
    return run_cli("instagram-messages-cli", "send", *_dm_args(req), timeout=180)


@app.post("/dms/send-file", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_send_file(
    file: UploadFile = File(...),
    thread_fbid: Optional[str] = Form(None),
    recipient_user_fbids: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    reply_to_message_id: Optional[str] = Form(None),
) -> Any:
    """Send a DM with an attached file (JPEG/PNG/WebP/GIF/MP4/MOV, up to 40 MB)."""
    path = save_upload(file, DM_FILE_EXTS, MAX_DM_FILE_BYTES)
    args: List[str] = []
    if bool(thread_fbid) == bool(recipient_user_fbids):
        raise HTTPException(
            status_code=400, detail="Provide exactly one of thread_fbid or recipient_user_fbids"
        )
    if thread_fbid:
        args += ["--thread-fbid", thread_fbid]
    else:
        args += ["--recipient-user-fbids", recipient_user_fbids]
    if text:
        args += ["--text", text]
    if reply_to_message_id:
        args += ["--reply-to-message-id", reply_to_message_id]
    args += ["--file", str(path)]
    try:
        return run_cli("instagram-messages-cli", "send", *args, timeout=300)
    finally:
        path.unlink(missing_ok=True)


class ReactRequest(BaseModel):
    thread_fbid: str
    message_id: str
    emoji: str


@app.post("/dms/react", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_react(req: ReactRequest) -> Any:
    """Add an emoji reaction to a DM message (message_id looks like 'mid.$...').

    The reaction is visible to the other person — use deliberately.
    Endpoint is new and has not been live-tested against Instagram yet.
    """
    if not req.emoji.strip():
        raise HTTPException(status_code=400, detail="emoji must not be empty")
    return run_cli(
        "instagram-messages-cli", "react",
        "--thread-fbid", req.thread_fbid,
        "--message-id", req.message_id,
        "--emoji", req.emoji,
    )


# --------------------------------------------------------------------------
# Outbound queue (POST /dms/react/queue, POST /dms/send/queue, GET /dms/queue)
#
# Enqueue-only endpoints: they validate and append to
# agent_msgs/outbound_queue.json, then return immediately. No CLI call happens
# here, so enqueueing never triggers an approval card and never blocks.
# A scheduled task (`outbound-queue-sender`, every 30s) drains the queue by
# running drain_outbound_queue.py, which invokes the CLIs directly; that task
# carries the standing Allow for sending.
#
# Narrowing: queued reactions are limited to the Curated emoji set and to the
# threads in REACT_QUEUE_THREADS (comma-separated thread_fbids in .env).
# Queued sends are text-only DMs to a thread (no attachments in v1).

REACT_QUEUE_EMOJI = {"❤️", "😍", "🤤", "🔥", "👏", "💡", "😂", "😮", "👍"}
REACT_QUEUE_THREADS = {
    t.strip()
    for t in os.environ.get("REACT_QUEUE_THREADS", "").split(",")
    if t.strip()
}
OUTBOUND_QUEUE_MAX = 200


def _outbound_queue_path() -> Path:
    return AGENT_MSGS_DIR / "outbound_queue.json"


def _queue_modify(fn) -> Any:
    """Run fn(items) -> result under an exclusive lock on the queue file."""
    import fcntl

    path = _outbound_queue_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.seek(0)
            raw = fh.read()
            try:
                items = json.loads(raw) if raw.strip() else []
            except json.JSONDecodeError:
                items = []
            if not isinstance(items, list):
                items = []
            result = fn(items)
            if len(items) > OUTBOUND_QUEUE_MAX:
                items = items[-OUTBOUND_QUEUE_MAX:]
            fh.seek(0)
            fh.truncate()
            fh.write(json.dumps(items))
            return result
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _queue_read() -> List[dict]:
    import fcntl

    path = _outbound_queue_path()
    if not path.exists():
        return []
    with open(path, "r") as fh:
        fcntl.flock(fh, fcntl.LOCK_SH)
        try:
            items = json.loads(fh.read() or "[]")
        except json.JSONDecodeError:
            return []
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    return items if isinstance(items, list) else []


class SendQueueRequest(BaseModel):
    thread_fbid: str
    text: str
    reply_to_message_id: Optional[str] = None


@app.post("/dms/react/queue", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_react_queue(req: ReactRequest) -> dict:
    """Queue an emoji reaction for the outbound-queue-sender task.

    Returns immediately with the queue id — no approval card, no blocking.
    Limited to the Curated emoji set and REACT_QUEUE_THREADS. Re-queueing an
    identical pending reaction returns the existing entry (no duplicates).
    """
    if req.emoji not in REACT_QUEUE_EMOJI:
        raise HTTPException(
            status_code=400,
            detail=f"emoji not in the allowed set: {sorted(REACT_QUEUE_EMOJI)}",
        )
    if REACT_QUEUE_THREADS and req.thread_fbid not in REACT_QUEUE_THREADS:
        raise HTTPException(
            status_code=403, detail="thread not allowed for queued reactions"
        )
    if not req.message_id.strip():
        raise HTTPException(status_code=400, detail="message_id must not be empty")

    def _append(items: List[dict]) -> dict:
        for it in items:
            if (
                it.get("status") == "queued"
                and it.get("type") == "react"
                and it.get("thread_fbid") == req.thread_fbid
                and it.get("message_id") == req.message_id
                and it.get("emoji") == req.emoji
            ):
                return {"queued": True, "duplicate": True, **it}
        item = {
            "id": secrets.token_hex(8),
            "type": "react",
            "thread_fbid": req.thread_fbid,
            "message_id": req.message_id,
            "emoji": req.emoji,
            "status": "queued",
            "queued_at": time.time(),
        }
        items.append(item)
        return {"queued": True, "duplicate": False, **item}

    return _queue_modify(_append)


@app.post("/dms/send/queue", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_send_queue(req: SendQueueRequest) -> dict:
    """Queue a text DM for the outbound-queue-sender task.

    Returns immediately with the queue id — no approval card, no blocking.
    Text-only (no attachments in v1), 1000 chars max.
    Optional reply_to_message_id (a mid.$… id) sends it as a quoted reply.
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")
    if len(text) > 1000:
        raise HTTPException(
            status_code=400, detail="text exceeds 1000 characters"
        )
    if not (req.thread_fbid or "").strip():
        raise HTTPException(status_code=400, detail="thread_fbid must not be empty")
    reply_to = (req.reply_to_message_id or "").strip() or None

    def _append(items: List[dict]) -> dict:
        item = {
            "id": secrets.token_hex(8),
            "type": "send",
            "thread_fbid": req.thread_fbid,
            "text": text,
            "status": "queued",
            "queued_at": time.time(),
        }
        if reply_to:
            item["reply_to_message_id"] = reply_to
        items.append(item)
        return {"queued": True, **item}

    return _queue_modify(_append)


@app.get("/dms/queue", tags=["dms"], dependencies=[Depends(require_api_key)])
def dm_queue() -> dict:
    """Outbound queue status: queued / sent / failed items with timestamps."""
    items = _queue_read()
    return {"count": len(items), "items": items}


@app.get("/dms/updates", tags=["dms"], dependencies=[Depends(require_api_key)])
async def dm_updates(
    since: Optional[str] = Query(
        None, description="ISO8601 timestamp; return messages sent strictly after it"
    ),
    wait: int = Query(
        0, ge=0, le=120,
        description="Long-poll up to this many seconds for new messages",
    ),
) -> dict:
    """New-message event feed — poll this instead of /dms/inbox.

    A background thread polls the Instagram inbox every DM_POLL_SECONDS
    (default 180s); this endpoint serves the cached snapshot, so Mac-side
    polling is free. Recommended loop:

        GET /dms/updates?since=<last_seen_sent_at>&wait=45

    Pass back the newest message's `sent_at` as `since` on the next call.
    If `since` is omitted and `wait` is 0, returns the messages from the most
    recent poll cycle. With `wait` > 0 and no `since`, waits for messages
    arriving after the request time.
    """
    since_dt = _parse_iso(since)
    deadline = time.time() + wait
    while True:
        with _dm_lock:
            messages = list(_dm_snapshot["messages"])
            last_cycle = set(_dm_snapshot["last_cycle_ids"])
            checked_at = _dm_snapshot["checked_at"]
            failures = _dm_snapshot["failures"]
        if since_dt is not None or wait > 0:
            cutoff = since_dt or datetime.now(timezone.utc)
            new = [
                m for m in messages
                if (dt := _parse_iso(m.get("sent_at"))) is not None and dt > cutoff
            ]
        else:
            new = [m for m in messages if m.get("message_id") in last_cycle]
        if new or time.time() >= deadline:
            _touch_mac_seen()
            return {
                "messages": new,
                "count": len(new),
                "checked_at": checked_at,
                "poll_interval_s": DM_POLL_SECONDS,
                "poller_failures": failures,
                "warming_up": checked_at is None,
            }
        await asyncio.sleep(2)


# --------------------------------------------------------------------------
# Posts & reels
# --------------------------------------------------------------------------

POST_TYPES = {"POST", "REEL", "STORY", "HIGHLIGHT"}


def _post_type_args(post_types: Optional[str]) -> List[str]:
    if not post_types:
        return []
    types = [t.strip().upper() for t in post_types.split(",") if t.strip()]
    bad = [t for t in types if t not in POST_TYPES]
    if bad:
        raise HTTPException(
            status_code=400, detail=f"Invalid post_types {bad}. Use: {sorted(POST_TYPES)}"
        )
    return ["--post-types", ",".join(types)]


# --- Share-URL resolution via Instagram oEmbed --------------------------------

OEMBED_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
OEMBED_CACHE_TTL = 24 * 3600


def _parse_share_url(url: str) -> tuple:
    """Return (kind, shortcode) for an instagram.com /p/ or /reel(s)/ URL."""
    try:
        parts = urllib.parse.urlparse(url.strip())
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid URL") from exc
    if parts.netloc.lower().removeprefix("www.") != "instagram.com":
        raise HTTPException(
            status_code=400, detail="URL must be an instagram.com link"
        )
    m = re.match(r"^/(p|reel|reels)/([A-Za-z0-9_-]+)/?", parts.path or "")
    if not m:
        raise HTTPException(
            status_code=400, detail="URL must be a /p/<code>/ or /reel/<code>/ post link"
        )
    kind = "reel" if m.group(1).startswith("reel") else "p"
    return kind, m.group(2)


def _oembed_cache_path() -> Path:
    return AGENT_MSGS_DIR / "oembed_cache.json"


def _oembed_cache_get(shortcode: str) -> Optional[dict]:
    try:
        cache = json.loads(_oembed_cache_path().read_text())
    except (OSError, json.JSONDecodeError):
        return None
    entry = cache.get(shortcode)
    if not isinstance(entry, dict):
        return None
    try:
        fresh = time.time() - entry["fetched_at"] < OEMBED_CACHE_TTL
    except (KeyError, TypeError):
        return None
    return entry.get("data") if fresh else None


def _oembed_cache_set(shortcode: str, data: dict) -> None:
    path = _oembed_cache_path()
    try:
        cache = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, json.JSONDecodeError):
        cache = {}
    if not isinstance(cache, dict):
        cache = {}
    cache[shortcode] = {"fetched_at": time.time(), "data": data}
    if len(cache) > 500:
        for key in sorted(cache, key=lambda k: cache[k].get("fetched_at", 0))[
            : len(cache) - 500
        ]:
            del cache[key]
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(path)
    except OSError:
        pass


@app.get("/profile", tags=["posts"], dependencies=[Depends(require_api_key)])
def profile() -> Any:
    return run_cli("instagram-cli", "profile")


@app.get("/posts", tags=["posts"], dependencies=[Depends(require_api_key)])
def list_posts(
    username: Optional[str] = None,
    limit: int = Query(25, ge=1, le=100),
    post_types: Optional[str] = Query(None, description="Comma-separated: POST,REEL,STORY,HIGHLIGHT"),
    since: Optional[str] = Query(None, description="YYYY-MM-DD"),
    until: Optional[str] = Query(None, description="YYYY-MM-DD"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
    after: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-cli", "posts",
        *_optional_arg("--username", username),
        "--limit", str(limit),
        *_post_type_args(post_types),
        *_optional_arg("--since", since),
        *_optional_arg("--until", until),
        "--sort-order", sort_order,
        *_optional_arg("--after", after),
    )


@app.get("/reels", tags=["reels"], dependencies=[Depends(require_api_key)])
def list_reels(
    limit: int = Query(25, ge=1, le=100),
    since: Optional[str] = Query(None, description="YYYY-MM-DD"),
    until: Optional[str] = Query(None, description="YYYY-MM-DD"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
    after: Optional[str] = None,
) -> Any:
    """Convenience view of your reels (posts with type REEL)."""
    return run_cli(
        "instagram-cli", "posts",
        "--limit", str(limit),
        "--post-types", "REEL",
        *_optional_arg("--since", since),
        *_optional_arg("--until", until),
        "--sort-order", sort_order,
        *_optional_arg("--after", after),
    )


def _resolve_post_oembed(kind: str, shortcode: str) -> tuple:
    """Resolve a share shortcode via Instagram's public oEmbed endpoint.

    Returns (post_dict, cached). This is the only Instagram call the
    analysis path makes. Raises HTTPException(404/502) on failure.
    """
    cached = _oembed_cache_get(shortcode)
    if cached is not None:
        return dict(cached), True
    target = f"https://www.instagram.com/{kind}/{shortcode}/"
    oembed_url = "https://www.instagram.com/api/v1/oembed/?url=" + urllib.parse.quote(
        target, safe=""
    )
    req = urllib.request.Request(
        oembed_url,
        headers={"User-Agent": OEMBED_UA, "Accept": "application/json"},
    )
    # One retry on rate-limit/transient errors: the sandbox shares an egress
    # IP, so a 429 is possible under load. 404 is final (deleted/private).
    data = None
    for attempt in range(2):
        try:
            with _proxy_urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise HTTPException(
                    status_code=404,
                    detail="Instagram could not resolve this URL (deleted or private post?)",
                ) from exc
            if exc.code not in (429, 500, 502, 503) or attempt == 1:
                raise HTTPException(
                    status_code=502, detail=f"Instagram oEmbed failed: HTTP {exc.code}"
                ) from exc
            time.sleep(3)
        except Exception as exc:
            if attempt == 1:
                raise HTTPException(
                    status_code=502, detail=f"Instagram oEmbed failed: {exc}"
                ) from exc
            time.sleep(3)
    assert data is not None  # loop either breaks with data or raises
    author_id = data.get("author_id")
    result = {
        "source": "oembed",
        "shortcode": shortcode,
        "url": target,
        "media_id": data.get("media_id"),
        "caption": data.get("title"),
        "author_username": data.get("author_name"),
        "author_url": data.get("author_url"),
        "author_id": str(author_id) if author_id is not None else None,
        "thumbnail_url": data.get("thumbnail_url"),
        "thumbnail_width": data.get("thumbnail_width"),
        "thumbnail_height": data.get("thumbnail_height"),
        "embed_html": data.get("html"),
    }
    _oembed_cache_set(shortcode, result)
    return result, False


@app.get("/posts/by-url", tags=["posts"], dependencies=[Depends(require_api_key)])
def get_post_by_url(
    url: str = Query(..., description="Instagram /p/<code>/ or /reel/<code>/ share URL"),
) -> dict:
    """Resolve a share URL to post metadata via Instagram's public oEmbed endpoint.

    Use this for /p/ or /reel/ links from DMs — the provider's media-ID lookup
    cannot resolve those (separate ID spaces). Returns caption, author,
    thumbnail, classic media_id, and embed HTML. No login required.
    Results are cached 24h per shortcode.
    """
    kind, shortcode = _parse_share_url(url)
    post, cached = _resolve_post_oembed(kind, shortcode)
    return {**post, "cached": cached}


# --------------------------------------------------------------------------
# Direct video URLs (GET /posts/video)
#
# Resolves a share URL to a short-lived MP4 CDN URL via yt-dlp (no login).
# Extraction logic adapted from the camila-feed-watcher resolver. Intended
# for occasional use (a few lookups a day) — not tight loops. yt-dlp must be
# installed for the system python3 (pip install yt-dlp); the API venv itself
# does not need it.
#
# NOTE: this route is registered before /posts/{media_id} so that "video"
# is not captured as a media_id.

VIDEO_CACHE_TTL = 6 * 3600   # 6h; CDN URLs expire, so the TTL is deliberately short
VIDEO_CACHE_MAX = 200


def _video_cache_path() -> Path:
    return AGENT_MSGS_DIR / "video_cache.json"


def _video_cache_get_entry(shortcode: str) -> Optional[dict]:
    """Fresh cached video entry: {"video_url", "vcodec", "acodec"} or None."""
    try:
        cache = json.loads(_video_cache_path().read_text())
    except (OSError, json.JSONDecodeError):
        return None
    entry = cache.get(shortcode)
    if not isinstance(entry, dict):
        return None
    try:
        fresh = time.time() - entry["fetched_at"] < VIDEO_CACHE_TTL
    except (KeyError, TypeError):
        return None
    if not (fresh and entry.get("video_url")):
        return None
    return {
        "video_url": entry["video_url"],
        "vcodec": entry.get("vcodec"),
        "acodec": entry.get("acodec"),
    }


def _video_cache_set(
    shortcode: str,
    video_url: str,
    vcodec: Optional[str] = None,
    acodec: Optional[str] = None,
) -> None:
    path = _video_cache_path()
    try:
        cache = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, json.JSONDecodeError):
        cache = {}
    if not isinstance(cache, dict):
        cache = {}
    cache[shortcode] = {
        "fetched_at": time.time(),
        "video_url": video_url,
        "vcodec": vcodec,
        "acodec": acodec,
    }
    if len(cache) > VIDEO_CACHE_MAX:
        for key in sorted(cache, key=lambda k: cache[k].get("fetched_at", 0))[
            : len(cache) - VIDEO_CACHE_MAX
        ]:
            del cache[key]
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(path)
    except OSError:
        pass


def _probe_streams(cdn_url: str) -> Optional[tuple]:
    """(vcodec, acodec) for a CDN URL via ffprobe, or None.

    Downloads only enough of the file to read its stream headers.
    Returns None on timeout/network failure or when probing fails.
    """
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error",
             "-show_entries", "stream=codec_name,codec_type",
             "-of", "csv=p=0", cdn_url],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    vcodec = acodec = None
    for line in (proc.stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 2:
            continue
        name, ctype = parts
        if ctype == "video" and vcodec is None:
            vcodec = name
        elif ctype == "audio" and acodec is None:
            acodec = name
    if vcodec is None:
        return None
    return (vcodec, acodec)


def _extract_video_url(page_url: str) -> Optional[dict]:
    """Best progressive MP4 URL with audio via yt-dlp.

    Returns {"url", "vcodec", "acodec", "source"}, or None when no format
    carries both video and audio. Selection:
      1. yt-dlp formats with audio (acodec not none/missing) and H.264
         video (vcodec starting avc1/h264), highest tbr first;
      2. Instagram's progressive video_versions entries (highest type
         first) — muxed H.264+AAC MP4s that yt-dlp reports without codec
         metadata, so the probe below verifies them;
      3. any yt-dlp format with both video and audio, highest tbr.
    Every candidate is ffprobe-verified to actually contain video and
    audio streams before being returned — a video-only stream is never
    served. Returns None (the callers 422) rather than a silent file.
    Raises HTTPException(504/502) when extraction itself fails.
    """
    try:
        proc = subprocess.run(
            ["python3", "-m", "yt_dlp",
             "--no-playlist", "--skip-download", "--dump-json", "--no-warnings",
             # Sandbox egress MITMs TLS; yt-dlp otherwise pins certifi's
             # bundle, which lacks Hatch's CA.
             "--compat-options", "no-certifi",
             "--socket-timeout", "30", page_url],
            capture_output=True, text=True, timeout=150,
            env=_proxy_env_override(),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Video extraction timed out") from exc
    if proc.returncode != 0:
        err = (proc.stderr or "").strip().splitlines()
        detail = err[-1][:200] if err else f"yt-dlp exit {proc.returncode}"
        raise HTTPException(status_code=502, detail=f"Video extraction failed: {detail}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502, detail="Video extraction returned bad JSON"
        ) from exc
    def _is_mp4(f: dict) -> bool:
        return "mp4" in (f.get("url") or "") or f.get("ext") == "mp4"

    def _has_av(f: dict) -> bool:
        return f.get("vcodec") not in (None, "none") and f.get("acodec") not in (
            None,
            "none",
        )

    def _is_h264(f: dict) -> bool:
        vc = (f.get("vcodec") or "").lower()
        return vc.startswith("avc1") or vc.startswith("h264")

    def _by_tbr(candidates: list) -> list:
        return sorted(candidates, key=lambda f: f.get("tbr") or 0, reverse=True)

    def _verified(url: str) -> Optional[tuple]:
        probe = _probe_streams(url)
        if probe and probe[0] and probe[1]:
            return probe
        return None

    formats = data.get("formats") or []
    with_av = [
        f for f in formats if _has_av(f) and _is_mp4(f) and f.get("url")
    ]

    # 1. H.264 + audio, highest bitrate first.
    for f in _by_tbr([x for x in with_av if _is_h264(x)]):
        probe = _verified(f["url"])
        if probe:
            return {
                "url": f["url"],
                "vcodec": probe[0],
                "acodec": probe[1],
                "source": "yt-dlp",
            }

    # 2. Instagram's progressive video_versions (muxed H.264+AAC MP4s).
    try:
        media = _extract_post_json(page_url)
    except HTTPException:
        media = None
    vv = (media or {}).get("video_versions") or []
    for v in sorted(vv, key=lambda x: int(x.get("type") or 0), reverse=True):
        vurl = v.get("url")
        if not vurl:
            continue
        probe = _verified(vurl)
        if probe:
            return {
                "url": vurl,
                "vcodec": probe[0],
                "acodec": probe[1],
                "source": "video_versions",
            }

    # 3. Any format with both video and audio.
    for f in _by_tbr(with_av):
        probe = _verified(f["url"])
        if probe:
            return {
                "url": f["url"],
                "vcodec": probe[0],
                "acodec": probe[1],
                "source": "yt-dlp",
            }
    return None


@app.get("/posts/video", tags=["posts"], dependencies=[Depends(require_api_key)])
def get_post_video(
    url: str = Query(..., description="Instagram /p/<code>/ or /reel/<code>/ share URL"),
) -> dict:
    """Direct MP4 URL for a shared reel/video post, via yt-dlp (no login).

    Selection prefers a progressive MP4 with H.264 video + audio (highest
    bitrate), then any MP4 with video + audio. A video-only stream is never
    returned — the endpoint 422s when nothing with audio is available.

    Returns a short-lived CDN URL — download it promptly; re-request if it
    expires. Results are cached 6h per shortcode (the TTL is short because
    CDN URLs expire). Intended for occasional use (a few lookups a day),
    not tight loops.
    """
    kind, shortcode = _parse_share_url(url)
    target = f"https://www.instagram.com/{kind}/{shortcode}/"
    cached = _video_cache_get_entry(shortcode)
    if cached is not None:
        return {
            "shortcode": shortcode,
            "url": target,
            "video_url": cached["video_url"],
            "vcodec": cached.get("vcodec"),
            "acodec": cached.get("acodec"),
            "cached": True,
        }
    result = _extract_video_url(target)
    if not result:
        raise HTTPException(
            status_code=422,
            detail="No playable video found (photo post, no audio track, or Instagram withheld it)",
        )
    _video_cache_set(
        shortcode, result["url"], result.get("vcodec"), result.get("acodec")
    )
    return {
        "shortcode": shortcode,
        "url": target,
        "video_url": result["url"],
        "vcodec": result.get("vcodec"),
        "acodec": result.get("acodec"),
        "cached": False,
    }


# --------------------------------------------------------------------------
# Carousel / photo image URLs (GET /posts/images)
#
# yt-dlp resolves reels to video but ignores photo entries. The same logged-out
# GraphQL post query it uses (PolarisLoggedOutDesktopWWWPostRootContentQuery)
# returns every carousel child with full image_versions2 data, so
# extract_post_json.py reuses yt-dlp's extractor machinery to capture the raw
# product_info and we pick the largest image per entry here. Intended for
# occasional use (a few lookups a day) — not tight loops.
#
# NOTE: this route is registered before /posts/{media_id} so that "images"
# is not captured as a media_id.

IMAGE_CACHE_TTL = 6 * 3600   # 6h; CDN URLs are signed and expire
IMAGE_CACHE_MAX = 200


def _image_cache_path() -> Path:
    return AGENT_MSGS_DIR / "image_cache.json"


def _json_cache_get(path: Path, key: str, ttl: int) -> Optional[Any]:
    try:
        cache = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    entry = cache.get(key)
    if not isinstance(entry, dict):
        return None
    try:
        fresh = time.time() - entry["fetched_at"] < ttl
    except (KeyError, TypeError):
        return None
    value = entry.get("value")
    return value if fresh else None


def _json_cache_set(path: Path, key: str, value: Any, max_entries: int) -> None:
    try:
        cache = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, json.JSONDecodeError):
        cache = {}
    if not isinstance(cache, dict):
        cache = {}
    cache[key] = {"fetched_at": time.time(), "value": value}
    if len(cache) > max_entries:
        for old in sorted(cache, key=lambda k: cache[k].get("fetched_at", 0))[
            : len(cache) - max_entries
        ]:
            del cache[old]
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(path)
    except OSError:
        pass


def _extract_post_json(page_url: str) -> dict:
    """Raw logged-out post JSON via yt-dlp's extractor internals.

    Raises HTTPException(504/502) when extraction itself fails.
    """
    try:
        proc = subprocess.run(
            ["python3", str(BASE_DIR / "extract_post_json.py"), page_url],
            capture_output=True,
            text=True,
            timeout=240,
            env=_proxy_env_override(),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=504, detail="Post lookup timed out"
        ) from exc
    if proc.returncode != 0:
        err = (proc.stderr or "").strip().splitlines()
        detail = err[-1][:200] if err else "post lookup failed"
        raise HTTPException(
            status_code=502, detail=f"Post lookup failed: {detail}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502, detail="Post lookup returned bad JSON"
        ) from exc


def _largest_image(media: dict) -> Optional[dict]:
    """Largest image candidate for a photo media dict.

    Returns {"url", "width", "height"} or None. Candidate size is read from
    the stp query param (s{width}x{height}); the candidate without a size
    marker is the full-size original.
    """
    ow, oh = media.get("original_width"), media.get("original_height")
    best: Optional[dict] = None
    best_area = 0
    candidates = (media.get("image_versions2") or {}).get("candidates") or []
    for cand in candidates:
        url = cand.get("url")
        if not url:
            continue
        stp = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get(
            "stp", [""]
        )[0]
        m = re.search(r"s(\d+)x(\d+)", stp)
        if m:
            w, h = int(m.group(1)), int(m.group(2))
        else:
            w, h = ow, oh
        area = (w or 0) * (h or 0)
        if area > best_area:
            best = {"url": url, "width": w, "height": h}
            best_area = area
    if best:
        return best
    fallback = media.get("display_uri")
    if fallback:
        return {"url": fallback, "width": ow, "height": oh}
    return None


@app.get("/posts/images", tags=["posts"], dependencies=[Depends(require_api_key)])
def get_post_images(
    url: str = Query(..., description="Instagram /p/<code>/ or /reel/<code>/ share URL"),
) -> dict:
    """Every image for a shared post / carousel / reel, largest CDN URLs.

    Carousel entries come back in order; a single-photo post returns one
    item; a reel returns one video item (same URL the /posts/video endpoint
    would give). Image and video CDN URLs are short-lived — download them
    promptly and re-request if they go stale. Results are cached 6h per
    shortcode. Intended for occasional use (a few lookups a day), not tight
    loops.
    """
    kind, shortcode = _parse_share_url(url)
    target = f"https://www.instagram.com/{kind}/{shortcode}/"
    cached = _json_cache_get(_image_cache_path(), shortcode, IMAGE_CACHE_TTL)
    if cached is not None:
        return {
            "shortcode": shortcode,
            "url": target,
            "cached": True,
            "items": cached,
        }
    media = _extract_post_json(target)
    children = media.get("carousel_media") or []
    entries = children if children else [media]
    items: List[dict] = []
    for entry in entries:
        if entry.get("media_type") == 2:  # video: reel or video carousel item
            code = entry.get("code") or shortcode
            video = _video_cache_get_entry(code)
            if video is None:
                try:
                    extracted = _extract_video_url(
                        f"https://www.instagram.com/p/{code}/"
                    )
                except HTTPException:
                    # yt-dlp failed outright (e.g. no video formats found):
                    # fall back to the still image below rather than failing
                    # the whole carousel on one bad child.
                    extracted = None
                if extracted:
                    _video_cache_set(
                        code,
                        extracted["url"],
                        extracted.get("vcodec"),
                        extracted.get("acodec"),
                    )
                    video = {
                        "video_url": extracted["url"],
                        "vcodec": extracted.get("vcodec"),
                        "acodec": extracted.get("acodec"),
                    }
            if video:
                items.append(
                    {
                        "type": "video",
                        "url": video["video_url"],
                        "vcodec": video.get("vcodec"),
                        "acodec": video.get("acodec"),
                        "width": entry.get("original_width"),
                        "height": entry.get("original_height"),
                    }
                )
                continue
            # Video extraction failed: serve the child's still image so one
            # bad child doesn't fail the post; skip it only if there is no
            # still image either.
            img = _largest_image(entry)
            if img:
                items.append({"type": "image", **img})
        else:  # photo entry
            img = _largest_image(entry)
            if img:
                items.append({"type": "image", **img})
    if not items:
        raise HTTPException(
            status_code=422,
            detail="No accessible media found (private post, or Instagram withheld it)",
        )
    _json_cache_set(_image_cache_path(), shortcode, items, IMAGE_CACHE_MAX)
    return {
        "shortcode": shortcode,
        "url": target,
        "cached": False,
        "items": items,
    }


# --------------------------------------------------------------------------
@app.get("/posts/{media_id}", tags=["posts"], dependencies=[Depends(require_api_key)])
def get_post(media_id: str) -> Any:
    return run_cli("instagram-cli", "post", "--id", media_id)


@app.get("/posts/{media_id}/comments", tags=["posts"], dependencies=[Depends(require_api_key)])
def post_comments(
    media_id: str,
    limit: int = Query(25, ge=1, le=100),
    after: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-cli", "fetch-post-comments",
        "--post-ids", media_id, "--limit", str(limit),
        *_optional_arg("--after", after),
    )


@app.get("/posts/{media_id}/likers", tags=["posts"], dependencies=[Depends(require_api_key)])
def post_likers(
    media_id: str,
    limit: int = Query(25, ge=1, le=100),
    after: Optional[str] = None,
) -> Any:
    return run_cli(
        "instagram-cli", "fetch-post-likers",
        "--post-ids", media_id, "--limit", str(limit),
        *_optional_arg("--after", after),
    )


@app.get("/insights", tags=["posts"], dependencies=[Depends(require_api_key)])
def account_insights(
    start_time: int = Query(..., description="Unix timestamp (seconds)"),
    end_time: int = Query(..., description="Unix timestamp (seconds)"),
) -> Any:
    """Account-level insights. Professional (creator/business) accounts only."""
    return run_cli(
        "instagram-cli", "account-insights",
        "--user-id", ACCOUNT_ID,
        "--start-time", str(start_time),
        "--end-time", str(end_time),
    )


def _publish_media(
    files: List[UploadFile],
    covers: List[UploadFile],
    caption: str,
    mentions: str,
) -> Any:
    """Publish images and/or videos (video files publish as reels/carousel items)."""
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")

    saved_files: List[Path] = []
    saved_covers: List[Path] = []
    try:
        videos = 0
        for upload in files:
            suffix = Path(upload.filename or "").suffix.lower()
            if suffix in POST_VIDEO_EXTS:
                videos += 1
            allowed = POST_IMAGE_EXTS | POST_VIDEO_EXTS
            saved_files.append(save_upload(upload, allowed, MAX_POST_FILE_BYTES))
        for upload in covers:
            saved_covers.append(save_upload(upload, POST_IMAGE_EXTS, MAX_POST_FILE_BYTES))
        if videos and len(saved_covers) != videos:
            raise HTTPException(
                status_code=400,
                detail=f"{videos} video file(s) require exactly {videos} cover image(s)",
            )
        args: List[str] = []
        for path in saved_files:
            args += ["--file", str(path)]
        for path in saved_covers:
            args += ["--cover", str(path)]
        if caption:
            args += ["--caption", caption]
        if mentions:
            try:
                json.loads(mentions)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail="mentions must be valid JSON") from exc
            args += ["--mentions", mentions]
        # No retries on publish: a retry could create a duplicate post.
        return run_cli("instagram-cli", "post-feed", *args, timeout=600)
    finally:
        for path in saved_files + saved_covers:
            path.unlink(missing_ok=True)


@app.post("/posts/publish", tags=["posts"], dependencies=[Depends(require_api_key)])
def publish_post(
    files: List[UploadFile] = File(..., description="1 image = post, 1 video = reel, 2+ = carousel"),
    covers: List[UploadFile] = File(default=[], description="One cover image per video file"),
    caption: str = Form(""),
    mentions: str = Form("", description='JSON array, e.g. [{"user_fbid":"123","x":0.5,"y":0.5}]'),
) -> Any:
    """Publish an image post, reel, or carousel. One video file publishes as a reel."""
    return _publish_media(files, covers, caption, mentions)


@app.post("/reels/publish", tags=["reels"], dependencies=[Depends(require_api_key)])
def publish_reel(
    video: UploadFile = File(..., description="MP4/MOV, vertical 9:16 recommended"),
    cover: UploadFile = File(..., description="JPEG/PNG/WebP cover image"),
    caption: str = Form(""),
) -> Any:
    """Publish a reel (shared to feed and profile grid)."""
    return _publish_media([video], [cover], caption, "")


# --------------------------------------------------------------------------
# Agent message bridge (Mac agent <-> Muse, over the reverse tunnel)
# --------------------------------------------------------------------------

AGENT_MSGS_DIR = BASE_DIR / "agent_msgs"
AGENT_MSGS_DIR.mkdir(exist_ok=True)


def _box_path(name: str) -> Path:
    return AGENT_MSGS_DIR / f"{name}.json"


def _read_box(name: str) -> List[dict]:
    path = _box_path(name)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_box(name: str, msgs: List[dict]) -> None:
    path = _box_path(name)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(msgs, indent=2))
    tmp.replace(path)


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _touch_mac_seen() -> None:
    """Record that the Mac agent just polled us (for the outbox stall watch).

    Touched on the endpoints the Mac polls (/dms/updates, /agent/outbox),
    so the watcher can tell "Mac alive but not draining the outbox" apart
    from "Mac asleep/offline". Best-effort: never raises.
    """
    try:
        (AGENT_MSGS_DIR / "mac_last_seen").write_text(_utcnow())
    except OSError:
        pass


class AgentInbound(BaseModel):
    sender: str = "mac-agent"
    text: str


class AgentOutbound(BaseModel):
    text: str
    to: str = "mac-agent"


@app.post("/agent/inbox", tags=["agent"], dependencies=[Depends(require_api_key)])
def agent_inbox_post(msg: AgentInbound) -> dict:
    """Mac agent -> Muse. Queued until the inbox watcher picks it up."""
    if not msg.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    msgs = _read_box("inbox")
    entry = {
        "id": secrets.token_hex(6),
        "sender": msg.sender,
        "text": msg.text,
        "ts": _utcnow(),
        "read": False,
    }
    msgs.append(entry)
    _write_box("inbox", msgs)
    return {"ok": True, "id": entry["id"]}


@app.get("/agent/inbox", tags=["agent"], dependencies=[Depends(require_api_key)])
def agent_inbox_get(unread_only: bool = False) -> dict:
    msgs = _read_box("inbox")
    if unread_only:
        msgs = [m for m in msgs if not m.get("read")]
    return {"count": len(msgs), "messages": msgs}


@app.post("/agent/outbox", tags=["agent"], dependencies=[Depends(require_api_key)])
def agent_outbox_post(msg: AgentOutbound) -> dict:
    """Muse -> Mac agent. The Mac agent polls GET /agent/outbox."""
    if not msg.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    msgs = _read_box("outbox")
    entry = {
        "id": secrets.token_hex(6),
        "to": msg.to,
        "text": msg.text,
        "ts": _utcnow(),
        "read": False,
    }
    msgs.append(entry)
    _write_box("outbox", msgs)
    return {"ok": True, "id": entry["id"]}


@app.get("/agent/outbox", tags=["agent"], dependencies=[Depends(require_api_key)])
def agent_outbox_get(
    unread_only: bool = False,
    mark_read: bool = False,
) -> dict:
    """Poll for replies. Use ?unread_only=true&mark_read=true to fetch-and-clear."""
    _touch_mac_seen()
    msgs = _read_box("outbox")
    if unread_only:
        msgs = [m for m in msgs if not m.get("read")]
    if mark_read and msgs:
        ids = {m["id"] for m in msgs}
        all_msgs = _read_box("outbox")
        for m in all_msgs:
            if m["id"] in ids:
                m["read"] = True
        _write_box("outbox", all_msgs)
    return {"count": len(msgs), "messages": msgs}
