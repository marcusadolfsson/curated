import { NextResponse } from "next/server";
import { closeBrowser, egressAddress } from "@/lib/instagram/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Which address Instagram sees. Changing the proxy needs the browser restarted,
 * since the proxy is set when it launches.
 */
export async function POST() {
  await closeBrowser();
  return NextResponse.json(await egressAddress());
}
