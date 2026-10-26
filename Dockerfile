FROM maven:3.9.9-eclipse-temurin-17 AS signer
WORKDIR /build
COPY signer/pom.xml ./pom.xml
COPY signer/src ./src
RUN mvn -B -q package dependency:copy-dependencies -DincludeScope=runtime

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY src ./src
COPY third-party ./third-party
COPY LICENSE NOTICE.md ./
COPY --from=signer /build/target/classes ./signer/target/classes
COPY --from=signer /build/target/dependency ./signer/target/dependency
ENV TZ=Asia/Shanghai NODE_ENV=production
ENTRYPOINT ["flock", "-n", "/app/state/run.lock", "node", "src/cli.js"]
CMD ["check"]
