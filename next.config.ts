import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Traced, so the app can be carried somewhere that has no npm.
   *
   * This used to say `next start` was the one supported path and a smaller
   * build was not worth a second one. That held while the app lived in a
   * checkout. Packaging it means shipping node_modules, and the difference is
   * not small: 838 MB installed against 94 MB traced, because the trace leaves
   * behind the Postgres drivers drizzle lists as optional peers and the swc
   * binary that only ever compiled the thing.
   *
   * Two consequences. The server is `node server.js`, not `next start`. And
   * the trace does not follow the Agent SDK's platform binary, which is an
   * optional dependency resolved at runtime - so scripts/bundle.sh copies it
   * in by hand, and analysis is broken without it.
   */
  output: "standalone",

  /**
   * Everything the app writes lives under ./data by default, inside the
   * project. The tracer walks from the project root, found Chromium's profile
   * in there and tried to copy a cache file with a colon in its name. None of
   * it is input to the server, and the built bundle must never carry a session
   * or a database into wherever it is installed.
   */
  outputFileTracingExcludes: {
    "**/*": [
      "./data/**",
      "./dist/**",
      "./docs/**",
      "./menubar/**",
      "./.git/**",
      "./.claude/**",
    ],
  },

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
