# DVhub-Relay für die Handy-App — selbst hostbar.
# Bauen aus dem Repo-Wurzelordner (der Relay-Code liegt bei DVhub, damit Box
# und Relay nie auseinanderlaufen):
#   docker build -f relay/Dockerfile -t dvhub-relay .
ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}
WORKDIR /app
COPY relay/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dvhub/services/mobile-link/crypto.js dvhub/services/mobile-link/relay-core.js dvhub/services/mobile-link/relay-server.js ./
USER node
ENV RELAY_PORT=8787 RELAY_HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "relay-server.js"]
