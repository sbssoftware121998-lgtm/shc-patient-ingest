# syntax=docker/dockerfile:1

# Exact Node.js LTS + Alpine release so builds are reproducible. Bump deliberately (and rebuild)
# to pick up security patches; see README for pinning by digest.
ARG NODE_IMAGE=node:22.23.3-alpine3.24

# ---- build: compile TypeScript ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only (no compiler, no type definitions) -------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="shc-patient-ingest" \
      org.opencontainers.image.description="Loads GlobalHealth Corp legacy patient data into the SHC Platform API" \
      org.opencontainers.image.version="1.0.0"

# Nothing is installed at runtime, so drop the package managers: a smaller attack surface and
# fewer findings in the client's image scans. Only /data/output is writable by the app user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /app/data/input /app/data/retry /data/output \
 && chown 1000:1000 /data/output

ENV NODE_ENV=production \
    SHC_OUTPUT_DIR=/data/output

WORKDIR /app
# Application files stay owned by root, so the app cannot modify itself.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The unprivileged "node" user from the base image, given numerically so Kubernetes'
# runAsNonRoot check can verify it. No secrets are baked in: the token comes from
# SHC_API_TOKEN or a mounted SHC_API_TOKEN_FILE at run time.
USER 1000:1000

# A run-to-completion job, so no HEALTHCHECK; the exit code reports the outcome (see README).
# The input is always /app/data/input/patients.csv: mount the export folder there (read-only).
# "failed" reads /app/data/retry/failed_records.json and removes the records that load from it:
# mount the folder holding the reviewed file there, writable by UID 1000.
# Arguments after the image name are passed to the job (see `--help`).
ENTRYPOINT ["node", "--enable-source-maps", "/app/dist/index.js"]
