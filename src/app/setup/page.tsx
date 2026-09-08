"use client";

import { useState } from "react";
import Link from "next/link";
import SessionPanel from "@/components/SessionPanel";
import ThreadPicker from "@/components/ThreadPicker";
import AnalysisSettings from "@/components/AnalysisSettings";
import SyncPanel from "@/components/SyncPanel";

export default function SetupPage() {
  const [, setRefresh] = useState(0);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
      <header className="flex items-end justify-between gap-4 pt-10 pb-2">
        <h1 className="font-serif text-4xl leading-none tracking-tight">Setup</h1>
        <Link href="/" className="text-[14px] text-accent underline-offset-4 hover:underline">
          Back to Curated
        </Link>
      </header>

      <SessionPanel onChange={() => setRefresh((n) => n + 1)} />
      <SyncPanel />
      <ThreadPicker />
      <AnalysisSettings />
    </div>
  );
}
