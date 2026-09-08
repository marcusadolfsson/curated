import { NextResponse } from "next/server";
import { getWatcherState, startWatcher, stopWatcher } from "@/lib/watcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json(getWatcherState());
}

export async function POST() {
  return NextResponse.json(await startWatcher());
}

export async function DELETE() {
  return NextResponse.json(await stopWatcher());
}
