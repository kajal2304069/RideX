# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- dev: hot reload, used by docker-compose.dev.yml ----
FROM base AS dev
ENV NODE_ENV=development
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ---- build: compile TypeScript ----
FROM base AS build
ENV NODE_ENV=development
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- prod: only what runs ----
FROM base AS prod
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrations and seeds are plain JS run by scripts/migrate.js, not compiled
COPY src/db/migrations ./src/db/migrations
COPY src/db/seeds ./src/db/seeds
COPY scripts ./scripts
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
