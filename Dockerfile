FROM node:22-slim

WORKDIR /app

# psmisc provides `fuser`, used to clear a stale resolver port on restart.
RUN apt-get update \
 && apt-get install -y --no-install-recommends psmisc ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN cd resolver && npm install --no-audit --no-fund
RUN npm run build

ENV PORT=7000 \
    NODE_ENV=production \
    UV_THREADPOOL_SIZE=16 \
    MALLOC_ARENA_MAX=2 \
    NODE_COMPILE_CACHE=/app/data/.node-compile-cache
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so SIGTERM reaches node directly (graceful drain).
CMD ["node", "dist/index.js"]
