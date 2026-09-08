"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORY_HUE, isCategory } from "@/lib/categories";

/**
 * The topic filter. A native select cannot show the colour that runs down the
 * feed's rail next to each topic, and that colour is how you recognise them -
 * so this is a small menu of our own: the current topic with its dot as the
 * trigger, every topic with dot and count in the list.
 */
export default function CategoryMenu({
  value,
  categories,
  onChange,
  anyLabel = "Any kind",
  align = "right",
  className = "",
  tone = "default",
}: {
  value: string;
  /** Topic name and how many posts carry it (null to show no count), in the order to show. */
  categories: [string, number | null][];
  onChange: (value: string) => void;
  /** The "all" entry at the top; null for a plain picker with no such entry. */
  anyLabel?: string | null;
  align?: "left" | "right";
  /** Extra classes for the trigger, e.g. the serif face in the modal header. */
  className?: string;
  /** "dark" for the sheet over a reel, which is always dark whatever the theme. */
  tone?: "default" | "dark";
}) {
  const dark = tone === "dark";
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

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const total = categories.reduce((sum, [, count]) => sum + (count ?? 0), 0);
  const current = categories.find(([name]) => name === value);
  const currentCount = current?.[1] ?? null;
  const isAll = anyLabel !== null && value === "all";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
        style={hue(value)}
        className={`flex items-center gap-1.5 ${className || "text-[13px]"} ${
          dark ? "text-white/90" : isAll ? "text-muted hover:text-ink" : "text-ink"
        }`}
      >
        {!isAll && <span aria-hidden className="dot h-2 w-2 rounded-full" />}
        <span>{isAll ? anyLabel : value}</span>
        {currentCount !== null && <span className="text-muted">{currentCount}</span>}
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          aria-hidden
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Kind of post"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-30 mt-2 max-h-[min(60vh,26rem)] w-56 overflow-y-auto py-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)] ${
            dark ? "rounded-xl bg-[#232326] text-white" : "rounded-sm border border-line bg-surface"
          }`}
        >
          {anyLabel !== null && (
            <>
              <Option selected={value === "all"} label={anyLabel} count={total} onPick={() => pick("all")} dark={dark} />
              <li aria-hidden className={`mx-3 my-1.5 border-t ${dark ? "border-white/10" : "border-line"}`} />
            </>
          )}
          {categories.map(([name, count]) => (
            <Option
              key={name}
              selected={value === name}
              label={name}
              count={count}
              style={hue(name)}
              onPick={() => pick(name)}
              dark={dark}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Option({
  selected,
  label,
  count,
  style,
  onPick,
  dark,
}: {
  selected: boolean;
  label: string;
  count: number | null;
  style?: React.CSSProperties;
  onPick: () => void;
  dark?: boolean;
}) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onPick}
        style={style}
        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] ${
          dark
            ? `hover:bg-white/10 ${selected ? "text-white" : "text-white/70"}`
            : `hover:bg-sunk ${selected ? "text-ink" : "text-ink-soft"}`
        }`}
      >
        <span
          aria-hidden
          className={`dot h-2 w-2 shrink-0 rounded-full ${style ? "" : "opacity-0"}`}
        />
        <span className={`flex-1 ${selected ? "font-medium" : ""}`}>{label}</span>
        {count !== null && <span className="text-[12px] text-muted">{count}</span>}
      </button>
    </li>
  );
}

function hue(name: string): React.CSSProperties {
  return { ["--hue" as string]: isCategory(name) ? CATEGORY_HUE[name] : 220 };
}
