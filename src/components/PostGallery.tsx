"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Image = { url: string; width?: number; height?: number };

/**
 * Our own viewer for photo posts.
 *
 * Instagram's embed shows the images but keeps them behind a cross-origin
 * frame, which means it cannot tell us which one you have swiped to - so
 * "download this image" was never answerable. Serving them ourselves makes the
 * current one an ordinary fact, and they arrive at full size.
 *
 * A strip of the whole post sits under the image rather than next/previous
 * buttons: with a carousel you want to see what is in it, not discover it one
 * click at a time.
 */
export default function PostGallery({
  postId,
  filename,
  bottomInset = 0,
}: {
  postId: number;
  filename: string;
  /**
   * Room to leave at the foot of the picture for something drawn over it. On
   * the phone the caption sits there, and without this the thumbnail strip
   * ends up underneath it - visible through the gradient, with the sender's
   * name printed across the first frame.
   */
  bottomInset?: number;
}) {
  const [images, setImages] = useState<Image[] | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const activeThumb = useRef<HTMLButtonElement>(null);

  // Keep the selected thumbnail in view as you move - a sixteen-image post is
  // wider than the strip.
  useEffect(() => {
    activeThumb.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index]);

  useEffect(() => {
    let cancelled = false;

    void fetch(`/api/posts/${postId}/images`)
      .then((response) => (response.ok ? response.json() : { images: [] }))
      .then((body: { images?: Image[] }) => {
        if (cancelled) return;
        const found = body.images ?? [];
        setImages(found);
        setFailed(found.length === 0);
      })
      .catch(() => !cancelled && setFailed(true));

    return () => {
      cancelled = true;
    };
  }, [postId]);

  const count = images?.length ?? 0;

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(index + 1);
      if (event.key === "ArrowLeft") go(index - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, index]);

  if (failed) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center px-6 text-center text-[14px] text-muted">
        Instagram would not hand over the images for this one.
      </div>
    );
  }

  if (!images) {
    return <div className="h-full min-h-[300px] animate-pulse bg-sunk" />;
  }

  const current = images[index];

  return (
    <div className="flex h-full w-full flex-col bg-black" style={{ paddingBottom: bottomInset }}>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.url}
          alt={`Image ${index + 1} of ${count}`}
          className="max-h-full max-w-full object-contain"
        />

        <a
          href={current.url}
          download={`${filename}-${index + 1}.jpg`}
          className="absolute top-2 right-2 rounded-sm bg-black/55 px-2 py-1 text-[12px] text-white transition-colors hover:bg-black/80"
        >
          Download
        </a>

        {count > 1 && (
          <>
            <span className="absolute top-2 left-2 rounded-sm bg-black/55 px-2 py-1 text-[12px] text-white">
              {index + 1} of {count}
            </span>
            <button
              type="button"
              onClick={() => go(index - 1)}
              aria-label="Previous image"
              className="absolute top-1/2 left-3 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/75"
            >
              <svg viewBox="0 0 12 20" className="h-4 w-4 fill-none stroke-current stroke-2">
                <path d="M10 1L2 10l8 9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              aria-label="Next image"
              className="absolute top-1/2 right-3 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/75"
            >
              <svg viewBox="0 0 12 20" className="h-4 w-4 fill-none stroke-current stroke-2">
                <path d="M2 1l8 9-8 9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>

      {count > 1 && (
        <div className="flex w-full min-w-0 shrink-0 gap-1.5 overflow-x-auto bg-black/85 p-2">
          {images.map((image, position) => (
            <button
              key={image.url}
              ref={position === index ? activeThumb : undefined}
              type="button"
              onClick={() => go(position)}
              aria-label={`Image ${position + 1}`}
              aria-current={position === index}
              className={`shrink-0 overflow-hidden rounded-sm transition-opacity ${
                position === index
                  ? "opacity-100 ring-2 ring-white"
                  : "opacity-45 hover:opacity-80"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" className="h-14 w-14 object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
