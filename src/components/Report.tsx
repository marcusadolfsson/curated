"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ReportData = {
  grid: number[][];
  byWeekday: number[];
  byHour: number[];
  total: number;
  first: string | null;
  last: string | null;
  generatedAt: string;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Six steps of one hue. Magnitude, so lightness carries the value. */
const STEPS = 6;

export default function Report() {
  const [data, setData] = useState<ReportData | null>(null);
  const [hover, setHover] = useState<{ day: number; hour: number } | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const load = () =>
      void fetch("/api/report")
        .then((r) => (r.ok ? r.json() : null))
        .then((body: ReportData | null) => body && setData(body))
        .catch(() => undefined);

    load();
    // The feed keeps arriving; the report should not go stale while it is open.
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  const busiest = useMemo(() => {
    if (!data) return null;
    let best = { day: 0, hour: 0, n: -1 };
    data.grid.forEach((hours, day) =>
      hours.forEach((n, hour) => {
        if (n > best.n) best = { day, hour, n };
      }),
    );
    return best.n > 0 ? best : null;
  }, [data]);

  if (!data) {
    return <p className="py-16 text-center text-[14px] text-muted">Counting</p>;
  }

  const peakCell = Math.max(1, ...data.grid.flat());
  const peakDay = Math.max(1, ...data.byWeekday);
  const step = (n: number) => (n === 0 ? 0 : Math.max(1, Math.ceil((n / peakCell) * STEPS)));

  return (
    <div className="mx-auto max-w-4xl px-4 pb-24 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-10 pb-6">
        <div>
          <h1 className="font-serif text-4xl leading-none tracking-tight">Report</h1>
          <p className="mt-2 text-[14px] text-muted">
            {data.total} posts
            {data.first && data.last
              ? `, ${new Date(data.first).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} to ${new Date(data.last).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : ""}
            {busiest ? `. Most often ${DAYS[busiest.day]} around ${formatHour(busiest.hour)}.` : ""}
          </p>
        </div>
        <Link href="/" className="text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      <section className="border-t border-line py-8">
        <h2 className="font-serif text-2xl">By day of the week</h2>
        <div className="mt-5 space-y-2">
          {data.byWeekday.map((n, day) => (
            <div key={day} className="flex items-center gap-3">
              <span className="w-11 shrink-0 text-[13px] text-muted">{SHORT[day]}</span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <div
                  className="h-5 rounded-r-[4px]"
                  style={{
                    width: `${Math.max((n / peakDay) * 100, n > 0 ? 1.5 : 0)}%`,
                    background: "var(--heat-5)",
                  }}
                />
                {/* Labelled rather than left to colour: the light steps sit
                    under 3:1 against the page. */}
                <span className="shrink-0 text-[13px] tabular-nums text-ink-soft">{n}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-line py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-2xl">By hour of the week</h2>
          <button
            type="button"
            onClick={() => setAsTable((current) => !current)}
            className="text-[13px] text-accent underline-offset-4 hover:underline"
          >
            {asTable ? "Show the grid" : "Show as a table"}
          </button>
        </div>

        <p className="mt-1 text-[14px] text-muted">
          {hover
            ? `${DAYS[hover.day]} ${formatHour(hover.hour)} — ${data.grid[hover.day][hover.hour]} ${
                data.grid[hover.day][hover.hour] === 1 ? "post" : "posts"
              }`
            : "Darker means more. Hover a square for the count."}
        </p>

        {asTable ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-muted">
                  <th className="py-1 pr-2 text-left font-normal">Day</th>
                  {Array.from({ length: 24 }, (_, hour) => (
                    <th key={hour} className="px-1 py-1 text-right font-normal">
                      {hour}
                    </th>
                  ))}
                  <th className="pl-2 text-right font-normal">All</th>
                </tr>
              </thead>
              <tbody>
                {data.grid.map((hours, day) => (
                  <tr key={day} className="border-t border-line">
                    <td className="py-1 pr-2 text-muted">{SHORT[day]}</td>
                    {hours.map((n, hour) => (
                      <td key={hour} className={`px-1 py-1 text-right ${n === 0 ? "text-muted" : "text-ink"}`}>
                        {n || ""}
                      </td>
                    ))}
                    <td className="pl-2 text-right text-ink-soft">{data.byWeekday[day]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <div className="min-w-[620px]">
              <div className="flex gap-[2px] pl-12">
                {Array.from({ length: 24 }, (_, hour) => (
                  <div key={hour} className="flex-1 text-center text-[10px] text-muted">
                    {hour % 3 === 0 ? hour : ""}
                  </div>
                ))}
              </div>

              {data.grid.map((hours, day) => (
                <div key={day} className="mt-[2px] flex items-center gap-[2px]">
                  <span className="w-12 shrink-0 text-[12px] text-muted">{SHORT[day]}</span>
                  {hours.map((n, hour) => (
                    <button
                      key={hour}
                      type="button"
                      onMouseEnter={() => setHover({ day, hour })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ day, hour })}
                      onBlur={() => setHover(null)}
                      title={`${DAYS[day]} ${formatHour(hour)} — ${n} ${n === 1 ? "post" : "posts"}`}
                      aria-label={`${DAYS[day]} ${formatHour(hour)}, ${n} posts`}
                      className="h-6 flex-1 rounded-[2px] transition-transform hover:scale-[1.35]"
                      style={{ background: `var(--heat-${step(n)})` }}
                    />
                  ))}
                </div>
              ))}

              <div className="mt-4 flex items-center gap-2 pl-12 text-[12px] text-muted">
                <span>none</span>
                {Array.from({ length: STEPS + 1 }, (_, i) => (
                  <span
                    key={i}
                    className="h-3 w-6 rounded-[2px]"
                    style={{ background: `var(--heat-${i})` }}
                  />
                ))}
                <span>{peakCell} in an hour</span>
              </div>
            </div>
          </div>
        )}
      </section>

      <p className="border-t border-line pt-4 text-[13px] text-muted">
        Counted in your timezone, refreshed every minute. Last read{" "}
        {new Date(data.generatedAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}

function formatHour(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
