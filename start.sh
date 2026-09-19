#!/bin/sh
# Container entrypoint: runs TrueForge and the MCP server bound to localhost
# only (never exposed publicly - only the backend's $PORT is), waits for
# both to be healthy, registers the agents, then starts the backend in the
# foreground so its stdout becomes the container's logs.
set -e

trueforge > /tmp/trueforge.log 2>&1 &
node src/evidence-mcp-server.mjs > /tmp/mcp.log 2>&1 &

wait_for() {
  name=$1
  url=$2
  i=0
  until curl -sf "$url" > /dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "$name did not become healthy in time" >&2
      exit 1
    fi
    sleep 1
  done
  echo "$name is up"
}

# "localhost", not "127.0.0.1" - TrueForge binds only to the IPv6 loopback
# (::1) in this image, so an explicit IPv4 address never connects.
wait_for "TrueForge" "http://localhost:8790/"
wait_for "MCP server" "http://localhost:8793/health"

node src/setup-trueforge.mjs

exec node src/backend.mjs
