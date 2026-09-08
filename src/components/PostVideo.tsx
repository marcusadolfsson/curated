"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The reel, playing here.
 *
 * Instagram's embed will not play one - it shows a cover and a button that
 * leaves - but the file behind it is an ordinary mp4, fetched when it arrived
 * and served with range support so seeking works.
 *
 * Sound. iOS lets a video autoplay only muted, unless play() happens inside a
 * user gesture - and the tap that opened this modal is one. That only works if
 * the source is known at mount, which it is for a prefetched reel: the element
 * mounts with its src, tries to play with sound while the tap still counts,
 * and falls back to muted if WebKit says no. In that case one big tap on the
 * video turns the sound on, instead of hunting for the small control.
 */
const SOUND_KEY = "insta.sound";

/** The last choice made with the sound button. Absent means never chosen: try sound. */
function preferredSound(): "on" | "off" {
  try {
    return window.localStorage.getItem(SOUND_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

function rememberSound(mode: "on" | "off") {
  try {
    window.localStorage.setItem(SOUND_KEY, mode);
  } catch {
    // private mode or storage blocked: nothing to remember into
  }
}

export default function PostVideo({
  postId,
  video,
  poster,
  permalink,
  active = true,
  sound: wantsSound = true,
  fit = "cover",
  onRemaining,
}: {
  postId: number;
  /** Local URL when the reel is already cached; null means ask the server. */
  video: string | null;
  poster: string | null;
  permalink: string;
  /** Should this one be playing at all - it is on screen, or being dragged in. */
  active?: boolean;
  /** Should this be the one making noise. Two reels can play; only one is heard. */
  sound?: boolean;
  /**
   * Filling the screen, or fitted inside it. A reel is shot for a phone, so
   * covering is what it is for; when the card comes up and the picture has
   * only a strip left, the whole frame matters more than the edges.
   */
  fit?: "cover" | "contain";
  /** Whole seconds left to play, or null when there is no reel to time. */
  onRemaining?: (seconds: number | null) => void;
}) {
  const [src, setSrc] = useState<string | null>(video);
  const [failed, setFailed] = useState(false);
  const [audio, setAudio] = useState<"unknown" | "on" | "off">("unknown");
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const ref = useRef<HTMLVideoElement>(null);
  const fetched = useRef(false);
  // Only told when the whole second changes, so the viewer around this is not
  // re-rendered four times a second for a number that has not moved.
  const reported = useRef<number | null>(null);
  /**
   * Sound this reel should have had and did not get.
   *
   * A cached reel already has its file when you swipe, so it starts inside
   * that gesture and the browser allows the sound. One that still has to be
   * fetched arrives seconds later, long after the gesture has expired, and
   * unmuted playback is refused - which looks exactly like the setting having
   * been forgotten. It was not: this is owed, and claimed at the next touch.
   */
  const owedSound = useRef(false);

  // Not cached yet (or the cached file went missing): have the server fetch it.
  const fetchFromServer = () => {
    if (fetched.current) {
      setFailed(true);
      return;
    }
    fetched.current = true;
    void fetch(`/api/posts/${postId}/images`)
      .then((response) => (response.ok ? response.json() : { video: null }))
      .then((body: { video?: string | null }) => {
        if (body.video) setSrc(body.video);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  };

  useEffect(() => {
    if (!src) fetchFromServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // Plays while it is the one on screen, or the one being dragged into view.
  // Both can be running at once, which is what lets the sound cross over
  // halfway through a swipe instead of cutting out and starting again. Only
  // the one that should be heard is unmuted; the other plays silently.
  useEffect(() => {
    const element = ref.current;
    if (!element || !src) return;

    if (!active) {
      element.pause();
      // Back to the start, so arriving at it again begins at the beginning.
      element.currentTime = 0;
      return;
    }

    if (!wantsSound || preferredSound() === "off") {
      element.muted = true;
      setAudio("off");
      owedSound.current = false; // silence was asked for, not imposed
      element.play().catch(() => undefined);
      return;
    }

    element.muted = false;
    element
      .play()
      .then(() => {
        setAudio("on");
        owedSound.current = false;
      })
      .catch(() => {
        element.muted = true;
        setAudio("off");
        owedSound.current = true;
        element.play().catch(() => undefined);
      });
  }, [src, active, wantsSound]);

  // The next touch anywhere is a gesture, and a gesture is all that was
  // missing. Starting the swipe to the next reel counts, so at worst the
  // sound comes back the moment you reach for the screen.
  useEffect(() => {
    if (!active || !wantsSound) return;

    const claim = () => {
      const element = ref.current;
      if (!element || !owedSound.current || !element.muted) return;
      element.muted = false;
      void element
        .play()
        .then(() => {
          owedSound.current = false;
          setAudio("on");
        })
        .catch(() => {
          element.muted = true;
          void element.play().catch(() => undefined);
        });
    };

    document.addEventListener("touchstart", claim, { passive: true });
    document.addEventListener("pointerdown", claim);
    return () => {
      document.removeEventListener("touchstart", claim);
      document.removeEventListener("pointerdown", claim);
    };
  }, [active, wantsSound]);

  const turnSoundOn = () => {
    const element = ref.current;
    if (!element) return;
    element.muted = false;
    element
      .play()
      .then(() => {
        setAudio("on");
        rememberSound("on");
      })
      .catch(() => undefined);
  };

  const toggleSound = () => {
    const element = ref.current;
    if (!element) return;
    if (element.muted) turnSoundOn();
    else {
      element.muted = true;
      setAudio("off");
      owedSound.current = false; // you asked for silence; stop trying to undo it
      rememberSound("off");
    }
  };

  // Like a reel: tap the picture to pause, tap again to go on. Space does
  // the same, unless you are typing in the reply box.
  const togglePlay = () => {
    const element = ref.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " && event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      togglePlay();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (failed) {
    return (
      <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[14px] text-muted">Instagram would not hand over this video.</p>
        <a
          href={permalink}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[14px] text-accent underline-offset-4 hover:underline"
        >
          Watch it on Instagram
        </a>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center bg-black">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="max-h-full max-w-full object-contain opacity-40" />
        ) : (
          <span className="text-[13px] text-muted">Fetching the video</span>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {/* No native controls: on iOS they sit over the picture. The reel
          itself is the control - tap to pause - plus a sound toggle and a
          progress line. */}
      <video
        ref={ref}
        src={src}
        poster={poster ?? undefined}
        loop
        playsInline
        preload={active ? "auto" : "metadata"}
        className={
          fit === "cover" ? "h-full w-full object-cover" : "max-h-full max-w-full object-contain"
        }
        onClick={togglePlay}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onTimeUpdate={(event) => {
          const element = event.currentTarget;
          if (!(element.duration > 0)) return;
          setProgress(element.currentTime / element.duration);
          const left = Math.max(0, Math.ceil(element.duration - element.currentTime));
          if (left !== reported.current) {
            reported.current = left;
            onRemaining?.(left);
          }
        }}
        onError={() => {
          // A cached file that is gone from disk; fetch it again once.
          if (video && src === video) fetchFromServer();
          else setFailed(true);
        }}
      />

      {paused && active && wantsSound && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute bottom-32 left-4 flex h-9 items-center gap-2 rounded-full bg-black/50 pl-2.5 pr-3.5 text-[13px] text-white backdrop-blur-sm md:bottom-4"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          Paused
        </button>
      )}

      {active && wantsSound && (
      <button
        type="button"
        onClick={toggleSound}
        aria-label={audio === "on" ? "Mute" : "Unmute"}
        className="absolute bottom-32 right-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm md:bottom-4"
      >
        {audio === "on" ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-8-8L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
          </svg>
        )}
      </button>
      )}

      <div className="absolute inset-x-0 top-0 h-[3px] bg-white/20 md:bottom-0 md:top-auto">
        <div className="h-full bg-white/90" style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
      </div>
    </div>
  );
}
