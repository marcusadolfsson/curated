"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORY_HUE, isCategory } from "@/lib/categories";
import { FilterIcon } from "./icons";

export type Person = { username: string; avatar: string | null; count: number };

/**
 * What to show: the kind of post, and who sent it.
 *
 * One menu rather than two triggers side by side. They are the same question
 * asked twice - narrow the pile - and on a phone two dropdowns in the filter
 * bar left no room for anything else. Either half only appears when there is a
 * choice in it: the topics when the model has been describing, the people when
 * more than one person is sending.
 */
export default function FilterMenu({
  category,
  categories,
  onCategory,
  sender,
  people,
  onSender,
  className = "",
}: {
  category: string;
  /** Topic and how many posts carry it, in the order to show. */
  categories: [string, number | null][];
  onCategory: (value: string) => void;
  sender: string;
  people: Person[];
  onSender: (value: string) => void;
  className?: string;
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

  const showTopics = categories.length > 0;
  const showPeople = people.length > 1;
  const anyCategory = category === "all";
  const anySender = sender === "all";
  const who = people.find((person) => person.username === sender);
  const total = categories.reduce((sum, [, count]) => sum + (count ?? 0), 0);

  return (
    <div ref={root} className={`relative ${className}`}>
      {/* One width, whatever is chosen. The label used to be whatever you had
          picked, so the whole filter bar shifted as you used it - and on a
          phone a person's handle pushed the row onto two lines. The word stays
          put and the marks carry the state. */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          anyCategory && anySender
            ? "Filter"
            : `Filter: ${[anyCategory ? null : category, anySender ? null : sender].filter(Boolean).join(", ")}`
        }
        onClick={() => setOpen((state) => !state)}
        className={`flex items-center gap-1.5 rounded-full py-1 text-[13px] transition-colors ${
          anyCategory && anySender ? "text-muted hover:text-ink" : "text-ink"
        }`}
      >
        <span className="flex w-[26px] shrink-0 items-center justify-center gap-1">
          {anyCategory && anySender && <FilterIcon className="opacity-70" />}
          {!anySender && who && <Face person={who} size={16} />}
          {!anyCategory && (
            <span aria-hidden style={hue(category)} className="dot h-2 w-2 shrink-0 rounded-full" />
          )}
        </span>
        <span>Filter</span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          aria-hidden
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 z-30 mt-2 max-h-[min(65vh,28rem)] w-60 overflow-y-auto rounded-xl bg-surface py-1.5 shadow-[0_12px_32px_-10px_rgba(0,0,0,0.35)] ring-1 ring-line"
        >
          {showPeople && (
            <>
              <Heading>Who sent it</Heading>
              <Row selected={anySender} onPick={() => onSender("all")}>
                <Blank />
                <span className="flex-1 truncate">Anyone</span>
              </Row>
              {people.map((person) => (
                <Row
                  key={person.username}
                  selected={person.username === sender}
                  onPick={() => onSender(person.username)}
                >
                  <Face person={person} size={18} />
                  <span className="flex-1 truncate">{person.username}</span>
                  <Count value={person.count} />
                </Row>
              ))}
            </>
          )}

          {showPeople && showTopics && <li aria-hidden className="mx-3 my-1.5 block border-t border-line" />}

          {showTopics && (
            <>
              {showPeople && <Heading>Kind of post</Heading>}
              <Row selected={anyCategory} onPick={() => onCategory("all")}>
                <Blank />
                <span className="flex-1 truncate">Any kind</span>
                <Count value={total} />
              </Row>
              {categories.map(([name, count]) => (
                <Row key={name} selected={name === category} onPick={() => onCategory(name)}>
                  <span aria-hidden style={hue(name)} className="dot h-2 w-2 shrink-0 rounded-full" />
                  <span className="flex-1 truncate">{name}</span>
                  {count !== null && <Count value={count} />}
                </Row>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </p>
  );
}

function Row({
  selected,
  onPick,
  children,
}: {
  selected: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-sunk ${
        selected ? "font-medium text-ink" : "text-ink-soft"
      }`}
    >
      {children}
    </button>
  );
}

const Blank = () => <span aria-hidden className="h-2 w-2 shrink-0" />;
const Count = ({ value }: { value: number }) => (
  <span className="shrink-0 tabular-nums text-[12px] text-muted">{value}</span>
);

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
      className="flex shrink-0 items-center justify-center rounded-full bg-sunk text-[9px] font-medium text-muted"
    >
      {person.username ? person.username[0]!.toUpperCase() : "?"}
    </span>
  );
}

function hue(name: string): React.CSSProperties {
  return { ["--hue" as string]: isCategory(name) ? CATEGORY_HUE[name] : 220 };
}
