"use client";

import { useEffect, useRef, useState } from "react";

export type Person = { username: string; avatar: string | null; count: number };

/**
 * Who sent it, when more than one person is sending.
 *
 * A face rather than a name in the trigger: with two or three people in a
 * feed you recognise them by picture long before you have read the handle.
 * The same open-and-dismiss mechanics as the topic filter beside it.
 */
export default function PersonMenu({
  value,
  people,
  onChange,
}: {
  value: string;
  people: Person[];
  onChange: (value: string) => void;
}) {
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

  const current = people.find((person) => person.username === value);
  const isAll = value === "all";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
        className={`flex items-center gap-1.5 rounded-full py-1 pr-2 text-[13px] transition-colors ${
          isAll ? "text-muted hover:text-ink" : "pl-1 text-ink"
        }`}
      >
        {current && <Face person={current} size={18} />}
        <span>{isAll ? "Anyone" : current?.username}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden className="shrink-0 opacity-60">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 z-20 mt-2 max-h-72 w-56 overflow-y-auto rounded-xl bg-surface p-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)] ring-1 ring-line"
        >
          <Row selected={isAll} onClick={() => pick("all")}>
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-sunk text-[10px] text-muted">
              all
            </span>
            <span className="flex-1 truncate">Anyone</span>
          </Row>

          {people.map((person) => (
            <Row
              key={person.username}
              selected={person.username === value}
              onClick={() => pick(person.username)}
            >
              <Face person={person} size={22} />
              <span className="flex-1 truncate">{person.username}</span>
              <span className="shrink-0 tabular-nums text-[12px] text-muted">{person.count}</span>
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[14px] transition-colors hover:bg-sunk ${
        selected ? "bg-sunk text-ink" : "text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

function Face({ person, size }: { person: Person; size: number }) {
  const style = { width: size, height: size };
  if (person.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={person.avatar}
        alt=""
        style={style}
        className="shrink-0 rounded-full object-cover ring-1 ring-black/[0.08] dark:ring-white/[0.10]"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-sunk text-[10px] font-medium text-muted"
    >
      {person.username ? person.username[0]!.toUpperCase() : "?"}
    </span>
  );
}
