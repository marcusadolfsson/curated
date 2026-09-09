"use client";

import Link from "next/link";
import ThreadPicker from "@/components/ThreadPicker";
import AnalysisSettings from "@/components/AnalysisSettings";
import SyncPanel from "@/components/SyncPanel";

/**
 * The settings that are worth a page.
 *
 * Signing in and out moved to the menu bar, where the sign-in window opens
 * anyway - it drives the Mac's own browser, so it was never a thing a phone
 * could do on its own. What is left here is the part you sit down and think
 * about: whose messages to read, and how they get described.
 */
export default function SetupPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
      <header className="flex items-end justify-between gap-4 pt-10 pb-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Setup</h1>
        <Link href="/" className="text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      <SyncPanel />
      <ThreadPicker />
      <AnalysisSettings />
    </div>
  );
}
