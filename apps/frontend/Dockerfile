FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile=false

FROM base AS build
ARG VITE_API_URL=http://localhost:4000
ARG VITE_WS_URL=ws://localhost:4000/ws
ARG VITE_MAPBOX_TOKEN=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
COPY --from=deps /repo /repo
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/frontend apps/frontend
RUN pnpm --filter @smart-supply/frontend build

FROM nginx:1.27-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1
