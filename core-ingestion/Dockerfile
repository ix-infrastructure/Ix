FROM node:20-slim AS build

# tree-sitter native bindings require build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:20-slim

WORKDIR /app
COPY --from=build /build/dist      ./dist
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./

RUN addgroup --gid 1000 ix \
  && adduser --uid 1000 --gid 1000 --disabled-password --gecos "" ix \
  && chown -R ix:ix /app
USER ix

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
