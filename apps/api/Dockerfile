# syntax=docker/dockerfile:1.7
# =============================================================================
# Image de l'API Cura — build multi-étapes (contexte : racine du monorepo)
#   docker build -f apps/api/Dockerfile -t cura-api .
# Image finale : Node + dépendances de production + JS compilé, utilisateur non-root.
# =============================================================================
ARG NODE_VERSION=22.12-alpine

# --- base : pnpm via corepack ---------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# --- deps : couche mise en cache tant que les manifestes ne changent pas ------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @cura/api...

# --- build : typecheck + bundle + dépendances de prod isolées -----------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cura/api typecheck \
 && pnpm --filter @cura/api build \
 && pnpm --filter @cura/api deploy --prod /out

# --- runtime -------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations \
    NODE_OPTIONS=--enable-source-maps
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --chown=node:node packages/db/migrations ./migrations

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1

# tini : PID 1 correct (signaux SIGTERM transmis → arrêt propre, pas de zombies).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
