# WSD-Pro main container
# Dashboard (3000) + shared code-server IDE (8100) + opencode CLI + qwen3:30b chat (Ollama Cloud).

# ---- Stage 1: build frontend ----
FROM node:22-bookworm AS frontend-build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY frontend ./
RUN npm run build

# ---- Stage 2: build backend ----
FROM node:22-bookworm AS backend-build
WORKDIR /src
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY backend ./
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-bookworm

# Docker CLI (to manage project containers through the mounted socket)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git docker.io \
    && rm -rf /var/lib/apt/lists/*

# code-server — unified Web IDE rooted at /workspaces
ARG CODE_SERVER_VERSION=4.96.4
RUN curl -fsSLo /tmp/code-server.deb \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
    && dpkg -i /tmp/code-server.deb \
    && rm -f /tmp/code-server.deb

# opencode CLI (project building agent)
RUN npm install -g opencode-ai --no-fund --no-audit

WORKDIR /app

# App
COPY --from=backend-build /src/package*.json ./backend/
COPY --from=backend-build /src/dist ./backend/dist
RUN cd backend && npm install --omit=dev --no-fund --no-audit

# Frontend (served statically by the backend)
COPY --from=frontend-build /src/dist ./frontend/dist

# opencode configuration
COPY opencode.json /root/.config/opencode/opencode.json

# Entrypoint
COPY backend/docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000 8100

CMD ["/app/entrypoint.sh"]
