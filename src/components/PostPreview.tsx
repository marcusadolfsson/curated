"use client";

import { useEffect, useRef, useState } from "react";
import PostGallery from "./PostGallery";
import PostVideo from "./PostVideo";
import PostChrome from "./PostChrome";
import { CloseIcon } from "./icons";
import type { PostView } from "@/lib/serialize";
import { PHONE, useMediaQuery } from "@/lib/useMediaQuery";

/**
 * A post, up close.
 *
 * On a phone it is a reel: the picture fills the screen and follows your
 * finger as you drag, with the next post already there underneath.
 *
 * Whether it moves on is a question of momentum, not of distance. A drag is
 * read the way a thrown thing is: where would it come to rest if you let go
 * now. A flick that has barely moved the picture still carries, and a slow
 * haul has to actually get there. The moment that answer turns to yes is also
 * the moment the arriving post starts playing and takes the sound - so the one
 * that started is always the one you land on, and it never starts something
 * you were not going to reach.
 *
 * That is why this holds three posts at once - the one you are on and its two
 * neighbours - and why everything per-post lives in PostChrome, keyed by id.
 * The pictures have to outlive the post changing under them, or the video you
 * just dragged into view would restart the moment it arrived.
 *
 * On a desktop it is a modal with the picture on the left and the words on the
 * right, which is what the wider screen is for.
 */
type Props = {
  /** The list you are moving through, and where you are in it. */
  sequence: PostView[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onToggleSaved: (id: number, saved: boolean) => Promise<void>;
  onReact: (id: number, emoji: string) => Promise<void>;
  onReply: (id: number, text: string) => Promise<string | null>;
  onChangeCategory: (id: number, category: string) => Promise<void>;
};

/** How long the picture takes to settle once you let go. */
const SETTLE_MS = 220;
/** Where a flick would come to rest, as a share of the screen, to count. */
const COMMIT_FRACTION = 0.5;
/** And how far back it has to fall before it stops counting: no flicker at the line. */
const RELEASE_FRACTION = 0.38;
/** How long a flick is taken to coast for, when working out where it lands. */
const PROJECT_MS = 160;
/**
 * A flick goes, whatever distance it covered.
 *
 * Projecting where the picture would come to rest is right for a drag, but it
 * asks a flick to have travelled a long way as well as fast, and a flick is
 * mostly speed: a quick one covers sixty pixels and coasts to maybe four
 * hundred, landing just short of the half screen the projection wants. So it
 * did nothing, which is the wrong answer to a deliberate gesture.
 *
 * Above this, in pixels per millisecond, the throw alone is enough. A hurried
 * flick is somewhere north of 1.5; positioning the picture by hand sits under
 * 0.3, so there is a wide gap between the two and this sits in it.
 */
const FLING_SPEED = 0.5;
/** Enough movement to tell a drag from a tap, and to pick an axis. */
const AXIS_PX = 10;
/**
 * How far right the whole modal has to be pushed before letting go returns to
 * the index. Half the screen: it used to be sixty fixed pixels, decided
 * invisibly at the end of a gesture that showed nothing while it happened, so
 * the post vanished on what felt like a nudge.
 */
const CLOSE_FRACTION = 0.5;
/** How far the picture gives when there is nothing that way to go. */
const RUBBER = 0.25;
/** How much of the screen the details card takes, and the reel gives up. */
export const SHEET_VH = 66;
/**
 * The strip along the bottom that the reactions sit on.
 *
 * They used to float over the picture, which meant the picture ran on behind
 * them and showed through underneath. This is ground of its own, the way the
 * comment bar is on Instagram - the picture stops where it starts.
 */
export const BAR_PX = 62;
export const BAR_HEIGHT = `calc(${BAR_PX}px + env(safe-area-inset-bottom))`;

/**
 * How tall the caption is where it lies over the foot of the picture. Only the
 * line of text and its padding: the gradient above it is decorative and does
 * not take clicks, so anything underneath may sit within it. A gallery's
 * thumbnail strip is inset by this so the two do not share a row.
 */
export const CAPTION_PX = 44;

function timeLeft(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function PostPreview({
  sequence,
  index,
  onIndexChange,
  onClose,
  onToggleSaved,
  onReact,
  onReply,
  onChangeCategory,
}: Props) {
  const phone = useMediaQuery(PHONE);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Where the card has got to on its way down, so the picture can take back
  // the room in step with it rather than after it.
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetAnimating, setSheetAnimating] = useState(true);

  const openSheet = (open: boolean) => {
    setSheetOffset(0);
    setSheetAnimating(true);
    setSheetOpen(open);
  };
  const [remaining, setRemaining] = useState<number | null>(null);

  // How far the picture has been dragged, in pixels. Negative is upwards,
  // which is towards the next post.
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  // Whether this gesture is going to land on the neighbour. The picture and
  // the sound both follow from it, so they can never disagree.
  const [committing, setCommitting] = useState(false);
  const committingNow = useRef(false);
  // Smoothed speed of the finger, in pixels per millisecond.
  const swipe = useRef({ y: 0, at: 0, speed: 0 });

  const closeRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // The screen's height, which every part of the drag is measured against.
  // State rather than a ref, because the render itself needs it to work out
  // how far along a drag is and therefore which reel should be audible.
  const [height, setHeight] = useState(1);
  const [width, setWidth] = useState(1);
  /** How far right the modal has been pushed, and whether it is animating. */
  const [dragX, setDragX] = useState(0);
  const [xSettling, setXSettling] = useState(false);
  const touch = useRef<{ x: number; y: number; axis: null | "x" | "y" } | null>(null);

  const post = sequence[index];
  const hasNext = index + 1 < sequence.length;
  const hasPrevious = index > 0;

  useEffect(() => {
    const measure = () => {
      setHeight(trackRef.current?.clientHeight || window.innerHeight || 1);
      setWidth(trackRef.current?.clientWidth || window.innerWidth || 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const settle = (delta: -1 | 0 | 1) => {
    setSettling(true);
    committingNow.current = delta !== 0;
    setCommitting(delta !== 0);
    setOffset(delta === 0 ? 0 : -delta * height);
    window.setTimeout(() => {
      // All three land in one render: the list moves on, the picture is back
      // at nought, and the transition is off - so the slide that was below is
      // now the middle one, in exactly the place it already occupied.
      if (delta !== 0) {
        onIndexChange(index + delta);
        openSheet(false); // the writing belonged to the post you just left
      }
      committingNow.current = false;
      setCommitting(false);
      setSettling(false);
      setOffset(0);
    }, SETTLE_MS);
  };

  const move = (delta: -1 | 1) => {
    if (settling) return;
    if (delta === 1 && !hasNext) return;
    if (delta === -1 && !hasPrevious) return;
    settle(delta);
  };

  // The keys do what the finger does. Bound once, reading the current move
  // from a ref, so the countdown ticking does not rebind a document listener.
  const moves = useRef({ next: () => move(1), previous: () => move(-1) });
  useEffect(() => {
    moves.current = { next: () => move(1), previous: () => move(-1) };
  });

  useEffect(() => {
    if (!phone) closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (sheetOpen) openSheet(false);
        else onClose();
      }
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        moves.current.next();
      }
      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        moves.current.previous();
      }
    };
    document.addEventListener("keydown", onKey);

    // The page behind should not scroll while this is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, sheetOpen, phone]);

  const onTouchStart = (event: React.TouchEvent) => {
    if (settling || xSettling || sheetOpen) return;
    const point = event.touches[0];
    touch.current = { x: point.clientX, y: point.clientY, axis: null };
    swipe.current = { y: point.clientY, at: event.timeStamp, speed: 0 };
  };

  const onTouchMove = (event: React.TouchEvent) => {
    const start = touch.current;
    if (!start) return;
    const point = event.touches[0];
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;

    if (start.axis === null) {
      if (Math.abs(dx) < AXIS_PX && Math.abs(dy) < AXIS_PX) return;
      start.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (start.axis === "x") {
      // The modal comes with the finger, so the gesture can be seen and
      // abandoned. Leftward there is nothing to go back to, so it gives a
      // little and returns, the same as the vertical ends do.
      setDragX(dx >= 0 ? dx : dx * RUBBER);
      return;
    }
    if (start.axis !== "y") return;

    // Nothing that way to go: it gives a little and comes back, rather than
    // pretending there is another post under it.
    let travel = dy;
    const canGo = (dy < 0 && hasNext) || (dy > 0 && hasPrevious);
    if (!canGo) travel *= RUBBER;
    setOffset(travel);

    const elapsed = event.timeStamp - swipe.current.at;
    if (elapsed > 0) {
      const instant = (point.clientY - swipe.current.y) / elapsed;
      // Smoothed, because a single frame of a finger is a noisy thing to steer by.
      swipe.current.speed = swipe.current.speed * 0.65 + instant * 0.35;
      swipe.current.y = point.clientY;
      swipe.current.at = event.timeStamp;
    }

    // Where it would come to rest if the finger left the glass now.
    const reach = Math.abs(travel + swipe.current.speed * PROJECT_MS) / height;
    // A throw counts on its own, provided it is still going the way the
    // picture has been dragged. Without that test a finger that pulls up and
    // then whips back down would read as a fast upward flick and turn the
    // page it was on its way back from.
    const flung =
      Math.abs(swipe.current.speed) >= FLING_SPEED &&
      Math.sign(swipe.current.speed) === Math.sign(travel);
    const going =
      canGo &&
      (flung || (committingNow.current ? reach >= RELEASE_FRACTION : reach >= COMMIT_FRACTION));
    if (going !== committingNow.current) {
      committingNow.current = going;
      setCommitting(going);
    }
  };

  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;

    if (start.axis === "x") {
      const dx = event.changedTouches[0].clientX - start.x;
      if (phone && dx > width * CLOSE_FRACTION) {
        // Carry it the rest of the way rather than cutting from half-open to
        // gone, then hand back to the index once it is off the glass.
        setXSettling(true);
        setDragX(width);
        window.setTimeout(() => {
          onClose();
          setXSettling(false);
          setDragX(0);
        }, SETTLE_MS);
      } else {
        setXSettling(true);
        setDragX(0);
        window.setTimeout(() => setXSettling(false), SETTLE_MS);
      }
      return;
    }
    if (start.axis !== "y") return;

    // The same answer the picture has been acting on all along.
    if (committingNow.current && offset < 0 && hasNext) settle(1);
    else if (committingNow.current && offset > 0 && hasPrevious) settle(-1);
    else settle(0);
  };

  // Which post is being dragged into view, and whether the gesture has
  // committed to it. Until it has, it holds on its first frame and the reel
  // you are leaving keeps playing.
  const towards = offset < 0 ? 1 : offset > 0 ? -1 : 0;
  const arriving = towards === 0 ? null : index + towards;
  const takenOver = arriving !== null && committing && Boolean(sequence[arriving]);
  const audible = takenOver ? arriving : index;

  // How much of the screen the picture currently has.
  const mediaShare = sheetOpen
    ? ((100 - SHEET_VH) / 100) + sheetOffset / height
    : 1 - BAR_PX / height;

  const slideFor = (at: number) => {
    const slide = sequence[at];
    if (!slide) return null;
    const isVideo = slide.mediaType === "reel" || slide.mediaType === "tv";
    // Playing: the one you are on, and the arriving one once it has taken over.
    const active = at === index || (takenOver && at === arriving);

    return (
      <div
        key={slide.id}
        className="absolute inset-0"
        style={{ transform: `translateY(${(at - index) * 100}%)` }}
      >
        <div
          // Full screen normally. With the card up it gives way to it, keeping
          // the top strip, and the reel shows its whole frame in what is left.
          className="absolute inset-x-0 top-0"
          style={{
            height: sheetOpen
              ? `calc(${100 - SHEET_VH}% + ${sheetOffset}px)`
              : `calc(100% - ${BAR_HEIGHT})`,
            // No transition while a finger is on the card: it should move with
            // it, not chase it.
            transition: sheetAnimating ? "height 300ms ease-out" : "none",
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {isVideo ? (
            <PostVideo
              postId={slide.id}
              video={slide.video}
              poster={slide.thumbnail}
              permalink={slide.permalink}
              active={active}
              sound={at === audible}
              // Nearly the whole screen again: fill it, so the last of the
              // drag does not end on the picture jumping wider.
              fit={mediaShare > 0.85 ? "cover" : "contain"}
              onRemaining={at === audible ? setRemaining : undefined}
            />
          ) : (
            <PostGallery
              postId={slide.id}
              filename={`${slide.authorUsername ? `${slide.authorUsername}-` : ""}${slide.shortcode}`}
              bottomInset={CAPTION_PX}
            />
          )}
        </div>
        <PostChrome
          post={slide}
          variant="phone"
          sheetOpen={at === index && sheetOpen}
          onSheetOpen={openSheet}
          onSheetOffset={(pixels, animated) => {
            setSheetOffset(pixels);
            setSheetAnimating(animated);
          }}
          onClose={onClose}
          onToggleSaved={onToggleSaved}
          onReact={onReact}
          onReply={onReply}
          onChangeCategory={onChangeCategory}
        />
      </div>
    );
  };

  if (!post) return null;

  if (phone) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={post.summary ?? "Shared post"}
        // Pinned to the dynamic viewport rather than left to inset-0 alone.
        // If this ever comes up short of the glass - which iOS can do around
        // the home indicator - what shows underneath is the feed, and a post's
        // own cover sitting in that strip reads as the picture repeating.
        className="fixed inset-x-0 top-0 z-50 h-[100dvh] overflow-hidden bg-black"
        style={{
          transform: `translateX(${dragX}px)`,
          transition: xSettling ? `transform ${SETTLE_MS}ms ease-out` : "none",
        }}
      >
        <div
          ref={trackRef}
          className="absolute inset-0"
          style={{
            transform: `translateY(${offset}px)`,
            transition: settling ? `transform ${SETTLE_MS}ms ease-out` : "none",
          }}
        >
          {slideFor(index - 1)}
          {slideFor(index)}
          {slideFor(index + 1)}
        </div>

        {/* Corners, kept clear of the notch. These stay put while it moves. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
          <span className="flex items-center gap-2">
            {sequence.length > 1 && (
              <span className="rounded-full bg-black/45 px-2.5 py-1 text-[12px] text-white/90 backdrop-blur-sm">
                {index + 1} of {sequence.length}
              </span>
            )}
            {remaining !== null && (
              <span className="rounded-full bg-black/45 px-2.5 py-1 text-[12px] tabular-nums text-white/90 backdrop-blur-sm">
                {timeLeft(remaining)}
              </span>
            )}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Back to the list"
            title="Back to the list"
            // The same height as the pills beside it, so the row reads as one.
            className="pointer-events-auto flex h-[26px] w-[26px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  const isVideo = post.mediaType === "reel" || post.mediaType === "tv";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={post.summary ?? "Shared post"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-5"
      onClick={onClose}
    >
      <div
        className="flex h-[92vh] max-h-full w-full max-w-[1240px] flex-col overflow-hidden rounded-sm border border-line bg-surface md:flex-row"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative min-h-0 min-w-0 flex-1 bg-black">
          {sequence.length > 1 && (
            <span className="pointer-events-none absolute left-4 top-3 z-10 flex items-center gap-2">
              <span className="rounded-full bg-black/45 px-2.5 py-1 text-[12px] text-white/90 backdrop-blur-sm">
                {index + 1} of {sequence.length}
              </span>
              {remaining !== null && (
                <span className="rounded-full bg-black/45 px-2.5 py-1 text-[12px] tabular-nums text-white/90 backdrop-blur-sm">
                  {timeLeft(remaining)}
                </span>
              )}
            </span>
          )}
          {isVideo ? (
            <PostVideo
              key={post.id}
              postId={post.id}
              video={post.video}
              poster={post.thumbnail}
              permalink={post.permalink}
              // Contain, not the component's default of cover. The pane here
              // is wider than it is tall and a reel is the opposite, so filling
              // it crops the top and bottom away - which on a reel is where the
              // caption someone burned into it usually sits. Photos in the
              // gallery beside this already letterbox for the same reason.
              fit="contain"
              onRemaining={setRemaining}
            />
          ) : (
            <PostGallery
              key={post.id}
              postId={post.id}
              filename={`${post.authorUsername ? `${post.authorUsername}-` : ""}${post.shortcode}`}
            />
          )}
        </div>
        <div className="flex max-h-[45%] w-full shrink-0 flex-col border-t border-line md:max-h-none md:w-[340px] md:border-t-0 md:border-l">
          <PostChrome
            key={post.id}
            post={post}
            variant="desktop"
            sheetOpen={false}
            onSheetOpen={() => undefined}
            onClose={onClose}
            onToggleSaved={onToggleSaved}
            onReact={onReact}
            onReply={onReply}
            onChangeCategory={onChangeCategory}
            closeRef={closeRef}
          />
        </div>
      </div>
    </div>
  );
}
