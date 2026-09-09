#!/usr/bin/env bash
# Downloads an official Node build for the app bundle, and checks it.
#
# Homebrew's node cannot be copied into a bundle. Its `node` is a 67 KB shim
# against @rpath/libnode.dylib plus seventeen Homebrew dylibs - openssl, icu4c,
# simdjson, brotli, c-ares, nghttp2/3, ngtcp2, uvwasi, zstd, libuv, sqlite -
# so a copied binary dies on launch anywhere those are not installed at the
# same paths. The builds from nodejs.org are self-contained.
#
# 22, and not whatever is current: better-sqlite3 has no prebuilt binary for
# Node 26 and will not compile against its headers.
#
# Cached, because this is 50 MB and the bundle gets rebuilt often.
set -euo pipefail

VERSION="${NODE_VERSION:-v22.23.2}"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) PLATFORM="darwin-arm64" ;;
  x86_64) PLATFORM="darwin-x64" ;;
  *) echo "No Node build for $ARCH" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."
CACHE="${NODE_CACHE:-$PWD/.cache/node}"
DEST="$CACHE/node-$VERSION-$PLATFORM"

if [ -x "$DEST/bin/node" ]; then
  echo "$DEST"
  exit 0
fi

TARBALL="node-$VERSION-$PLATFORM.tar.gz"
BASE="https://nodejs.org/dist/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $TARBALL" >&2
curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"

# Checked against the published sums. This binary ends up inside a signed app
# that reads an Instagram session, so "it downloaded" is not the same as "it is
# the thing they published".
echo "Checking the signature" >&2
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
EXPECTED="$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
ACTUAL="$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum mismatch for $TARBALL" >&2
  echo "  expected: ${EXPECTED:-(not listed)}" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi

mkdir -p "$CACHE"
tar -xzf "$TMP/$TARBALL" -C "$CACHE"
[ -x "$DEST/bin/node" ] || { echo "No node binary in $DEST" >&2; exit 1; }

echo "$DEST"
