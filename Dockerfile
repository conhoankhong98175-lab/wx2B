FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run check

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DIANGAO_MODE=server \
    HOST=0.0.0.0 \
    PORT=3100 \
    DB_PATH=/data/diangao.db \
    WEB_ROOT=/app/dist/web \
    PDF_FONT_PATH=/app/assets/fonts/NotoSansCJKsc-Regular.otf
WORKDIR /app
RUN groupadd --system diangao && useradd --system --gid diangao --home /app diangao \
    && mkdir -p /data && chown -R diangao:diangao /data /app
COPY --from=build --chown=diangao:diangao /app/dist ./dist
COPY --from=build --chown=diangao:diangao /app/assets/fonts ./assets/fonts
COPY --from=build --chown=diangao:diangao /app/scripts/backup.mjs /app/scripts/restore.mjs ./scripts/
COPY --from=build --chown=diangao:diangao /app/package.json ./package.json
COPY --from=build --chown=diangao:diangao /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
USER diangao
EXPOSE 3100
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.mjs"]
