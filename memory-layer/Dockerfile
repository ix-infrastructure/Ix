FROM eclipse-temurin:17-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY target/scala-2.13/ix-memory-layer.jar app.jar
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:8090/v1/health || exit 1
CMD ["java", "-jar", "app.jar"]
