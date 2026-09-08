import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No `output: "standalone"`. Next warns that it is not supported alongside
  // `next start`, which is how this runs both under systemd and in the
  // container - one supported path beats a smaller image.
  //
  // These load native binaries or spawn their own processes, so they must stay
  // outside the server bundle.
  serverExternalPackages: [
    "better-sqlite3",
    "playwright",
    "playwright-core",
    "@anthropic-ai/claude-agent-sdk",
    "sharp",
  ],
};

export default nextConfig;
