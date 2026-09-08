# syntax=docker/dockerfile:1

# Playwright's own image: Chromium needs system libraries Alpine does not have,
# and this tag must track the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
# Pulls the SDK's linux-x64 CLI package along with everything else; nothing
# needs installing globally for the agent to run.
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000 \
    HOME=/home/pwuser

# A plain build served by `next start`, the same way the host service ran it.
# Runs as the image's `pwuser`. Nothing from the host's ~/.claude is mounted in
# any more: the analysis agent authenticates with CLAUDE_CODE_OAUTH_TOKEN from
# the environment, which sidesteps both the uid-1001 requirement that mount
# carried and handing the container every other credential in that directory.
COPY --from=builder --chown=pwuser:pwuser /app/public ./public
COPY --from=builder --chown=pwuser:pwuser /app/.next ./.next
COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/drizzle ./drizzle
COPY --from=builder --chown=pwuser:pwuser /app/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /app/next.config.ts ./next.config.ts

# Pre-trust the working directories. Claude Code keeps this in ~/.claude.json
# in the container's own home, which is not persisted, so every fresh container
# would otherwise start untrusted.
RUN printf '{"projects":{"/app":{"hasTrustDialogAccepted":true},"/app/data/media":{"hasTrustDialogAccepted":true}}}\n' \
      > /home/pwuser/.claude.json \
 && chown pwuser:pwuser /home/pwuser/.claude.json \
 && mkdir -p /app/data && chown -R pwuser:pwuser /app/data

USER pwuser
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
