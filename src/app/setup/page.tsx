"use client";

import Link from "next/link";
import ThreadPicker from "@/components/ThreadPicker";
import AnalysisSettings from "@/components/AnalysisSettings";
import SyncPanel from "@/components/SyncPanel";

/**
 * The settings that are worth a page: whose messages to read, and how they
 * get described. The Instagram account itself is on Muse's side, through the
 * API, and the Claude credential is in the menu bar.
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
