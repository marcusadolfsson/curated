#!/usr/bin/env python3
"""Fetch the raw logged-out Instagram post JSON for a share URL.

Reuses yt-dlp's Instagram extractor machinery (the logged-out GraphQL post
query, PolarisLoggedOutDesktopWWWPostRootContentQuery, no login) but captures
the raw product_info dict instead of extracting video formats. yt-dlp ignores
photo entries because it only emits video, yet the same response carries every
carousel child with full image_versions2 data.

Prints the product_info as JSON to stdout. Exits nonzero with a short reason
on the last stderr line when extraction fails.
"""

import json
import sys
import time

from yt_dlp import YoutubeDL
from yt_dlp.extractor.instagram import InstagramIE
from yt_dlp.utils import ExtractorError


class _RawProduct(Exception):
    """Sentinel carrying the raw product_info out of the extractor."""

    def __init__(self, media):
        self.media = media


class _RawInstagramIE(InstagramIE):
    def _extract_product(self, media, *a, **kw):
        # Short-circuit before any video/photo processing: we want the raw
        # post JSON, including every carousel child.
        raise _RawProduct(media)


def _fetch(url: str) -> dict:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        # Sandbox egress MITMs TLS; yt-dlp otherwise pins certifi's bundle,
        # which lacks the proxy CA.
        "compat_opts": ["no-certifi"],
        "skip_download": True,
    }
    with YoutubeDL(ydl_opts) as ydl:
        ie = _RawInstagramIE(ydl)
        try:
            ie.extract(url)
        except _RawProduct as raw:
            return raw.media
    raise ExtractorError("no product info captured")


def main() -> int:
    url = sys.argv[1]
    last_err = "extraction failed"
    # The logged-out GraphQL occasionally answers an empty response on the
    # first attempt (transient); one retry covers it.
    for _ in range(2):
        try:
            print(json.dumps(_fetch(url)))
            return 0
        except ExtractorError as exc:
            text = str(exc).strip().splitlines()
            last_err = text[0][:200] if text else "extraction failed"
            time.sleep(5)
        except Exception as exc:  # noqa: BLE001 - report and stop
            last_err = f"{type(exc).__name__}: {exc}"[:200]
            break
    print(f"ERROR: {last_err}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
