"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GearIcon } from "./icons";

/**
 * The cog. Report and Setup are things you visit once a week and once ever,
 * so they live behind one button rather than taking two words of the header
 * on a phone. Same open-and-dismiss mechanics as the topic menu.
 */
export default function HeaderMenu({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
        className={`${className} ${open ? "bg-sunk text-ink" : ""}`}
      >
        <GearIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl bg-surface p-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)] ring-1 ring-line"
        >
          {[
            ["/report", "Report", "What arrives, and when"],
            ["/setup", "Setup", "Sign in, and who to follow"],
          ].map(([href, label, hint]) => (
            <Link
              key={href}
              href={href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 transition-colors hover:bg-sunk"
            >
              <span className="block text-[14px] text-ink">{label}</span>
              <span className="block text-[12px] text-muted">{hint}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
