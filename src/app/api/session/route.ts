import { NextResponse } from "next/server";
import { getSessionStatus } from "@/lib/instagram/client";

export const dynamic = "force-dynamic";

/** Whether the Instagram API answers, and as whom. Local; no Instagram request. */
export async function GET() {
  return NextResponse.json(await getSessionStatus());
}
