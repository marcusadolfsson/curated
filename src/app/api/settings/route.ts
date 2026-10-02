import { NextRequest, NextResponse } from "next/server";
import { DEFAULTS, getSettings, setSettings, type SettingKey } from "@/lib/settings";
import { claudeAuth } from "@/lib/claude-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...(await getSettings()), claudeAuth: claudeAuth() });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as Record<string, unknown>;

  const updates: Partial<Record<SettingKey, string>> = {};
  for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
    if (key in body && body[key] !== undefined && body[key] !== null) {
      updates[key] = String(body[key]);
    }
  }

  await setSettings(updates);
  return NextResponse.json({ ...(await getSettings()), claudeAuth: claudeAuth() });
}
