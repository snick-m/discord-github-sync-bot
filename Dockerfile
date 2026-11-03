FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@8.6.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm typecheck && pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=5000 DATA_DIR=/app/data
RUN npm install -g pnpm@8.6.3 && addgroup -S botuser && adduser -S botuser -G botuser
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown botuser:botuser /app/data
USER botuser
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + "/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "dist/index.js"]
