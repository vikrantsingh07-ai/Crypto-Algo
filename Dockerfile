# syntax=docker/dockerfile:1
# Always-on trading backend (API + worker). One instance only: the worker holds a database lease.

FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
# The web app is deployed separately on Vercel; stub its manifest so the workspace lockfile resolves.
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund
RUN npm run build -w @cryptoalgo/server
# Runtime manifest: only third-party dependencies (workspace packages are bundled into dist/)
RUN node -e "const p=require('./apps/server/package.json');for(const k of Object.keys(p.dependencies))if(k.startsWith('@cryptoalgo/'))delete p.dependencies[k];delete p.devDependencies;p.scripts={start:'node main.js'};require('fs').writeFileSync('apps/server/dist/package.json',JSON.stringify(p,null,2))"

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/migrations ./migrations
RUN cd dist && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
# non-root user; /data is only used by the embedded dev database (use DATABASE_URL in production)
RUN useradd -r -u 10001 app && mkdir -p /data && chown -R app /data /app
USER app
ENV DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
