FROM node:24-bookworm-slim AS app
WORKDIR /build
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY apps/runner/package.json ./apps/runner/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/hosting/package.json ./packages/hosting/package.json
RUN pnpm install --filter @heybox/runner... --frozen-lockfile --ignore-scripts
COPY src ./src
COPY packages/contracts/src ./packages/contracts/src
COPY packages/hosting/src ./packages/hosting/src
COPY apps/runner/src ./apps/runner/src
RUN pnpm build && CI=true pnpm install --filter @heybox/runner... --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV TZ=Asia/Shanghai NODE_ENV=production
ENTRYPOINT ["flock", "-n", "/app/state/run.lock", "node", "dist/cli.js"]
CMD ["check"]

FROM base AS runtime
COPY package.json ./
COPY --from=app /build/dist ./dist
COPY third-party/*-LICENSE ./third-party/
COPY LICENSE NOTICE.md ./
FROM base AS login
COPY --from=runtime /app /app
COPY --from=app /build/node_modules ./node_modules
CMD ["login"]

FROM login AS runner
COPY --from=app /build/apps/runner ./apps/runner
COPY --from=app /build/packages/contracts ./packages/contracts
COPY --from=app /build/packages/hosting ./packages/hosting
ENV HOST=0.0.0.0 PORT=8788
ENTRYPOINT ["node", "apps/runner/src/main.ts"]
CMD []

FROM runner AS preview-runner
ENTRYPOINT ["node", "apps/runner/src/preview-main.ts"]

FROM runner AS token-service
ENV PORT=8789
ENTRYPOINT ["node", "apps/runner/src/token-main.ts"]
