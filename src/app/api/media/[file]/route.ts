import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { MEDIA_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
};

export async function GET(request: NextRequest, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;

  // Serve only plain filenames from the media directory.
  const filename = path.basename(file);
  const target = path.join(MEDIA_DIR, filename);
  if (path.dirname(target) !== MEDIA_DIR || !fs.existsSync(target)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const contentType =
    CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
  const size = fs.statSync(target).size;
  const range = request.headers.get("range");

  // Video needs ranges: without them you cannot seek, and Safari refuses to
  // play at all. Safari's first ask is open-ended ("bytes=0-"); answering
  // that with the whole file, read into memory first, is what made a reel
  // take a while to start. Now the reply is a stream from disk, and an
  // open-ended range is answered in a slice that gets the player going - it
  // asks for the rest as it needs it, which is what it does anyway.
  if (range && contentType.startsWith("video/")) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const requestedEnd = match?.[2] ? Number(match[2]) : null;

    if (Number.isNaN(start) || (requestedEnd !== null && Number.isNaN(requestedEnd)) || start >= size) {
      return new NextResponse("Range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }

    const end = Math.min(requestedEnd ?? start + OPEN_RANGE_SLICE - 1, size - 1);
    return new NextResponse(streamOf(target, start, end), {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }

  return new NextResponse(streamOf(target, 0, size - 1), {
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": contentType.startsWith("video/") ? "bytes" : "none",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

/** How much of an open-ended range to send before letting the player ask again. */
const OPEN_RANGE_SLICE = 4 * 1024 * 1024;

function streamOf(file: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
}
