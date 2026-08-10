# One binary. No interpreter, no venv, no second process.
#
# The Python backend and the standalone host runner are both gone: `specter
# serve` answers every endpoint and spawns agents itself. What ships is a static
# binary and the built web UI.

FROM node:22-bookworm AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM golang:1.26-bookworm AS backend
WORKDIR /src
# Modules first, so a source-only change does not re-download them.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 gives a static binary, which is what lets the runtime stage be
# alpine rather than debian — 60MB instead of 294MB. It works because
# modernc.org/sqlite is pure Go, which is exactly why that driver was chosen
# over mattn/go-sqlite3.
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags="-s -w -X github.com/navjyotnishant/specter-agent/internal/api.Version=docker" \
      -o /out/specter ./cmd/specter

FROM alpine:3.21
WORKDIR /app

# Needed at RUNTIME, not build time:
#   git              runs clone repositories and commit their work
#   ca-certificates  every outbound HTTPS call, including the agent APIs
#   openssh-client   git over ssh, for a remote that is not https
RUN apk add --no-cache git ca-certificates openssh-client

COPY --from=backend /out/specter /usr/local/bin/specter
COPY --from=frontend /app/dist /app/frontend

RUN mkdir -p /app/data /app/artifacts /app/secrets /app/codebases

ENV SPECTER_FRONTEND_DIR=/app/frontend
EXPOSE 8000

# 0.0.0.0, because the container's own loopback is not reachable from the host.
CMD ["specter", "serve", "--addr", "0.0.0.0:8000", "--db", "/app/data/app.db", "--frontend", "/app/frontend"]
