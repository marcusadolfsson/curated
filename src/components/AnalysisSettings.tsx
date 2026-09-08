"use client";

import { useEffect, useState } from "react";

type ClaudeAuth = {
  ok: boolean;
  source: "token" | "api-key" | "login" | "none";
  detail: string;
};

type Settings = {
  claudeAuth?: ClaudeAuth;
  analysisModel: string;
  analysisEffort: string;
  analysisInstructions: string;
  inboxLimit: string;
  historyDays: string;
  headless: string;
  autoAnalyze: string;
  proxyServer: string;
  proxyUsername: string;
  proxyPassword: string;
  realtime: string;
  autoReact: string;
  reactionEmoji: string;
};

const MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 - cheapest" },
  { id: "claude-sonnet-5", label: "Sonnet 5 - balanced" },
  { id: "claude-opus-5", label: "Opus 5 - most careful" },
];

export default function AnalysisSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [egress, setEgress] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const checkEgress = async () => {
    setChecking(true);
    setEgress(null);
    try {
      const response = await fetch("/api/session/egress", { method: "POST" });
      const body = (await response.json()) as { ip?: string; via?: string; error?: string };
      setEgress(
        body.error
          ? `Could not check: ${body.error}`
          : `Instagram sees ${body.ip}${body.via ? `, via ${body.via}` : ", straight from this server"}.`,
      );
    } catch (error) {
      setEgress(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings);
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (response.ok) {
      setSettings((await response.json()) as Settings);
      setSaved(true);
    }
    setBusy(false);
  };

  if (!settings) {
    return (
      <section className="py-8">
        <h2 className="font-serif text-2xl">Describing the posts</h2>
        <p className="mt-5 text-[14px] text-muted">Loading settings</p>
      </section>
    );
  }

  return (
    <section className="py-8">
      <h2 className="font-serif text-2xl">Describing the posts</h2>
      <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
        Each post goes to Claude, which looks at the picture and the caption and writes the summary
        you see in the feed. It runs through Claude Code on this machine, so there is no API key to
        set.
      </p>

      {settings.claudeAuth && (
        <p
          className={`mt-3 max-w-[58ch] border-l-2 pl-3 text-[13px] ${
            settings.claudeAuth.ok ? "border-line text-muted" : "border-danger text-danger"
          }`}
        >
          {settings.claudeAuth.detail}
        </p>
      )}

      <div className="mt-5 max-w-md space-y-5">
        <label className="block">
          <span className="text-[13px] text-muted">Model</span>
          <select
            value={settings.analysisModel}
            onChange={(event) => update({ analysisModel: event.target.value })}
            className="w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[13px] text-muted">How hard it thinks</span>
          <select
            value={settings.analysisEffort}
            onChange={(event) => update({ analysisEffort: event.target.value })}
            className="w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
          >
            {["low", "medium", "high"].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[13px] text-muted">Extra instructions (optional)</span>
          <textarea
            value={settings.analysisInstructions}
            onChange={(event) => update({ analysisInstructions: event.target.value })}
            rows={3}
            placeholder="For example: note whether a recipe is vegetarian."
            className="w-full resize-y border-b border-line bg-transparent py-1.5 text-[15px] placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-[13px] text-muted">Conversations per check</span>
            <input
              type="number"
              min={1}
              max={100}
              value={settings.inboxLimit}
              onChange={(event) => update({ inboxLimit: event.target.value })}
              className="w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted">History for a new conversation</span>
            <select
              value={settings.historyDays}
              onChange={(event) => update({ historyDays: event.target.value })}
              className="w-full cursor-pointer border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
            >
              <option value="2">The last two days</option>
              <option value="7">The last week</option>
              <option value="30">The last month</option>
              <option value="90">The last three months</option>
              <option value="365">The last year</option>
            </select>
          </label>
        </div>
        <p className="max-w-[58ch] text-[13px] text-muted">
          Only for a conversation being read for the first time. After that a check
          reads back to wherever the last one finished, however long ago that was, so
          a machine that was asleep or offline catches up on everything it missed.
          Each post found is described by Claude, so a long history costs real money
          the first time.
        </p>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.realtime === "true"}
            onChange={(event) => update({ realtime: String(event.target.checked) })}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="text-[14px]">
            Listen for new messages and sync right away
            <span className="block text-[12px] text-muted">
              Keeps a browser open on your inbox. The hourly check still runs as a fallback.
            </span>
          </span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.autoAnalyze === "true"}
            onChange={(event) => update({ autoAnalyze: String(event.target.checked) })}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="text-[14px]">Describe new posts as soon as they arrive</span>
        </label>

        <div className="border-t border-line pt-5">
          <h3 className="font-serif text-xl">Where the traffic comes from</h3>
          <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
            Instagram treats this server&apos;s address as suspect. Sending its traffic through a
            proxy at home makes it come from the same place you signed in from.
          </p>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-[13px] text-muted">Proxy (blank = straight from this server)</span>
              <input
                value={settings.proxyServer}
                onChange={(event) => update({ proxyServer: event.target.value })}
                placeholder="socks5://192.168.1.10:1080"
                className="w-full border-b border-line bg-transparent py-1.5 text-[15px] placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="text-[13px] text-muted">Username</span>
                <input
                  value={settings.proxyUsername}
                  onChange={(event) => update({ proxyUsername: event.target.value })}
                  className="w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-[13px] text-muted">Password</span>
                <input
                  type="password"
                  value={settings.proxyPassword}
                  onChange={(event) => update({ proxyPassword: event.target.value })}
                  className="w-full border-b border-line bg-transparent py-1.5 text-[15px] focus:border-accent focus:outline-none"
                />
              </label>
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={checkEgress}
                disabled={checking}
                className="text-[13px] text-accent underline-offset-4 hover:underline disabled:opacity-50"
              >
                {checking ? "Checking" : "Save first, then check the address"}
              </button>
            </div>
            {egress && <p className="text-[13px] text-muted">{egress}</p>}
            {settings.proxyServer.startsWith("socks") && settings.proxyUsername && (
              <p className="border-l-2 border-danger pl-3 text-[13px] text-danger">
                Chromium cannot authenticate to a SOCKS proxy - it ignores the username and
                password, and sign-in will fail. Use an http:// proxy for an authenticated one, or
                drop the credentials and let the tailnet be the boundary.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-line pt-5">
          <h3 className="font-serif text-xl">Reacting</h3>
          <p className="mt-1 max-w-[58ch] text-[14px] text-muted">
            Once a post has been described, the app can react to it in the DM thread, using the emoji
            Claude picked for that post rather than the same one every time.
          </p>

          <label className="mt-4 flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.autoReact === "true"}
              onChange={(event) => update({ autoReact: String(event.target.checked) })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            <span className="text-[14px]">React to new posts automatically</span>
          </label>
          <p className="mt-2 max-w-[58ch] text-[13px] text-muted">
            Only posts that arrived in the sync that found them, and only if they are less than a day
            old. Each reaction goes out on its own, one to fifteen minutes after the last, during the
            day. Nothing older is ever caught up on.
          </p>
        </div>

        <div className="flex items-center gap-4 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-sm bg-accent px-3.5 py-2 text-[14px] text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Saving" : "Save changes"}
          </button>
          {saved && <span className="text-[13px] text-muted">Saved</span>}
        </div>
      </div>
    </section>
  );
}
