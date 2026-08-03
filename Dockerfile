# Hosted remote MCP service (Streamable HTTP) — served behind a reverse proxy at hashlock.markets/mcp.
# The npm package (stdio) is unaffected; this image runs the `hashlock-mcp-http` entry only.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# HASHLOCK_V1_URL (developer API base) and PORT are read at runtime; testnets only for now.
ENV HASHLOCK_V1_URL=https://api.hashlock.markets/v1 \
    PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
USER node
CMD ["node", "dist/http/index.js"]
