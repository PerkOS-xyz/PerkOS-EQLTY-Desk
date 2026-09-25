FROM node:22-alpine

WORKDIR /app

# Dependencies first: the source changes far more often than they do.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget --spider -q http://127.0.0.1:8090/health || exit 1

CMD ["node", "--experimental-strip-types", "src/server.ts"]
