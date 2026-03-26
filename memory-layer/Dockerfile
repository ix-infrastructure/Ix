# syntax=docker/dockerfile:1.7

FROM eclipse-temurin:17-jdk-jammy AS builder

ARG SBT_VERSION=1.10.7

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    tar \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/sbt/sbt/releases/download/v${SBT_VERSION}/sbt-${SBT_VERSION}.tgz" \
  | tar -xz -C /opt \
  && ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt

WORKDIR /src

COPY build.sbt ./build.sbt
COPY project ./project

RUN --mount=type=cache,target=/root/.cache/coursier \
    --mount=type=cache,target=/root/.ivy2 \
    sbt update

COPY memory-layer ./memory-layer

RUN --mount=type=cache,target=/root/.cache/coursier \
    --mount=type=cache,target=/root/.ivy2 \
    sbt "memoryLayer/assembly"

FROM eclipse-temurin:17-jre-jammy

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/memory-layer/target/scala-2.13/ix-memory-layer.jar app.jar

EXPOSE 8090

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8090/v1/health || exit 1

RUN addgroup --gid 1000 ix \
  && adduser --uid 1000 --gid 1000 --disabled-password --gecos "" ix \
  && chown ix:ix app.jar

USER ix

CMD ["java", "-jar", "app.jar"]
