# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
# Identity the upstream sees. Resolved at publish time from the public updater manifest
# (scripts/client-identity.mjs); the values here are only the fallback for a local build.
ARG ANTIGRAVITY_CLIENT_VERSION=1.5.9
ARG ANTIGRAVITY_CLIENT_BUILD=1021519450
ENV NODE_ENV=production \
    ANTIGRAVITY_CLIENT_VERSION=$ANTIGRAVITY_CLIENT_VERSION \
    ANTIGRAVITY_CLIENT_BUILD=$ANTIGRAVITY_CLIENT_BUILD
LABEL dev.hmedeiros.antigravity.client-version=$ANTIGRAVITY_CLIENT_VERSION \
      dev.hmedeiros.antigravity.client-build=$ANTIGRAVITY_CLIENT_BUILD
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=3000 HOST=0.0.0.0 DB_PATH=/app/data/antigravity.db
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3000

# /health exige o Bearer como qualquer rota: sem o header o probe sempre 401 e o
# container leria unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health',{headers:{Authorization:'Bearer '+process.env.API_KEY}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/server.js"]
