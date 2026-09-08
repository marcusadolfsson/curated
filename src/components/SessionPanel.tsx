"use client";

import { useEffect, useState } from "react";

type SessionStatus = {
  connected: boolean;
  username: string | null;
  verifiedAt: string | null;
  message?: string;
};

type LoginOutcome = {
  status: "ok" | "unverified" | "failed";
  username?: string | null;
  message?: string;
};

export default function SessionPanel({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const refresh = async () => {
    const response = await fetch("/api/session");
    if (response.ok) setStatus((await response.json()) as SessionStatus);
    onChange();
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/session/cookie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, userId }),
      });
      const outcome = (await response.json()) as LoginOutcome;

      if (outcome.status === "ok") {
        setSessionId("");
        setUserId("");
        setMessage({
          tone: "info",
          text: outcome.username ? `Signed in as ${outcome.username}.` : "Signed in.",
        });
      } else if (outcome.status === "unverified") {
        setMessage({ tone: "info", text: outcome.message ?? "Cookie saved; it will be checked on the next sync." });
      } else {
        setMessage({ tone: "error", text: outcome.message ?? "That did not work." });
      }

      await refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    await fetch("/api/session", { method: "DELETE" });
    setBusy(false);
    setMessage({ tone: "info", text: "Signed out. The saved session was deleted." });
    await refresh();
  };

  return (
    <section className="border-b border-line py-8">
      <h2 className="font-serif text-2xl">Instagram</h2>
      <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
        The app uses a session you have already signed in to elsewhere. It never sees your password,
        and it never touches Instagram&apos;s login page, which is the part that gets throttled and
        flagged.
      </p>

      {status?.connected ? (
        <div className="mt-5 flex flex-wrap items-center gap-4 text-[14px]">
          <span className="text-ink">
            Signed in{status.username ? ` as ${status.username}` : ""}
            {status.verifiedAt && (
              <span className="text-muted">
                {" "}
                · inbox last opened {new Date(status.verifiedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={signOut}
            disabled={busy}
            className="text-muted underline-offset-4 hover:text-danger hover:underline disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      ) : (
        <form
          className="mt-5 max-w-md space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {status?.message && (
            <p className="border-l-2 border-danger pl-3 text-[13px] text-danger">{status.message}</p>
          )}
          <div className="text-[13px] text-muted">
            <p>Sign in at instagram.com on your own machine, then:</p>
            <ol className="mt-2 list-inside list-decimal space-y-1">
              <li>Open developer tools and go to Application (or Storage)</li>
              <li>Under Cookies, pick https://www.instagram.com</li>
              <li>Copy the value of sessionid, and ds_user_id if you want it</li>
            </ol>
            <p className="mt-2">
              Keep that browser signed in - logging out there ends this session too.
            </p>
          </div>
          <Field label="sessionid">
            <input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field label="ds_user_id (optional)">
            <input
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <button type="submit" disabled={busy || !sessionId.trim()} className={buttonClass}>
            {busy ? "Opening the inbox" : "Use this session"}
          </button>
        </form>
      )}

      {message && (
        <p
          className={`mt-4 max-w-[58ch] border-l-2 pl-3 text-[13px] ${
            message.tone === "error" ? "border-danger text-danger" : "border-line text-muted"
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

const inputClass =
  "w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none";
const buttonClass =
  "rounded-sm bg-accent px-3.5 py-2 text-[14px] text-paper transition-opacity hover:opacity-90 disabled:opacity-40";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] text-muted">{label}</span>
      {children}
    </label>
  );
}
