import { NextResponse } from "next/server";
import { getSessionStatus, logout } from "@/lib/instagram/client";

export const dynamic = "force-dynamic";

export async function GET() {
  // Cached for a few minutes inside getSessionStatus: a page load should not
  // put authentication traffic on Instagram every single time.
  return NextResponse.json(await getSessionStatus());
}

export async function DELETE() {
  await logout();
  return NextResponse.json({ connected: false });
}
