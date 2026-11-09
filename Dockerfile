# Development and test image for robotraconteur_typescript.
# Rebuild whenever a dependency changes: podman build -t rr-ts-dev .
FROM docker.io/library/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_VERSION=22.12.0 \
    RR_CORE_VERSION=v1.2.9

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git xz-utils python3 python3-venv \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
        | tar -xJ --strip-components=1 -C /usr/local \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "robotraconteur==1.2.9" numpy pytest \
    && git clone --depth 1 --branch "${RR_CORE_VERSION}" \
        https://github.com/robotraconteur/robotraconteur.git /opt/rr-core

ENV PATH=/opt/venv/bin:$PATH \
    RR_CORE_TEST=/opt/rr-core/test

WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt /app/node_modules
