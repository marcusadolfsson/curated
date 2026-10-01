#!/usr/bin/env python3
"""Drain the outbound queue: send queued reactions and DMs via the CLIs.

Run by the `outbound-queue-sender` cron every 30s. That scheduled task carries
the standing Allow for sending, so the CLI calls here don't raise per-action
approval cards.

Usage: drain_outbound_queue.py [--dry-run]
  --dry-run: print the CLI commands that would run; change nothing.

Queue file: agent_msgs/outbound_queue.json — a list of:
  {"id", "type": "react"|"send", "thread_fbid",
   "message_id"?, "emoji"?, "text"?, "reply_to_message_id"?,
   "status": "queued"|"sent"|"failed",
   "queued_at", "sent_at"?, "error"?}

Locking: an exclusive flock on the queue file, so overlapping runs (30s
cadence) can never double-send the same item.
"""

import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
QUEUE_PATH = BASE_DIR / "agent_msgs" / "outbound_queue.json"
PRUNE_AFTER_S = 24 * 3600
MAX_ITEMS = 200
CLI_TIMEOUT = 60


def _account_id() -> str:
    explicit = os.environ.get("IG_ACCOUNT_ID")
    if explicit:
        return explicit
    proc = subprocess.run(
        ["instagram-cli", "accounts"],
        capture_output=True, text=True, timeout=30,
    )
    data = json.loads(proc.stdout)
    accounts = data.get("accounts") or []
    if not accounts:
        raise RuntimeError("no connected Instagram account")
    return accounts[0]["user_fbid"]


def _build_cmd(item: dict, account_id: str) -> list:
    if item["type"] == "react":
        return [
            "instagram-messages-cli", "react",
            "--thread-fbid", item["thread_fbid"],
            "--message-id", item["message_id"],
            "--emoji", item["emoji"],
            "--account-id", account_id,
        ]
    if item["type"] == "send":
        cmd = [
            "instagram-messages-cli", "send",
            "--thread-fbid", item["thread_fbid"],
            "--text", item["text"],
            "--account-id", account_id,
        ]
        if item.get("reply_to_message_id"):
            # insert before --account-id to mirror /dms/send's arg order
            cmd[-2:-2] = ["--reply-to-message-id", item["reply_to_message_id"]]
        return cmd
    raise ValueError(f"unknown queue item type: {item.get('type')}")


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    try:
        account_id = _account_id()
    except Exception as exc:  # noqa: BLE001 - reported in summary
        print(json.dumps({"processed": 0, "sent": [], "failed": [],
                          "error": f"account lookup failed: {exc}"}))
        return 1

    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    sent, failed = [], []
    with open(QUEUE_PATH, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.seek(0)
            raw = fh.read()
            items = json.loads(raw) if raw.strip() else []
            if not isinstance(items, list):
                items = []

            for item in items:
                if item.get("status") != "queued":
                    continue
                try:
                    cmd = _build_cmd(item, account_id)
                except (KeyError, ValueError) as exc:
                    item["status"] = "failed"
                    item["error"] = f"bad queue item: {exc}"
                    failed.append({"id": item.get("id"), "error": item["error"]})
                    continue
                if dry_run:
                    print("WOULD RUN:", " ".join(cmd))
                    continue
                try:
                    proc = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=CLI_TIMEOUT
                    )
                except subprocess.TimeoutExpired:
                    item["status"] = "failed"
                    item["error"] = "CLI timed out"
                    failed.append({"id": item.get("id"), "error": item["error"]})
                    continue
                if proc.returncode == 0:
                    item["status"] = "sent"
                    item["sent_at"] = time.time()
                    sent.append(item.get("id"))
                else:
                    err = (proc.stderr or proc.stdout or "").strip().splitlines()
                    item["status"] = "failed"
                    item["error"] = err[-1][:300] if err else f"exit {proc.returncode}"
                    failed.append({"id": item.get("id"), "error": item["error"]})

            if not dry_run:
                now = time.time()
                items = [
                    it for it in items
                    if not (
                        it.get("status") in ("sent", "failed")
                        and now - it.get("sent_at", it.get("queued_at", now)) > PRUNE_AFTER_S
                    )
                ]
                if len(items) > MAX_ITEMS:
                    items = items[-MAX_ITEMS:]
                fh.seek(0)
                fh.truncate()
                fh.write(json.dumps(items))
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)

    print(json.dumps({"processed": len(sent) + len(failed),
                      "sent": sent, "failed": failed}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
