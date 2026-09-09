import { NextResponse } from "next/server";
import { beginSignIn, cancelSignIn, getSignInState } from "@/lib/instagram/signin";

export const dynamic = "force-dynamic";
/**
 * The window stands open for as long as it takes somebody to type a password
 * and clear whatever Instagram puts in front of them, so POST returns as soon
 * as it is up and the page polls GET after that.
 */
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json(getSignInState());
}

export async function POST() {
  return NextResponse.json(await beginSignIn());
}

export async function DELETE() {
  return NextResponse.json(cancelSignIn());
}
