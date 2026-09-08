import { NextResponse } from "next/server";
import { pauseAutomation, pauseState, resumeAutomation } from "@/lib/pause";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await pauseState());
}

/** Stop the automation by hand - useful if Instagram is unhappy for any reason. */
export async function POST() {
  await pauseAutomation("Paused by you.", 24);
  return NextResponse.json(await pauseState());
}

export async function DELETE() {
  await resumeAutomation();
  return NextResponse.json(await pauseState());
}
