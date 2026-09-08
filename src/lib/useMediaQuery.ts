"use client";

import { useEffect, useState } from "react";

/**
 * True when the query matches. False on the server.
 *
 * Answered on the very first client render rather than after an effect,
 * because the viewer picks its whole layout from this: starting false drew
 * the desktop modal for one frame, and the flip to the phone layout remounted
 * the player - which asked Instagram for the same reel twice.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** A phone-sized screen, where the viewer takes over rather than opening a modal. */
export const PHONE = "(max-width: 767px)";
