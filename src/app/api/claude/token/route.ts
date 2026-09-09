import { NextRequest, NextResponse } from "next/server";
import { claudeAuth } from "@/lib/claude-auth";
import { clearToken, hasTokenFile, setToken } from "@/lib/claude-token";

export const dynamic = "force-dynamic";

/**
 * Whether a credential is present, and where it came from. Never the token
 * itself: nothing needs to read it back, and an endpoint that hands out a
 * credential is one request away from being the way it leaks.
 */
export async function GET() {
  return NextResponse.json({ ...claudeAuth(), stored: hasTokenFile() });
}

export async function POST(request: NextRequest) {
  const { token } = (await request.json()) as { token?: string };
  const outcome = setToken(token ?? "");
  if (!outcome.ok) {
    // `ok` on the way out is always claudeAuth's - whether the app can
    // describe anything - never whether this particular write succeeded.
    return NextResponse.json(
      { saved: false, message: outcome.message, ...claudeAuth(), stored: hasTokenFile() },
      { status: 400 },
    );
  }
  return NextResponse.json({ saved: true, ...claudeAuth(), stored: hasTokenFile() });
}

export async function DELETE() {
  clearToken();
  return NextResponse.json({ saved: true, ...claudeAuth(), stored: hasTokenFile() });
}
