FROM maven:3.9.9-eclipse-temurin-17 AS signer
WORKDIR /build
COPY signer/pom.xml ./pom.xml
COPY signer/src ./src
RUN mvn -B -q package dependency:copy-dependencies -DincludeScope=runtime

FROM node:24-bookworm-slim AS app
WORKDIR /build
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/runner/package.json ./apps/runner/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN pnpm install --filter @heybox/runner... --frozen-lockfile --ignore-scripts
COPY src ./src
COPY packages/contracts/src ./packages/contracts/src
COPY apps/runner/src ./apps/runner/src
RUN pnpm build && CI=true pnpm install --filter @heybox/runner... --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV TZ=Asia/Shanghai NODE_ENV=production
ENTRYPOINT ["flock", "-n", "/app/state/run.lock", "node", "dist/cli.js"]
CMD ["check"]

FROM base AS runtime
COPY package.json ./
COPY --from=app /build/dist ./dist
COPY third-party ./third-party
COPY LICENSE NOTICE.md ./
COPY --from=signer /build/target/classes ./signer/target/classes
COPY --from=signer /build/target/dependency ./signer/target/dependency
FROM base AS login
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=runtime /app /app
COPY --from=app /build/node_modules ./node_modules
ENV CHROMIUM_PATH=/usr/bin/chromium XDG_CONFIG_HOME=/tmp/chromium-config XDG_CACHE_HOME=/tmp/chromium-cache
CMD ["login"]

FROM login AS runner
COPY --from=app /build/apps/runner ./apps/runner
COPY --from=app /build/packages/contracts ./packages/contracts
ENV HOST=0.0.0.0 PORT=8788
ENTRYPOINT ["node", "apps/runner/src/main.ts"]
CMD []
