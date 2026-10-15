# Test double for the SHC Platform API, used by docker-compose.yml. Never deployed.
# Node >= 22.18 runs the TypeScript files directly, so there is no build step.
FROM node:22.23.3-alpine3.24
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.ts store.ts ./
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.ts"]
