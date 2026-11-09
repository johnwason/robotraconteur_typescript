#!/bin/sh
# Run a command in the development container with this repository mounted at /app.
# node_modules comes from the image through an anonymous volume.
cd "$(dirname "$0")/.." || exit 1
exec podman run --rm \
    -v "$PWD:/app:Z" -v /app/node_modules -w /app rr-ts-dev "$@"
