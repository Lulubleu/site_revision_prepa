
# ---- Dépendances (modules natifs better-sqlite3 / argon2) -------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 et argon2 embarquent des binaires précompilés (amd64/arm64, glibc/musl) :
# on évite toute compilation, puis on vérifie qu'ils se chargent. Sur une autre
# architecture, on installe la chaîne de compilation et on recompile.
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild argon2 \
 && (node -e "require('better-sqlite3')(':memory:'); require('argon2')" \
     || (apt-get update \
         && apt-get install -y --no-install-recommends python3 make g++ \
         && rm -rf /var/lib/apt/lists/* \
         && npm rebuild --build-from-source better-sqlite3 argon2)) \
 && npm cache clean --force

# ---- Image finale ------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Données persistantes (base SQLite + fichiers) ; l'application tourne sans privilèges.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
