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
ENV NODE_ENV=production
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
