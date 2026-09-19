# Detective Board — single-container demo deploy.
#
# Runs TrueForge, the evidence MCP server, and the Express backend together
# in one container via start.sh. TrueForge and the MCP server are bound to
# localhost only; only the backend's $PORT is exposed publicly. This mirrors
# how the three processes already talk to each other locally (see
# src/backend.mjs and src/setup-trueforge.mjs's default URLs), so no extra
# env vars are needed to wire them up.
#
# This is a temporary-demo deploy shape, not a hardened production one:
# TrueForge's own standalone mode has no built-in auth. Take the deployment
# down once the demo window is over.
FROM node:22-alpine

WORKDIR /app

# curl is needed by start.sh's health-check loop; alpine doesn't ship it.
RUN apk add --no-cache curl

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install -g @truefoundry/trueforge@latest

COPY src ./src
COPY web ./web
COPY data ./data
COPY start.sh ./start.sh

ENV NODE_ENV=production

# Render (and most free hosts) inject PORT; src/backend.mjs already reads
# process.env.PORT and falls back to 8788 for local runs.
EXPOSE 8788

CMD ["./start.sh"]
